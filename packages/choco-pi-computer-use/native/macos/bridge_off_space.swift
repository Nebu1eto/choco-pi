import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

final class OffSpaceSupport {
	typealias CreateTokenFn = @convention(c) (CFData) -> Unmanaged<AXUIElement>?
	typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
	typealias ConnectionFn = @convention(c) () -> Int32
	typealias CopyDisplaySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?
	typealias CopySpacesForWindowsFn = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?

	struct SpaceLayout {
		let current: Set<Int>
		let desktop: Set<Int>
	}

	static let measuredOSMajorVersions: [Int] = [27]
	static let shared = OffSpaceSupport()
	static let tokenIdLimit: UInt64 = 4096
	static let tokenScanBudget: Double = 0.5
	static let tokenMessagingTimeout: Float = 0.05
	static let allSpacesMask: Int32 = 7
	static let tokenMagic: Int32 = 0x636f636f

	let createToken: CreateTokenFn?
	let getWindow: GetWindowFn?
	let connection: ConnectionFn?
	let copyDisplaySpaces: CopyDisplaySpacesFn?
	let copySpacesForWindows: CopySpacesForWindowsFn?
	let osMajorVersion: Int
	let missingSymbols: [String]

	private init() {
		let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
		let everywhere = UnsafeMutableRawPointer(bitPattern: -2)
		var missing: [String] = []
		func symbol(_ name: String) -> UnsafeMutableRawPointer? {
			if let skyLight, let found = dlsym(skyLight, name) { return found }
			if let found = dlsym(everywhere, name) { return found }
			missing.append(name)
			return nil
		}
		createToken = symbol("_AXUIElementCreateWithRemoteToken").map { unsafeBitCast($0, to: CreateTokenFn.self) }
		getWindow = symbol("_AXUIElementGetWindow").map { unsafeBitCast($0, to: GetWindowFn.self) }
		connection = symbol("CGSMainConnectionID").map { unsafeBitCast($0, to: ConnectionFn.self) }
		copyDisplaySpaces = symbol("CGSCopyManagedDisplaySpaces").map { unsafeBitCast($0, to: CopyDisplaySpacesFn.self) }
		copySpacesForWindows = symbol("CGSCopySpacesForWindows").map { unsafeBitCast($0, to: CopySpacesForWindowsFn.self) }
		missingSymbols = missing
		osMajorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
	}

	var unavailableReason: String? {
		if !missingSymbols.isEmpty { return "missing_symbols" }
		if !Self.measuredOSMajorVersions.contains(osMajorVersion) { return "os_not_measured" }
		return nil
	}

	var available: Bool { unavailableReason == nil }

	var discoveryUnavailableReason: String? {
		if let unavailableReason { return unavailableReason }
		return ExtendedDeliverySupport.shared.unavailableReason.map { "extended_delivery_\($0)" }
	}

	func diagnostics() -> [String: Any] {
		var output: [String: Any] = [
			"available": available,
			"discoveryAvailable": discoveryUnavailableReason == nil,
			"osMajorVersion": osMajorVersion,
			"measuredOSMajorVersions": Self.measuredOSMajorVersions,
			"missingSymbols": missingSymbols,
			"tokenIdLimit": Int(Self.tokenIdLimit),
			"tokenScanBudgetMs": Int(Self.tokenScanBudget * 1000),
		]
		if let unavailableReason { output["reason"] = unavailableReason }
		if let discovery = discoveryUnavailableReason { output["discoveryReason"] = discovery }
		return output
	}

	func windowId(of element: AXUIElement) -> CGWindowID? {
		guard available, let getWindow else { return nil }
		var id: CGWindowID = 0
		return getWindow(element, &id) == .success && id != 0 ? id : nil
	}

	func spaceLayout() -> SpaceLayout? {
		guard available, let connection, let copyDisplaySpaces else { return nil }
		let displays = (copyDisplaySpaces(connection())?.takeRetainedValue() as? [[String: Any]]) ?? []
		var current = Set<Int>()
		var desktop = Set<Int>()
		for display in displays {
			if let id = (display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int { current.insert(id) }
			for space in (display["Spaces"] as? [[String: Any]]) ?? [] {
				if let id = space["ManagedSpaceID"] as? Int, (space["type"] as? Int) == 0 { desktop.insert(id) }
			}
		}
		return current.isEmpty ? nil : SpaceLayout(current: current, desktop: desktop)
	}

	func spaces(ofWindow windowId: UInt32) -> [Int] {
		guard available, let connection, let copySpacesForWindows else { return [] }
		let ids = [NSNumber(value: windowId)] as CFArray
		return (copySpacesForWindows(connection(), Self.allSpacesMask, ids)?.takeRetainedValue() as? [Int]) ?? []
	}

	func isOffSpace(_ windowId: UInt32, layout suppliedLayout: SpaceLayout? = nil) -> Bool {
		guard windowId != 0, available, let layout = suppliedLayout ?? spaceLayout() else { return false }
		let spaces = Set(spaces(ofWindow: windowId))
		return !spaces.isEmpty && spaces.isDisjoint(with: layout.current) && spaces.isSubset(of: layout.desktop)
	}

	func tokenWindows(pid: Int32, wanted: Set<UInt32>, deadline: Double) -> (found: [UInt32: AXUIElement], scanned: UInt64, complete: Bool) {
		guard available, let createToken, !wanted.isEmpty else { return ([:], 0, false) }
		var found: [UInt32: AXUIElement] = [:]
		var id: UInt64 = 0
		while id < Self.tokenIdLimit {
			if found.count == wanted.count || monotonicSeconds() >= deadline { break }
			var data = Data(count: 20)
			data.withUnsafeMutableBytes { raw in
				raw.storeBytes(of: pid, toByteOffset: 0, as: Int32.self)
				raw.storeBytes(of: Int32(0), toByteOffset: 4, as: Int32.self)
				raw.storeBytes(of: Self.tokenMagic, toByteOffset: 8, as: Int32.self)
				raw.storeBytes(of: id, toByteOffset: 12, as: UInt64.self)
			}
			id += 1
			guard let element = createToken(data as CFData)?.takeRetainedValue() else { continue }
			AXUIElementSetMessagingTimeout(element, Self.tokenMessagingTimeout)
			var owner: pid_t = 0
			guard AXUIElementGetPid(element, &owner) == .success, owner == pid else { continue }
			var role: CFTypeRef?
			guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success, (role as? String) == "AXWindow",
				let windowId = windowId(of: element), wanted.contains(windowId), found[windowId] == nil
			else { continue }
			found[windowId] = element
		}
		return (found, id, id >= Self.tokenIdLimit)
	}
}

extension Bridge {
	private func verifiedOffSpaceElement(_ element: AXUIElement, pid: Int32, windowId: UInt32) -> Bool {
		pidForElement(element) == pid
			&& stringAttribute(element, attribute: kAXRoleAttribute as CFString) == "AXWindow"
			&& OffSpaceSupport.shared.windowId(of: element) == windowId
	}

	func cachedOffSpaceWindow(pid: Int32, windowId: UInt32) -> AXUIElement? {
		guard OffSpaceSupport.shared.available else { return nil }
		offSpaceLock.lock()
		let entry = offSpaceWindows[windowId]
		offSpaceLock.unlock()
		guard let entry, entry.pid == pid, verifiedOffSpaceElement(entry.element, pid: pid, windowId: windowId) else { return nil }
		return entry.element
	}

	private func rememberOffSpaceWindow(_ element: AXUIElement, pid: Int32, windowId: UInt32) {
		offSpaceLock.lock()
		defer { offSpaceLock.unlock() }
		if offSpaceWindows.count >= 256 { offSpaceWindows.removeAll() }
		offSpaceWindows[windowId] = (pid, element)
	}

	private func resolveOffSpaceWindows(pid: Int32, windowIds: [UInt32], scan: Bool, messagingTimeout: Float = 1.0) -> [UInt32: (element: AXUIElement, source: String)] {
		var found: [UInt32: (element: AXUIElement, source: String)] = [:]
		for windowId in windowIds {
			if let cached = cachedOffSpaceWindow(pid: pid, windowId: windowId) { found[windowId] = (cached, "cache") }
		}
		var wanted = Set(windowIds).subtracting(found.keys)
		guard !wanted.isEmpty, OffSpaceSupport.shared.available else { return found }
		let app = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(app, messagingTimeout)
		for (attribute, source) in [(kAXFocusedWindowAttribute, "focused_window"), (kAXMainWindowAttribute, "main_window")] {
			guard let window = copyAttribute(app, attribute: attribute as CFString).flatMap(asAXElement),
				let windowId = OffSpaceSupport.shared.windowId(of: window), wanted.contains(windowId),
				verifiedOffSpaceElement(window, pid: pid, windowId: windowId)
			else { continue }
			found[windowId] = (window, source)
			wanted.remove(windowId)
		}
		if scan && !wanted.isEmpty {
			let scanned = OffSpaceSupport.shared.tokenWindows(pid: pid, wanted: wanted, deadline: monotonicSeconds() + OffSpaceSupport.tokenScanBudget)
			for (windowId, element) in scanned.found { found[windowId] = (element, "token") }
		}
		for (windowId, entry) in found where entry.source != "cache" { rememberOffSpaceWindow(entry.element, pid: pid, windowId: windowId) }
		return found
	}

	private func windowAlpha(_ windowId: UInt32) -> Double {
		let entries = CGWindowListCreateDescriptionFromArray([NSNumber(value: windowId)] as CFArray) as? [[String: Any]]
		return (entries?.first?[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
	}

	func offSpaceRoots(pid: Int32, candidates: [CGWindowCandidate], listed: Set<UInt32>, messagingTimeout: Float, request: [String: Any]?, scan: Bool) -> [[String: Any]] {
		let support = OffSpaceSupport.shared
		guard support.available else { return [] }
		let unlisted = candidates.filter { !listed.contains($0.windowId) && $0.bounds.width >= 100 && $0.bounds.height >= 80 }
		guard !unlisted.isEmpty, NSRunningApplication(processIdentifier: pid)?.isHidden != true, let layout = support.spaceLayout() else { return [] }
		let offSpace = unlisted.filter { support.isOffSpace($0.windowId, layout: layout) && windowAlpha($0.windowId) > 0 }
		guard !offSpace.isEmpty else { return [] }
		var policyAllows = false
		if let request, request["appBlocklist"] != nil { policyAllows = (try? enforceAppPolicy(owner: pid, request: request)) != nil }
		let resolved = policyAllows ? resolveOffSpaceWindows(pid: pid, windowIds: offSpace.map { $0.windowId }, scan: scan, messagingTimeout: messagingTimeout) : [:]
		var output: [[String: Any]] = []
		for candidate in offSpace {
			let element = resolved[candidate.windowId]?.element
			if let element, boolAttribute(element, attribute: kAXMinimizedAttribute as CFString) == true { continue }
			let axTitle = element.flatMap { stringAttribute($0, attribute: kAXTitleAttribute as CFString) } ?? ""
			let role = element.flatMap { stringAttribute($0, attribute: kAXRoleAttribute as CFString) } ?? "AXWindow"
			let subrole = element.flatMap { stringAttribute($0, attribute: kAXSubroleAttribute as CFString) } ?? ""
			let sheetCount = element.map { sheetElements(of: $0).count } ?? 0
			let isModal = element.map { (boolAttribute($0, attribute: "AXModal" as CFString) ?? false) || sheetCount > 0 || isDialogLikeRoot(role: role, subrole: subrole) } ?? false
			let bounds = candidate.bounds
			let access = element != nil ? "resolved" : (policyAllows && scan ? "unresolved" : "not_checked")
			var item: [String: Any] = [
				"kind": rootKind(role: role, subrole: subrole),
				"windowId": Int(candidate.windowId),
				"zOrder": candidate.zOrder,
				"title": axTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? candidate.title : axTitle,
				"role": role,
				"subrole": subrole,
				"isModal": isModal,
				"framePoints": ["x": bounds.origin.x, "y": bounds.origin.y, "w": bounds.width, "h": bounds.height],
				"scaleFactor": displayScaleFactor(for: bounds),
				"isMinimized": false,
				"isOnscreen": false,
				"isMain": element.flatMap { boolAttribute($0, attribute: kAXMainAttribute as CFString) } ?? false,
				"isFocused": element.flatMap { boolAttribute($0, attribute: kAXFocusedAttribute as CFString) } ?? false,
				"metadata": ["pairing": ["confidence": element == nil ? "low" : "exact", "score": element == nil ? 0 : 100], "sheetCount": sheetCount, "offSpace": true],
				"offSpace": true,
				"offSpaceAccess": access,
			]
			if let element {
				let ref = refStore.storeWindow(element)
				item["rootRef"] = ref
				item["windowRef"] = ref
			}
			output.append(item)
		}
		return output
	}

	func offSpaceLookWindow(pid: Int32, windowId: UInt32, request: [String: Any]) throws -> (element: AXUIElement, info: [String: Any]) {
		if let found = resolveOffSpaceWindows(pid: pid, windowIds: [windowId], scan: true)[windowId] {
			return (found.element, ["discoveryActivation": false, "resolvedBy": found.source])
		}
		let lead = "off_space_window_unresolved: window \(windowId) of \(appLabel(pid)) is on a Space no display shows, "
			+ "and the app has not exposed it to Accessibility (it has not been shown on a visible Space since it opened, or its element lies beyond the helper's scan)"
		let showOnce = "The user can show the window once (switch to its Space and back)"
		var details: [String: Any] = ["offSpace": true, "windowId": Int(windowId), "discoveryActivation": false]
		func refusal(_ message: String) -> BridgeFailure {
			BridgeFailure(message: message, code: "off_space_window_unresolved", effectPossible: false, details: details)
		}
		guard optionalStringArg(request, "backgroundDelivery") == "extended" else {
			throw refusal("\(lead), so it cannot be read without switching Spaces; nothing was activated or captured. "
				+ "\(showOnce), or enable background_delivery: \"extended\", which lets the helper tell the app it is active for a moment so that it exposes the window")
		}
		if let reason = OffSpaceSupport.shared.discoveryUnavailableReason {
			details["discoveryUnavailableReason"] = reason
			throw refusal("\(lead); the discovery activation extended delivery would use is unavailable in this helper (\(reason)), so nothing was activated or captured. \(showOnce)")
		}
		if currentFrontmostPid() == pid || NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
			details["discoveryUnavailableReason"] = "target_frontmost"
			throw refusal("\(lead); the app is frontmost, so the helper does not tell it it is active, and nothing was activated or captured. \(showOnce)")
		}
		guard let bounds = windowInfo(windowId: windowId)?.bounds else {
			throw BridgeFailure(message: "Window \(windowId) is no longer available", code: "root_not_found")
		}
		let before = OffSpaceSupport.shared.spaceLayout()?.current
		let found = try discoverOffSpaceWindow(ExtendedDeliveryTarget(pid: pid, windowId: windowId, windowFrame: bounds))
		let after = OffSpaceSupport.shared.spaceLayout()?.current
		let spacesUnchanged = before != nil && before == after
		guard let found else {
			details["discoveryActivation"] = true
			details["spacesUnchanged"] = spacesUnchanged
			throw refusal("\(lead); a discovery activation was tried (the app was told it was active for a moment, then inactive) and the window still did not resolve, so nothing was captured. \(showOnce)")
		}
		return (found.element, ["discoveryActivation": true, "resolvedBy": found.source, "spacesUnchanged": spacesUnchanged])
	}

	private func discoverOffSpaceWindow(_ target: ExtendedDeliveryTarget) throws -> (element: AXUIElement, source: String)? {
		try beginExtendedDelivery(target)
		defer { endExtendedDelivery(target) }
		for _ in 0..<8 {
			if let found = resolveOffSpaceWindows(pid: target.pid, windowIds: [target.windowId], scan: false)[target.windowId] {
				return (found.element, "discovery_\(found.source)")
			}
			usleep(25_000)
		}
		return resolveOffSpaceWindows(pid: target.pid, windowIds: [target.windowId], scan: true)[target.windowId].map { ($0.element, "discovery_\($0.source)") }
	}

}

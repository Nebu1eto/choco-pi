import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct ExtendedDeliveryTarget {
	let pid: Int32
	let windowId: UInt32
	let windowFrame: CGRect
}

final class ExtendedDeliverySupport {
	typealias PostRecordFn = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
	typealias GetPSNFn = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
	typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

	static let measuredOSMajorVersions: [Int] = [27]
	static let shared = ExtendedDeliverySupport()

	let postRecord: PostRecordFn?
	let getPSN: GetPSNFn?
	let setWindowLocation: SetWindowLocationFn?
	let osMajorVersion: Int
	let missingSymbols: [String]

	private init() {
		let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
		let everywhere = UnsafeMutableRawPointer(bitPattern: -2)
		func symbol(_ name: String) -> UnsafeMutableRawPointer? {
			if let skyLight, let found = dlsym(skyLight, name) { return found }
			return dlsym(everywhere, name)
		}
		let post = symbol("SLPSPostEventRecordTo")
		let psn = symbol("GetProcessForPID")
		let location = symbol("CGEventSetWindowLocation")
		postRecord = post.map { unsafeBitCast($0, to: PostRecordFn.self) }
		getPSN = psn.map { unsafeBitCast($0, to: GetPSNFn.self) }
		setWindowLocation = location.map { unsafeBitCast($0, to: SetWindowLocationFn.self) }
		var missing: [String] = []
		if post == nil { missing.append("SLPSPostEventRecordTo") }
		if psn == nil { missing.append("GetProcessForPID") }
		if location == nil { missing.append("CGEventSetWindowLocation") }
		missingSymbols = missing
		osMajorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
	}

	var unavailableReason: String? {
		if !missingSymbols.isEmpty { return "missing_symbols" }
		if !Self.measuredOSMajorVersions.contains(osMajorVersion) { return "os_not_measured" }
		return nil
	}

	var available: Bool { unavailableReason == nil }

	func diagnostics() -> [String: Any] {
		var output: [String: Any] = [
			"available": available,
			"osMajorVersion": osMajorVersion,
			"measuredOSMajorVersions": Self.measuredOSMajorVersions,
			"missingSymbols": missingSymbols,
		]
		if let unavailableReason { output["reason"] = unavailableReason }
		return output
	}
}

extension Bridge {
	struct ExtendedDeliveryPlan {
		let status: String?
		let reason: String?
		let target: ExtendedDeliveryTarget?
		static let notRequested = ExtendedDeliveryPlan(status: nil, reason: nil, target: nil)
	}

	private static let menuRoles: Set<String> = ["AXPopUpButton", "AXMenuButton", "AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem"]
	private static let extendedTextRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]

	func extendedDeliveryPlan(request: [String: Any], record: LookRecord, pid: Int32, action: String, target: [String: Any], policy: String, delivery: String) -> ExtendedDeliveryPlan {
		guard optionalStringArg(request, "backgroundDelivery") == "extended" else { return .notRequested }
		func notApplicable(_ reason: String) -> ExtendedDeliveryPlan { ExtendedDeliveryPlan(status: "not_applicable", reason: reason, target: nil) }
		let support = ExtendedDeliverySupport.shared
		if let reason = support.unavailableReason { return ExtendedDeliveryPlan(status: "unavailable", reason: reason, target: nil) }
		guard policy == "background", delivery == "pid" else { return notApplicable("policy_\(policy)") }
		if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return notApplicable("target_frontmost") }
		guard record.windowId != 0, record.windowFrame.width > 0, record.windowFrame.height > 0 else { return notApplicable("no_window_id") }
		if let reason = extendedElementExclusion(request: request, record: record, pid: pid, action: action, target: target) { return notApplicable(reason) }
		return ExtendedDeliveryPlan(status: "used", reason: nil, target: ExtendedDeliveryTarget(pid: pid, windowId: record.windowId, windowFrame: record.windowFrame))
	}

	private func extendedElementExclusion(request: [String: Any], record: LookRecord, pid: Int32, action: String, target: [String: Any]) -> String? {
		let element: AXUIElement
		if optionalStringArg(request, "focusResolution") == "ax_focused_element" {
			guard let focused = appFocusedElement(pid: pid), pidForElement(focused) == pid else { return "element_unidentified" }
			element = focused
		} else if let ref = target["ref"] as? String {
			let cached = refStore.element(for: ref).flatMap { stringAttribute($0, attribute: kAXRoleAttribute as CFString) != nil && frameForElement($0) != nil ? $0 : nil }
			guard let resolved = cached ?? refindElement(ref: ref, pid: pid, windowId: record.windowId) else { return "stale_ref" }
			element = resolved
		} else if let pointX = (target["x"] as? NSNumber)?.doubleValue, let pointY = (target["y"] as? NSNumber)?.doubleValue {
			guard record.hasImage, let hit = targetElement(at: lookPoint(record: record, x: pointX, y: pointY), pid: pid, record: record) else { return "element_unidentified" }
			element = hit
		} else {
			return "element_unidentified"
		}
		if opensMenu(element) { return "menu_element" }
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		if isSecureTextElement(role: role, subrole: subrole) { return "secure_text" }
		guard target["ref"] is String else { return nil }
		switch ancestorRole(element, role: "AXWebArea") {
		case .found:
			return nil
		case .inconclusive:
			return "web_ancestry_inconclusive"
		case .notFound:
			break
		}
		switch action {
		case "press", "click":
			if Self.extendedTextRoles.contains(role) { return "ax_focus" }
			if supportsAction(element, action: kAXPressAction as CFString) { return "ax_action" }
			return nil
		case "setText":
			return "ax_text"
		default:
			return nil
		}
	}

	private func opensMenu(_ element: AXUIElement) -> Bool {
		var current: AXUIElement? = element
		for _ in 0..<6 {
			guard let node = current else { return false }
			if let role = stringAttribute(node, attribute: kAXRoleAttribute as CFString), Self.menuRoles.contains(role) { return true }
			current = parentElement(node)
		}
		return false
	}

	private func targetElement(at point: CGPoint, pid: Int32, record: LookRecord) -> AXUIElement? {
		switch appHitTestElement(at: point, pid: pid, record: record) {
		case .observedWindow(let element):
			return element
		case .otherTargetWindow(let element):
			return opensMenu(element) ? element : windowFrameElement(at: point, pid: pid, record: record)
		case .unidentified:
			return OffSpaceSupport.shared.isOffSpace(record.windowId) ? windowFrameElement(at: point, pid: pid, record: record) : nil
		}
	}

	private enum AppHit {
		case observedWindow(AXUIElement)
		case otherTargetWindow(AXUIElement)
		case unidentified
	}

	private func appHitTestElement(at point: CGPoint, pid: Int32, record: LookRecord) -> AppHit {
		let app = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(app, 1.0)
		var hit: AXUIElement?
		guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success, let hit, pidForElement(hit) == pid,
			let window = lookWindowElement(record, pid: pid) ?? windowElement(pid: pid, windowId: record.windowId)
		else { return .unidentified }
		let hitWindow = copyAttribute(hit, attribute: kAXWindowAttribute as CFString).flatMap(asAXElement)
		if let hitWindow, windowsRelated(hitWindow, window) { return .observedWindow(hit) }
		var current: AXUIElement? = hit
		for _ in 0..<64 {
			guard let node = current else { break }
			if sameElement(node, window) { return .observedWindow(hit) }
			current = parentElement(node)
		}
		guard let hitWindow, pidForElement(hitWindow) == pid,
			stringAttribute(hitWindow, attribute: kAXRoleAttribute as CFString) == "AXWindow",
			let hitWindowId = OffSpaceSupport.shared.windowId(of: hitWindow), hitWindowId != record.windowId
		else { return .unidentified }
		return .otherTargetWindow(hit)
	}

	func withExtendedDeliveryStatus(_ response: [String: Any], plan: ExtendedDeliveryPlan) -> [String: Any] {
		guard let status = plan.status else { return response }
		var output = response
		var performed = output["performed"] as? [String: Any] ?? [:]
		performed["extendedDelivery"] = status
		if let reason = plan.reason { performed["extendedDeliveryReason"] = reason }
		output["performed"] = performed
		guard status == "used" else { return output }
		var evidence = output["evidence"] as? [String: Any] ?? [:]
		evidence["extendedDelivery"] = "used"
		if (output["outcome"] as? String) == "didnt" {
			output["outcome"] = "unknown"
			evidence["observableChange"] = false
		}
		output["evidence"] = evidence
		return output
	}

	func beginExtendedDelivery(_ target: ExtendedDeliveryTarget) throws {
		extendedActivationLock.lock()
		if extendedShuttingDown {
			extendedActivationLock.unlock()
			throw BridgeFailure(message: "The helper is shutting down; extended background delivery was not started and nothing was sent", code: "helper_shutting_down", effectPossible: false)
		}
		let count = (extendedActivations[target.pid]?.count ?? 0) + 1
		extendedActivations[target.pid] = (count, target)
		postAppKitActivation(target, activated: true)
		postKeyWindowRecords(target)
		extendedActivationLock.unlock()
		usleep(30_000)
	}

	func requireExtendedKeyWindow(_ target: ExtendedDeliveryTarget, window: AXUIElement?) throws {
		guard let window else {
			throw BridgeFailure(
				message: "Extended background delivery could not resolve the observed window, so it could not confirm that window is the target's key window; no key input was sent, only the activation",
				code: "foreground_required",
				effectPossible: false,
				details: ["keyWindowAcquired": false, "observedWindowResolved": false]
			)
		}
		for attempt in 0..<8 {
			if isKeyWindow(window, pid: target.pid) { return }
			try checkpoint()
			if attempt == 2 {
				extendedActivationLock.lock()
				if !extendedShuttingDown { postKeyWindowRecords(target) }
				extendedActivationLock.unlock()
			}
			usleep(25_000)
		}
		if isKeyWindow(window, pid: target.pid) { return }
		throw BridgeFailure(
			message: "Extended background delivery could not make the observed window the target's key window; no key input was sent",
			code: "foreground_required",
			effectPossible: false,
			details: ["keyWindowAcquired": false, "observedWindowResolved": true]
		)
	}

	func settleExtendedKeyWindow(_ target: ExtendedDeliveryTarget, window: AXUIElement?) throws {
		guard let window else { return }
		for _ in 0..<8 {
			if isKeyWindow(window, pid: target.pid) { return }
			try checkpoint()
			usleep(25_000)
		}
	}

	func endExtendedDelivery(_ target: ExtendedDeliveryTarget) {
		extendedActivationLock.lock()
		defer { extendedActivationLock.unlock() }
		guard let entry = extendedActivations[target.pid] else { return }
		if entry.count > 1 {
			extendedActivations[target.pid] = (entry.count - 1, entry.target)
			return
		}
		extendedActivations.removeValue(forKey: target.pid)
		postAppKitActivation(target, activated: false)
	}

	func deactivateExtendedTargets() {
		extendedActivationLock.lock()
		defer { extendedActivationLock.unlock() }
		extendedShuttingDown = true
		for entry in extendedActivations.values { postAppKitActivation(entry.target, activated: false) }
		extendedActivations.removeAll()
	}

	private func windowFrameElement(at point: CGPoint, pid: Int32, record: LookRecord) -> AXUIElement? {
		guard let window = lookWindowElement(record, pid: pid) ?? windowElement(pid: pid, windowId: record.windowId),
			pidForElement(window) == pid, OffSpaceSupport.shared.windowId(of: window) == record.windowId,
			let windowFrame = frameForElement(window), windowFrame.contains(point)
		else { return nil }
		var current = window
		for _ in 0..<32 {
			let containing = axElementArray(current, attribute: kAXChildrenAttribute as CFString).filter { child in
				if boolAttribute(child, attribute: "AXHidden" as CFString) == true { return false }
				guard let frame = frameForElement(child), frame.width > 0, frame.height > 0 else { return false }
				return frame.contains(point)
			}
			if containing.isEmpty { return sameElement(current, window) || pidForElement(current) != pid ? nil : current }
			guard containing.count == 1 else { return nil }
			current = containing[0]
		}
		return nil
	}

	func installTerminationHandlers() {
		for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
			_ = signal(signalNumber, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: DispatchQueue.global())
			source.setEventHandler { [self] in
				deactivateExtendedTargets()
				exit(0)
			}
			source.resume()
			terminationSources.append(source)
		}
	}

	private func postAppKitActivation(_ target: ExtendedDeliveryTarget, activated: Bool) {
		let subtype = activated ? NSEvent.EventSubtype.applicationActivated.rawValue : NSEvent.EventSubtype.applicationDeactivated.rawValue
		let centre = CGPoint(x: target.windowFrame.width / 2, y: target.windowFrame.height / 2)
		guard let event = NSEvent.otherEvent(
			with: .appKitDefined, location: centre, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
			windowNumber: Int(target.windowId), context: nil, subtype: subtype, data1: 0, data2: 0
		),
			let cgEvent = event.cgEvent
		else { return }
		cgEvent.postToPid(target.pid)
	}

	private func postKeyWindowRecords(_ target: ExtendedDeliveryTarget) {
		let support = ExtendedDeliverySupport.shared
		guard let post = support.postRecord, let getPSN = support.getPSN else { return }
		var psn = ProcessSerialNumber()
		let found = withUnsafeMutablePointer(to: &psn) { getPSN(target.pid, UnsafeMutableRawPointer($0)) }
		guard found == 0 else { return }
		let windowBytes = withUnsafeBytes(of: target.windowId.littleEndian) { Array($0) }
		for phase: UInt8 in [0x01, 0x02] {
			var bytes = [UInt8](repeating: 0, count: 0xf8)
			bytes[0x04] = 0xf8
			bytes[0x08] = phase
			bytes[0x3a] = 0x10
			for index in 0x20..<0x30 { bytes[index] = 0xff }
			for (index, byte) in windowBytes.enumerated() { bytes[0x3c + index] = byte }
			_ = withUnsafeMutablePointer(to: &psn) { psnPointer in
				bytes.withUnsafeMutableBufferPointer { buffer -> Int32 in
					guard let base = buffer.baseAddress else { return -1 }
					return post(UnsafeMutableRawPointer(psnPointer), base)
				}
			}
		}
	}

}

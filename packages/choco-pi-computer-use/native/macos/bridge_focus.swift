import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
	func listApps(cgEntries: [[String: Any]]? = nil) -> [[String: Any]] {
		let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let apps = NSWorkspace.shared.runningApplications.filter { app in
			app.processIdentifier != getpid() && pidIsAlive(app.processIdentifier)
		}
		var seen = Set<Int32>()
		var output = apps.map { app in
			seen.insert(app.processIdentifier)
			var data: [String: Any] = [
				"appName": app.localizedName ?? processName(pid: app.processIdentifier) ?? "Unknown App",
				"pid": Int(app.processIdentifier),
				"isFrontmost": app.processIdentifier == frontmostPid,
			]
			if let bundleId = app.bundleIdentifier {
				data["bundleId"] = bundleId
			}
			return data
		}

		for owner in cgWindowOwners(entries: cgEntries) where owner.pid != getpid() && !seen.contains(owner.pid) && pidIsAlive(owner.pid) {
			seen.insert(owner.pid)
			output.append([
				"appName": owner.name,
				"pid": Int(owner.pid),
				"isFrontmost": owner.pid == frontmostPid,
			])
		}
		return output
	}

	func getFrontmost() throws -> [String: Any] {
		let frontPid = currentFrontmostPid() ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
		guard let frontPid, let app = NSRunningApplication(processIdentifier: frontPid) else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		var result: [String: Any] = ["appName": app.localizedName ?? "Unknown App", "pid": Int(frontPid)]
		if let bundleId = app.bundleIdentifier { result["bundleId"] = bundleId }
		guard let key = keyWindow(pid: frontPid) else {
			result["windowSource"] = "unknown"
			return result
		}
		result["windowSource"] = key.source
		result["windowTitle"] = stringAttribute(key.window, attribute: kAXTitleAttribute as CFString) ?? ""
		result["windowRef"] = refStore.storeWindow(key.window)
		if let windowId = cgWindowId(of: key.window, pid: frontPid) { result["windowId"] = Int(windowId) }
		return result
	}

	func keyWindow(pid: Int32) -> (window: AXUIElement, source: String)? {
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.5)
		if let focused = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement) {
			return (focused, "focused")
		}
		if let main = copyAttribute(appElement, attribute: kAXMainWindowAttribute as CFString).flatMap(asAXElement) {
			return (main, "main")
		}
		return nil
	}

	private func cgWindowId(of window: AXUIElement, pid: Int32) -> UInt32? {
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.5)
		let windows = Array(axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).prefix(128))
		let candidates = cgWindowCandidates(pid: pid)
		let pairings = windowPairings(windows: windows, candidates: candidates)
		for candidate in windows {
			if sameElement(candidate, window) { return pairings[ObjectIdentifier(candidate)]?.candidate?.windowId }
			for sheet in sheetElements(of: candidate) where sameElement(sheet, window) {
				return bestCandidate(for: sheet, candidates: candidates)?.windowId
			}
		}
		return nil
	}

	func isKeyWindow(_ window: AXUIElement, pid: Int32) -> Bool {
		guard let key = keyWindow(pid: pid), key.source == "focused" else { return false }
		return windowsRelated(key.window, window)
	}

	private func waitUntil(seconds: Double, _ condition: () -> Bool) -> Bool {
		let end = monotonicSeconds() + seconds
		while true {
			if condition() { return true }
			if monotonicSeconds() >= end { return false }
			usleep(20_000)
		}
	}

	func getUserContext(_ request: [String: Any]) throws -> [String: Any] {
		guard let app = NSWorkspace.shared.frontmostApplication else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		let pid = app.processIdentifier
		try enforceAppPolicy(owner: pid, request: request)
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement)
		let focusedElement = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		var result: [String: Any] = [
			"appName": app.localizedName ?? "Unknown App",
			"pid": Int(pid),
		]
		if let bundleId = app.bundleIdentifier {
			result["bundleId"] = bundleId
		}
		if let window = focusedWindow {
			result["window"] = [
				"title": stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? "",
				"role": stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? "",
				"subrole": stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? "",
			]
		}
		if let element = focusedElement {
			let focusedRole = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let focusedSubrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
			result["focusedElement"] = [
				"role": focusedRole,
				"subrole": focusedSubrole,
				"title": stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? "",
				"description": stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
				"value": displayValue(element, role: focusedRole, subrole: focusedSubrole),
			]
		}
		return result
	}

	func restoreUserFocus(_ request: [String: Any]) throws -> [String: Any] {
		try requireForegroundGrant(request, "restoreUserFocus")
		let pid = Int32(try intArg(request, "pid"))
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
			throw BridgeFailure(message: "App with pid \(pid) is no longer running", code: "app_not_found")
		}
		let frontBefore = currentFrontmostPid()
		var result: [String: Any] = ["appName": app.localizedName ?? "Unknown App", "restored": false, "appRestored": false, "windowRestored": false]
		if let frontBefore { result["frontmostBefore"] = Int(frontBefore) }
		if let expected = optionalIntArg(request, "expectedFrontmostPid"), frontBefore != Int32(expected) {
			result["reason"] = "frontmost_changed"
			return result
		}
		let resolved = userWindow(pid: pid, request: request)
		result["windowMatch"] = resolved.match
		if let window = resolved.window {
			result["windowTitle"] = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		}
		if frontBefore != pid {
			result["activationRequested"] = true
			_ = app.activate()
		}
		let appFront = waitUntil(seconds: 0.6) { currentFrontmostPid() == pid }
		var windowRestored = false
		if appFront, let window = resolved.window { windowRestored = try makeKeyWindow(window, pid: pid) }
		let windowNamed = resolved.match != "none"
		result["appRestored"] = appFront
		result["windowRestored"] = windowRestored
		result["restored"] = appFront && (!windowNamed || windowRestored)
		if !appFront {
			result["reason"] = "app_not_frontmost"
		} else if windowNamed && !windowRestored {
			result["reason"] = resolved.window == nil ? "window_not_found" : "window_not_key"
		}
		return result
	}

	private func userWindow(pid: Int32, request: [String: Any]) -> (window: AXUIElement?, match: String) {
		let windowRef = optionalStringArg(request, "windowRef")
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		if let windowRef, let stored = refStore.window(for: windowRef), pidForElement(stored) == pid,
			stringAttribute(stored, attribute: kAXRoleAttribute as CFString) != nil
		{
			return (stored, "ref")
		}
		if let windowId { return (windowElement(pid: pid, windowId: windowId), "id") }
		if windowRef != nil { return (nil, "ref") }
		let title = optionalStringArg(request, "windowTitle")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
		if title.isEmpty { return (nil, "none") }
		let appElement = AXUIElementCreateApplication(pid)
		let match = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).first {
			(stringAttribute($0, attribute: kAXTitleAttribute as CFString) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == title
		}
		return (match, "title")
	}

	private func makeKeyWindow(_ window: AXUIElement, pid: Int32) throws -> Bool {
		if isKeyWindow(window, pid: pid) { return true }
		_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		_ = try setAXFocus(window, foregroundGranted: true)
		_ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		return waitUntil(seconds: 0.4) { isKeyWindow(window, pid: pid) }
	}

	func setWindowFrame(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request, act: true)
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["ok": false, "reason": "window_not_found"]
		}
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		let width = max(100.0, try doubleArg(request, "width"))
		let height = max(80.0, try doubleArg(request, "height"))
		var origin = CGPoint(x: x, y: y)
		var size = CGSize(width: width, height: height)
		guard let originValue = AXValueCreate(.cgPoint, &origin), let sizeValue = AXValueCreate(.cgSize, &size) else {
			throw BridgeFailure(message: "Failed to create AX frame values", code: "frame_value_failed")
		}
		let positionStatus = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, originValue)
		let sizeStatus = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
		let frame = frameForWindow(window)
		return [
			"ok": positionStatus == .success || sizeStatus == .success,
			"positionStatus": Int(positionStatus.rawValue),
			"sizeStatus": Int(sizeStatus.rawValue),
			"framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height],
		]
	}

	func focusWindow(_ request: [String: Any]) throws -> [String: Any] {
		try requireForegroundGrant(request, "focusWindow")
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request, act: true)
		let addressedWindowId = windowId ?? windowRef.flatMap { refStore.window(for: $0) }.flatMap { OffSpaceSupport.shared.windowId(of: $0) }
		if let addressedWindowId, OffSpaceSupport.shared.isOffSpace(addressedWindowId) {
			throw BridgeFailure(
				message: "off_space_foreground: the window is on a Space no display shows; focusing it would switch the user's Space, so nothing was changed",
				code: "off_space_foreground",
				effectPossible: false,
				details: ["inputSent": false, "activationAttempted": false, "offSpace": true]
			)
		}
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["focused": false, "reason": "window_not_found"]
		}

		let appElement = AXUIElementCreateApplication(pid)
		if let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement),
			sameElement(focusedWindow, window)
		{
			return ["focused": true, "alreadyFocused": true]
		}

		let setMainStatus = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		let setFocusedStatus = try setAXFocus(window, foregroundGranted: true)
		let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		let focused = setMainStatus == .success || setFocusedStatus == .success || raiseStatus == .success
		var result: [String: Any] = [
			"focused": focused,
			"setMain": setMainStatus == .success,
			"setFocused": setFocusedStatus == .success,
			"raised": raiseStatus == .success,
		]
		if !focused {
			result["reason"] = "focus_failed"
		}
		return result
	}

}

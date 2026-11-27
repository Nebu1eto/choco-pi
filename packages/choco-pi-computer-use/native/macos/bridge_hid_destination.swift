import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct HIDDestination {
	let pid: Int32
	let windowId: UInt32
	let window: AXUIElement?
	let frontmostBefore: pid_t?
	let inputBaseline: Int
}

extension Bridge {
	private static let extendedPointerTypes: Set<CGEventType> = [
		.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
		.otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel,
	]

	private func addressPointerEvent(_ event: CGEvent, pid: Int32, context: RequestContext?) {
		let scrollTarget = event.type == .scrollWheel ? context?.pidScrollWindow : nil
		guard let target = context?.extendedDelivery ?? scrollTarget, target.pid == pid, Self.extendedPointerTypes.contains(event.type),
			let windowField = CGEventField(rawValue: 51)
		else { return }
		event.setIntegerValueField(windowField, value: Int64(target.windowId))
		let point = event.location
		ExtendedDeliverySupport.shared.setWindowLocation?(event, CGPoint(x: point.x - target.windowFrame.origin.x, y: point.y - target.windowFrame.origin.y))
	}

	private func eventDelivery(_ request: [String: Any]) -> String {
		optionalStringArg(request, "delivery") == "pid" ? "pid" : "hid"
	}

	func postEvent(_ event: CGEvent, pid: Int32, delivery: String = "hid") throws {
		let context = activeRequestContext()
		if delivery == "pid" {
			context?.markEffect()
			context?.markInputEvent()
			addressPointerEvent(event, pid: pid, context: context)
			event.postToPid(pid)
			return
		}
		guard let context, context.foregroundGrant else {
			throw foregroundRequired("HID event delivery requires a host foreground grant")
		}
		try requireFrontmostForHIDPost(pid: pid, context: context)
		context.markEffect()
		context.markInputEvent()
		event.post(tap: .cghidEventTap)
		if Self.extendedPointerTypes.contains(event.type) { context.hidPointerLastPosted = event.location }
	}

	func postReleaseEvent(_ event: CGEvent, pid: Int32, delivery: String) throws {
		let context = activeRequestContext()
		if delivery == "pid" {
			context?.markEffect()
			context?.markInputEvent()
			addressPointerEvent(event, pid: pid, context: context)
			event.postToPid(pid)
			return
		}
		guard let context, context.foregroundGrant else {
			throw foregroundRequired("HID event delivery requires a host foreground grant")
		}
		context.markEffect()
		context.markInputEvent()
		event.post(tap: .cghidEventTap)
		if Self.extendedPointerTypes.contains(event.type) { context.hidPointerLastPosted = event.location }
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
			throw destinationFailure(pid: pid, context: context, reason: "process_not_found", frontmostPid: currentFrontmostPid())
		}
		let front = currentFrontmostPid()
		if front != pid {
			throw destinationFailure(pid: pid, context: context, reason: "app_not_frontmost", frontmostPid: front)
		}
	}

	private static let foregroundAcquireBudget: TimeInterval = 0.4
	private static let foregroundPollMicros: useconds_t = 20_000
	private static let foregroundRecheckInterval: TimeInterval = 0.1

	enum HIDGesture {
		case keyboard
		case pointer(CGPoint)
	}

	private enum DestinationProbe {
		case confirmed(windowVerified: Bool)
		case mismatch(reason: String, frontmostPid: pid_t?)
		case gone
	}

	func currentFrontmostPid() -> pid_t? {
		let systemWide = AXUIElementCreateSystemWide()
		AXUIElementSetMessagingTimeout(systemWide, 0.25)
		if let focusedApp = copyAttribute(systemWide, attribute: kAXFocusedApplicationAttribute as CFString).flatMap(asAXElement),
			let focusedPid = pidForElement(focusedApp)
		{
			return focusedPid
		}
		return NSWorkspace.shared.frontmostApplication?.processIdentifier
	}

	func lookWindowElement(_ record: LookRecord, pid: Int32) -> AXUIElement? {
		guard let root = record.rootElement, pidForElement(root) == pid else { return nil }
		let role = stringAttribute(root, attribute: kAXRoleAttribute as CFString) ?? ""
		return role == "AXWindow" || role == "AXSheet" ? root : nil
	}

	private func destinationWindow(_ destination: HIDDestination, context: RequestContext) -> AXUIElement? {
		if !context.destinationWindowResolved {
			context.destinationWindowResolved = true
			let observed = destination.window.flatMap { window in
				stringAttribute(window, attribute: kAXRoleAttribute as CFString) == nil ? nil : window
			}
			context.destinationWindowElement = observed
				?? (destination.windowId == 0 ? nil : windowElement(pid: destination.pid, windowId: destination.windowId))
		}
		return context.destinationWindowElement
	}

	func windowsRelated(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
		sameElement(lhs, rhs) || isElement(lhs, descendantOf: rhs) || isElement(rhs, descendantOf: lhs)
	}

	private func probeDestination(_ gesture: HIDGesture, destination: HIDDestination, context: RequestContext) -> DestinationProbe {
		guard let app = NSRunningApplication(processIdentifier: destination.pid), !app.isTerminated else { return .gone }
		let front = currentFrontmostPid()
		guard front == destination.pid else { return .mismatch(reason: "app_not_frontmost", frontmostPid: front) }
		if case .pointer(let point) = gesture, let hit = hitTestElement(at: point), let hitPid = pidForElement(hit),
			hitPid != destination.pid, hitPid != getpid()
		{
			return .mismatch(reason: "point_covered_by_other_process", frontmostPid: front)
		}
		let appElement = AXUIElementCreateApplication(destination.pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		let keyWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement)
			?? copyAttribute(appElement, attribute: kAXMainWindowAttribute as CFString).flatMap(asAXElement)
		guard let keyWindow, let lookWindow = destinationWindow(destination, context: context) else {
			return .confirmed(windowVerified: false)
		}
		if windowsRelated(keyWindow, lookWindow) { return .confirmed(windowVerified: true) }
		return .mismatch(reason: "window_not_focused", frontmostPid: front)
	}

	func appLabel(_ pid: Int32) -> String {
		let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? processName(pid: pid) ?? "pid \(pid)"
		return "\(name) (pid \(pid))"
	}

	private func destinationFailure(pid: Int32, context: RequestContext, reason: String, frontmostPid: pid_t?) -> BridgeFailure {
		let destination = context.hidDestination
		let sent = context.inputEventCount > (destination?.inputBaseline ?? 0)
		let target = appLabel(pid)
		let cause: String
		switch reason {
		case "process_not_found":
			cause = "the target process \(target) is no longer running"
		case "no_destination":
			cause = "no foreground destination was recorded for \(target)"
		case "window_not_focused":
			cause = "\(target) is frontmost, but its focused window is not this look's window"
		case "point_covered_by_other_process":
			cause = "the point is covered by another process's window"
		default:
			cause = "\(target) is not the frontmost app" + (frontmostPid.map { "; \(appLabel($0)) is" } ?? "")
		}
		var details: [String: Any] = [
			"inputSent": sent,
			"activationAttempted": context.activationAttempted,
			"destinationReason": reason,
			"targetPid": Int(pid),
		]
		if let frontmostPid { details["frontmostPid"] = Int(frontmostPid) }
		if let before = destination?.frontmostBefore { details["frontmostBefore"] = Int(before) }
		if let after = NSWorkspace.shared.frontmostApplication?.processIdentifier { details["frontmostAfter"] = Int(after) }
		let activation = context.activationAttempted
			? " The helper asked the target to activate or raise its window; that side effect may still bring it to the front."
			: ""
		if sent {
			let characters = context.charactersSent
			if let characters { details["charactersSent"] = characters }
			var result: [String: Any] = ["outcome": "partial", "stoppedAt": context.currentStep]
			if let characters { result["charactersSent"] = characters }
			let typed = characters.map { " \($0) character(s) of the text were sent first." } ?? ""
			return BridgeFailure(
				message: "Foreground input stopped after some input was sent: \(cause). Nothing more was sent.\(typed)\(activation)",
				code: "foreground_lost",
				effectPossible: true,
				result: result,
				details: details
			)
		}
		let waited = reason == "process_not_found" || reason == "no_destination" ? "" : " within \(Int(Self.foregroundAcquireBudget * 1000)) ms"
		return BridgeFailure(
			message: "No input was sent; the target did not come to the front\(waited): \(cause).\(activation)",
			code: "foreground_not_acquired",
			effectPossible: context.effectPossible,
			details: details
		)
	}

	private func confirmHIDDestination(_ gesture: HIDGesture, pid: Int32) throws {
		guard let context = activeRequestContext(), context.foregroundGrant else {
			throw foregroundRequired("HID event delivery requires a host foreground grant")
		}
		guard let destination = context.hidDestination, destination.pid == pid else {
			throw destinationFailure(pid: pid, context: context, reason: "no_destination", frontmostPid: currentFrontmostPid())
		}
		let sent = context.inputEventCount > destination.inputBaseline
		let deadline = Date().addingTimeInterval(sent ? 0 : Self.foregroundAcquireBudget)
		var activationRequested = false
		while true {
			try checkpoint()
			switch probeDestination(gesture, destination: destination, context: context) {
			case .confirmed(let windowVerified):
				if !windowVerified {
					context.destinationWindowStatus = "unverified"
				} else if context.destinationWindowStatus == nil {
					context.destinationWindowStatus = "verified"
				}
				context.lastDestinationCheck = Date()
				return
			case .gone:
				throw destinationFailure(pid: pid, context: context, reason: "process_not_found", frontmostPid: currentFrontmostPid())
			case .mismatch(let reason, let front):
				if Date() >= deadline { throw destinationFailure(pid: pid, context: context, reason: reason, frontmostPid: front) }
				if !activationRequested, reason == "app_not_frontmost", let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
					activationRequested = true
					context.markEffect()
					context.activationAttempted = true
					if #available(macOS 14.0, *) {
						_ = app.activate()
					} else {
						_ = app.activate(options: [.activateIgnoringOtherApps])
					}
				}
			}
			usleep(Self.foregroundPollMicros)
		}
	}

	func hidGesture(_ gesture: HIDGesture, pid: Int32, delivery: String, _ body: () throws -> Void) throws {
		guard delivery == "hid", let context = activeRequestContext() else { return try body() }
		if context.hidGestureActive { return try body() }
		try confirmHIDDestination(gesture, pid: pid)
		context.hidGestureActive = true
		defer { context.hidGestureActive = false }
		try body()
	}

	private func requireFrontmostForHIDPost(pid: Int32, context: RequestContext) throws {
		guard let destination = context.hidDestination, destination.pid == pid else {
			throw destinationFailure(pid: pid, context: context, reason: "no_destination", frontmostPid: currentFrontmostPid())
		}
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
			throw destinationFailure(pid: pid, context: context, reason: "process_not_found", frontmostPid: currentFrontmostPid())
		}
		let front = currentFrontmostPid()
		guard front == pid else {
			throw destinationFailure(pid: pid, context: context, reason: "app_not_frontmost", frontmostPid: front)
		}
	}

	func recheckHIDDestinationIfDue(pid: Int32, delivery: String) throws {
		guard delivery == "hid", let context = activeRequestContext() else { return }
		if let last = context.lastDestinationCheck, Date().timeIntervalSince(last) < Self.foregroundRecheckInterval { return }
		try confirmHIDDestination(.keyboard, pid: pid)
	}

}

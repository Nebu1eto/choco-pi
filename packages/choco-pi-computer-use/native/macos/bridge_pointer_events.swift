import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
	func restoringPointer(_ request: [String: Any], context: RequestContext?, _ body: () throws -> [String: Any]) throws -> [String: Any] {
		guard isGrantedHIDRequest(request), let context else { return try body() }
		let start = CGEvent(source: nil)?.location
		context.hidPointerLastPosted = nil
		do {
			var result = try body()
			if let report = restorePointer(start: start, context: context) {
				var performed = result["performed"] as? [String: Any] ?? [:]
				performed["pointerRestore"] = report
				result["performed"] = performed
			}
			return result
		} catch var failure as BridgeFailure {
			if let report = restorePointer(start: start, context: context) {
				var details = failure.details ?? [:]
				details["pointerRestore"] = report
				failure.details = details
			}
			throw failure
		} catch {
			_ = restorePointer(start: start, context: context)
			throw error
		}
	}

	private func restorePointer(start: CGPoint?, context: RequestContext) -> [String: Any]? {
		guard let last = context.hidPointerLastPosted else { return nil }
		context.hidPointerLastPosted = nil
		func point(_ value: CGPoint) -> [String: Any] { ["x": value.x, "y": value.y] }
		func near(_ first: CGPoint, _ second: CGPoint, _ tolerance: CGFloat) -> Bool { hypot(first.x - second.x, first.y - second.y) <= tolerance }
		var report: [String: Any] = ["lastPosted": point(last)]
		guard let start else {
			report["restored"] = false
			report["reason"] = "start_unknown"
			return report
		}
		report["start"] = point(start)
		var current = CGEvent(source: nil)?.location
		let settleUntil = monotonicSeconds() + 0.05
		while let now = current, !near(now, last, 1), monotonicSeconds() < settleUntil {
			usleep(5_000)
			current = CGEvent(source: nil)?.location
		}
		guard let now = current else {
			report["restored"] = false
			report["reason"] = "pointer_unreadable"
			return report
		}
		report["found"] = point(now)
		if !near(now, last, 1) {
			report["restored"] = false
			report["reason"] = "user_moved"
			return report
		}
		if near(now, start, 0.5) {
			report["restored"] = false
			report["reason"] = "not_moved"
			return report
		}
		CGWarpMouseCursorPosition(CGPoint(x: start.x.rounded(), y: start.y.rounded()))
		CGAssociateMouseAndMouseCursorPosition(1)
		let after = CGEvent(source: nil)?.location
		if let after { report["after"] = point(after) }
		let restored = after.map { near($0, start, 1) } ?? false
		report["restored"] = restored
		if !restored { report["reason"] = "warp_failed" }
		return report
	}

	func postMouseMove(to point: CGPoint, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try hidGesture(.pointer(point), pid: pid, delivery: delivery) {
			try checkpoint()
			guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
				throw BridgeFailure(message: "Failed to create mouse move event", code: "input_failed")
			}
			try postEvent(move, pid: pid, delivery: delivery)
		}
	}

	func mouseButton(_ name: String) -> CGMouseButton {
		switch name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "right":
			return .right
		case "middle", "center":
			return .center
		default:
			return .left
		}
	}

	private func mouseDownType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDown
		case .center:
			return .otherMouseDown
		default:
			return .leftMouseDown
		}
	}

	private func mouseUpType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseUp
		case .center:
			return .otherMouseUp
		default:
			return .leftMouseUp
		}
	}

	private func mouseDraggedType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDragged
		case .center:
			return .otherMouseDragged
		default:
			return .leftMouseDragged
		}
	}

	func postMouseClick(at point: CGPoint, pid: Int32, button: CGMouseButton = .left, clickCount: Int = 1, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try hidGesture(.pointer(point), pid: pid, delivery: delivery) {
			try postMouseMove(to: point, pid: pid, delivery: delivery)
			for index in 1...max(1, clickCount) {
				guard let down = CGEvent(mouseEventSource: nil, mouseType: mouseDownType(for: button), mouseCursorPosition: point, mouseButton: button),
					let up = CGEvent(mouseEventSource: nil, mouseType: mouseUpType(for: button), mouseCursorPosition: point, mouseButton: button)
				else {
					throw BridgeFailure(message: "Failed to create mouse click event", code: "input_failed")
				}
				down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
				up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
				try checkpoint()
				try postEvent(down, pid: pid, delivery: delivery)
				usleep(12_000)
				try postReleaseEvent(up, pid: pid, delivery: delivery)
				if index < clickCount {
					usleep(70_000)
				}
			}
		}
	}

	func postMouseDrag(points: [CGPoint], pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard points.count >= 2, let first = points.first else {
			throw BridgeFailure(message: "Drag requires at least two points", code: "invalid_args")
		}
		try hidGesture(.pointer(first), pid: pid, delivery: delivery) {
			try postMouseDragGesture(points: points, first: first, pid: pid, delivery: delivery)
		}
	}

	private func postMouseDragGesture(points: [CGPoint], first: CGPoint, pid: Int32, delivery: String) throws {
		try postMouseMove(to: first, pid: pid, delivery: delivery)
		guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: first, mouseButton: .left),
			let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: first, mouseButton: .left)
		else {
			throw BridgeFailure(message: "Failed to create mouse button event", code: "input_failed")
		}
		let moves = try points.dropFirst().map { point -> (point: CGPoint, event: CGEvent) in
			guard let drag = CGEvent(mouseEventSource: nil, mouseType: mouseDraggedType(for: .left), mouseCursorPosition: point, mouseButton: .left) else {
				throw BridgeFailure(message: "Failed to create mouse drag event", code: "input_failed")
			}
			return (point, drag)
		}
		try checkpoint()
		try postEvent(down, pid: pid, delivery: delivery)

		let context = activeRequestContext()
		var current = first
		var interrupted = false
		func releaseButton() throws {
			up.location = current
			try postReleaseEvent(up, pid: pid, delivery: delivery)
		}
		usleep(12_000)
		for move in moves {
			if context?.stopRequested == true { interrupted = true; break }
			do {
				try postEvent(move.event, pid: pid, delivery: delivery)
			} catch {
				try releaseButton()
				throw error
			}
			current = move.point
			usleep(8_000)
		}
		try releaseButton()
		if interrupted { try checkpoint() }
	}

	func postScrollWheel(at point: CGPoint, deltaX: Int, deltaY: Int, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try hidGesture(.pointer(point), pid: pid, delivery: delivery) {
			try postMouseMove(to: point, pid: pid, delivery: delivery)
			guard let event = CGEvent(
				scrollWheelEvent2Source: nil,
				units: .pixel,
				wheelCount: 2,
				wheel1: Int32(-deltaY),
				wheel2: Int32(deltaX),
				wheel3: 0
			) else {
				throw BridgeFailure(message: "Failed to create scroll event", code: "input_failed")
			}
			event.location = point
			try checkpoint()
			try postEvent(event, pid: pid, delivery: delivery)
		}
	}

}

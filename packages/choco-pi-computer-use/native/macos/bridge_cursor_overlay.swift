import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
	func agentCursorState(_ request: [String: Any]) throws -> [String: Any] {
		guard supportsAgentCursor else { return ["supported": false] }
		guard !Thread.isMainThread else {
			throw BridgeFailure(message: "agentCursorState must not run on the main thread", code: "invalid_state")
		}
		let semaphore = DispatchSemaphore(value: 0)
		let state = Box<(snapshot: AgentCursorRegistrySnapshot, displays: [[String: Any]], scales: [CGDirectDisplayID: Double])?>(nil)
		DispatchQueue.main.async {
			MainActor.assumeIsolated {
				defer { semaphore.signal() }
				var scales: [CGDirectDisplayID: Double] = [:]
				let displays = NSScreen.screens.compactMap { screen -> [String: Any]? in
					guard let id = DisplayGeometry.displayID(of: screen) else { return nil }
					scales[id] = Double(screen.backingScaleFactor)
					return [
						"id": Int(id),
						"bounds": rectPayload(CGDisplayBounds(id)),
						"frame": rectPayload(screen.frame),
						"scale": Double(screen.backingScaleFactor),
						"keyScreen": screen == NSScreen.main,
					]
				}
				state.value = (AgentCursor.shared.snapshot(), displays, scales)
			}
		}
		guard semaphore.wait(timeout: .now() + .seconds(3)) == .success, let current = state.value else {
			throw BridgeFailure(message: "The agent cursor state did not arrive from the main thread", code: "timeout")
		}
		let snapshot = current.snapshot
		let onscreen = onscreenWindowOrder()
		let own = Set(snapshot.cursors.map { $0.windowNumber })
		let captures = request["capture"] as? Bool == true ? captureCursorWindows(snapshot.cursors, scales: current.scales) : [:]
		func point(_ value: CGPoint) -> [String: Any] { ["x": value.x, "y": value.y] }
		var cursors: [[String: Any]] = []
		for cursor in snapshot.cursors {
			var entry: [String: Any] = [
				"session": cursor.key.session,
				"windowId": Int(cursor.key.windowId),
				"pid": Int(cursor.pid),
				"serial": cursor.serial,
				"paletteIndex": cursor.palette.index,
				"hueShift": cursor.palette.hueShift,
				"windowNumber": cursor.windowNumber,
				"visible": cursor.visible,
				"alpha": cursor.alpha,
				"fading": cursor.fading,
				"displayId": Int(cursor.display.id),
				"displayBounds": rectPayload(cursor.display.bounds),
				"frame": rectPayload(cursor.windowFrame),
				"windowOrigin": point(cursor.windowOrigin),
				"points": cursor.points.map(point),
				"target": point(cursor.target),
				"local": point(cursor.localTarget),
				"tip": point(cursor.tip),
				"tipLocal": point(cursor.tipLocal),
				"heading": cursor.heading,
				"animating": cursor.animating,
				"delivery": cursor.delivery,
				"createdAt": cursor.createdAt,
				"issuedAt": cursor.issuedAt,
				"drawnAt": cursor.drawnAt,
			]
			if let arrived = cursor.arrivedAt { entry["arrivedAt"] = arrived }
			if let index = onscreen.firstIndex(where: { $0.number == cursor.windowNumber }) {
				let mine = onscreen[index]
				entry["windowServerBounds"] = rectPayload(mine.bounds)
				entry["windowServerOnscreen"] = true
				entry["windowServerLayer"] = mine.layer
				if let below = onscreen[(index + 1)...].first(where: { !own.contains($0.number) }) {
					entry["windowBelow"] = below.number
					entry["windowBelowPid"] = Int(below.pid)
				}
			} else if let entryInfo = windowServerEntry(windowNumber: cursor.windowNumber) {
				entry["windowServerBounds"] = rectPayload(entryInfo.bounds)
				entry["windowServerOnscreen"] = entryInfo.onscreen
			}
			entry["targetOnscreen"] = cursor.key.windowId == 0 ? NSNull() : onscreen.contains { $0.number == Int(cursor.key.windowId) }
			if let capture = captures[cursor.windowNumber] { entry["capture"] = capture }
			cursors.append(entry)
		}
		var output: [String: Any] = [
			"supported": true,
			"displays": current.displays,
			"now": snapshot.now,
			"cursors": cursors,
			"maxCursors": AgentCursor.maxCursors,
			"windowSize": Double(AgentCursor.windowSize),
			"idleMs": Int(AgentCursor.idleSeconds * 1000),
			"fadeMs": Int(AgentCursor.fadeDuration * 1000),
			"staleAfterIssueMs": Int(AgentCursor.staleAfterIssue * 1000),
			"staleAfterActEndMs": Int(AgentCursor.staleAfterActEnd * 1000),
			"livenessMs": Int(AgentCursor.livenessInterval * 1000),
			"created": snapshot.created,
			"coalesced": snapshot.coalesced,
			"evicted": snapshot.evicted,
			"reorders": snapshot.reorders,
			"dropped": snapshot.dropped,
			"history": snapshot.history.map { event -> [String: Any] in
				var row: [String: Any] = ["kind": event.kind, "session": event.key.session, "windowId": Int(event.key.windowId), "at": event.at]
				if let reason = event.reason { row["reason"] = reason }
				if let serial = event.serial { row["serial"] = serial }
				if let issued = event.issuedAt { row["issuedAt"] = issued }
				return row
			},
		]
		let latest = snapshot.lastKey.flatMap { key in snapshot.cursors.first { $0.key == key } } ?? snapshot.cursors.last
		if let latest, let entry = cursors.first(where: { ($0["windowNumber"] as? Int) == latest.windowNumber }) {
			var overlay: [String: Any] = [
				"windowNumber": latest.windowNumber,
				"visible": latest.visible,
				"displayId": Int(latest.display.id),
				"displayBounds": rectPayload(latest.display.bounds),
				"frame": rectPayload(latest.windowFrame),
			]
			if let bounds = entry["windowServerBounds"] { overlay["windowServerBounds"] = bounds }
			if let onscreenFlag = entry["windowServerOnscreen"] { overlay["windowServerOnscreen"] = onscreenFlag }
			output["overlay"] = overlay
			output["pointer"] = ["animating": latest.animating, "target": point(latest.target), "local": point(latest.localTarget), "position": point(latest.tipLocal)]
			if let capture = captures[latest.windowNumber] { output["capture"] = capture }
		} else {
			output["overlay"] = NSNull()
			output["pointer"] = ["animating": false]
		}
		if let unplaced = snapshot.unplacedPoint { output["unplacedPoint"] = ["x": unplaced.x, "y": unplaced.y] }
		return output
	}

	private struct OnscreenWindow {
		let number: Int
		let pid: Int32
		let bounds: CGRect
		let layer: Int
	}

	private func onscreenWindowOrder() -> [OnscreenWindow] {
		guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
		return list.compactMap { info in
			guard let number = (info[kCGWindowNumber as String] as? NSNumber)?.intValue else { return nil }
			var bounds = CGRect.null
			if let raw = info[kCGWindowBounds as String] as? NSDictionary, let parsed = CGRect(dictionaryRepresentation: raw as CFDictionary) { bounds = parsed }
			return OnscreenWindow(
				number: number,
				pid: (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0,
				bounds: bounds,
				layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			)
		}
	}

	private func windowServerEntry(windowNumber: Int) -> (bounds: CGRect, onscreen: Bool)? {
		guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowNumber)) as? [[String: Any]],
			let info = list.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == windowNumber }),
			let raw = info[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary)
		else { return nil }
		return (bounds, (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
	}

	private func captureCursorWindows(_ cursors: [AgentCursorSnapshot], scales: [CGDirectDisplayID: Double]) -> [Int: [String: Any]] {
		guard !cursors.isEmpty else { return [:] }
		let semaphore = DispatchSemaphore(value: 0)
		let images = Box<[Int: (image: CGImage, frame: CGRect)]>([:])
		let failure = Box<String?>(nil)
		let task = Task {
			defer { semaphore.signal() }
			do {
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
				var captured: [Int: (image: CGImage, frame: CGRect)] = [:]
				for cursor in cursors {
					guard let window = shareable.windows.first(where: { Int($0.windowID) == cursor.windowNumber }) else { continue }
					let scale = scales[cursor.display.id] ?? 2
					let config = SCStreamConfiguration()
					config.width = max(1, Int((window.frame.width * scale).rounded()))
					config.height = max(1, Int((window.frame.height * scale).rounded()))
					config.showsCursor = false
					config.ignoreShadowsSingleWindow = true
					let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
					captured[cursor.windowNumber] = (image, window.frame)
				}
				images.value = captured
			} catch {
				failure.value = error.localizedDescription
			}
		}
		if semaphore.wait(timeout: .now() + .seconds(5)) == .timedOut {
			task.cancel()
			return Dictionary(uniqueKeysWithValues: cursors.map { ($0.windowNumber, ["error": "capture timed out"]) })
		}
		var output: [Int: [String: Any]] = [:]
		for cursor in cursors {
			if let message = failure.value { output[cursor.windowNumber] = ["error": message]; continue }
			guard let captured = images.value[cursor.windowNumber] else {
				output[cursor.windowNumber] = ["error": "the cursor window is not capturable"]
				continue
			}
			output[cursor.windowNumber] = cursorPixels(captured.image, windowBounds: windowServerEntry(windowNumber: cursor.windowNumber)?.bounds ?? captured.frame, cursor: cursor)
		}
		return output
	}

	private func cursorPixels(_ image: CGImage, windowBounds: CGRect, cursor: AgentCursorSnapshot) -> [String: Any] {
		let width = image.width
		let height = image.height
		var bytes = [UInt8](repeating: 0, count: width * height * 4)
		let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
			guard let context = CGContext(
				data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
				space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
			) else { return false }
			context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
			return true
		}
		guard drawn, windowBounds.width > 0 else { return ["error": "could not read the captured pixels"] }
		let pixelsPerPoint = Double(width) / Double(windowBounds.width)
		var output: [String: Any] = ["width": width, "height": height, "pixelsPerPoint": pixelsPerPoint, "windowBounds": rectPayload(windowBounds)]
		guard let located = AgentCursorPixels.locateTip(rgba: bytes, width: width, height: height, pixelsPerPoint: pixelsPerPoint, heading: cursor.heading) else {
			output["opaquePixels"] = 0
			output["bounds"] = NSNull()
			return output
		}
		let display = cursor.display.bounds
		let tip = CGPoint(x: windowBounds.minX + located.tip.x, y: windowBounds.minY + located.tip.y)
		output["opaquePixels"] = located.opaquePixels
		output["strokePixels"] = located.strokePixels
		output["tipWindow"] = ["x": located.tip.x, "y": located.tip.y]
		output["tip"] = ["x": tip.x, "y": tip.y]
		output["tipLocal"] = ["x": tip.x - display.minX, "y": tip.y - display.minY]
		if let body = located.bounds {
			output["bounds"] = rectPayload(CGRect(x: windowBounds.minX + body.minX - display.minX, y: windowBounds.minY + body.minY - display.minY, width: body.width, height: body.height))
		} else {
			output["bounds"] = NSNull()
		}
		return output
	}

}

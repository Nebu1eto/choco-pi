import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
	struct PointerProbe {
		let pid: Int32
		let point: CGPoint
		let baselineCg: Set<UInt32>
		let hit: AXUIElement?
		let probe: AXUIElement?
		let value: String?
		let selected: String?
		let frame: CGRect?
		let scroll: String?
		let focused: AXUIElement?
	}

	func capturePointerProbe(pid: Int32, element: AXUIElement?, point: CGPoint) -> PointerProbe {
		let hit = hitTestElement(at: point)
		let probe = element ?? hit.flatMap { pidForElement($0) == pid ? $0 : nil }
		return PointerProbe(
			pid: pid,
			point: point,
			baselineCg: cgRootSignature(pid: pid),
			hit: hit,
			probe: probe,
			value: probe.flatMap { stringAttribute($0, attribute: kAXValueAttribute as CFString) },
			selected: probe.flatMap { stringAttribute($0, attribute: kAXSelectedTextAttribute as CFString) },
			frame: probe.flatMap { frameForElement($0) },
			scroll: probe.flatMap { scrollAreaSignature(from: $0) },
			focused: appFocusedElement(pid: pid)
		)
	}

	func pointerProbeChanged(_ base: PointerProbe, ignoreFocusedElement: Bool = false) -> Bool {
		if let probe = base.probe {
			if stringAttribute(probe, attribute: kAXValueAttribute as CFString) != base.value { return true }
			if stringAttribute(probe, attribute: kAXSelectedTextAttribute as CFString) != base.selected { return true }
			if frameForElement(probe) != base.frame { return true }
			if scrollAreaSignature(from: probe) != base.scroll { return true }
		}
		let hitNow = hitTestElement(at: base.point)
		if !optionalSameElement(base.hit, hitNow), hitNow.flatMap({ pidForElement($0) }) == base.pid { return true }
		if ignoreFocusedElement { return false }
		return !optionalSameElement(base.focused, appFocusedElement(pid: base.pid))
	}

	static let pointerSettleBudget: TimeInterval = 0.4
	static let pixelCaptureTimeout: TimeInterval = 0.12
	private static let pixelBaselineTimeout: TimeInterval = 0.25
	private static let pixelSampleMaxDimension: Double = 320
	private static let pixelChannelThreshold = 24
	private static let pixelChangedSamplesRequired = 2
	static let pixelTargetMargin: CGFloat = 8
	private static let pixelPointRadius: CGFloat = 32

	struct SettledAttempt {
		let changed: Bool
		let elsewhere: Bool
		let evidence: [String: Any]
	}

	private static func pointNeighborhood(_ point: CGPoint) -> CGRect {
		CGRect(x: point.x - pixelPointRadius, y: point.y - pixelPointRadius, width: 2 * pixelPointRadius, height: 2 * pixelPointRadius)
	}

	static func pathNeighborhoods(_ points: [CGPoint]) -> [CGRect] {
		guard let first = points.first else { return [] }
		var rects = [pointNeighborhood(first)]
		for (start, end) in zip(points, points.dropFirst()) {
			let distance = hypot(end.x - start.x, end.y - start.y)
			let steps = max(1, min(256, Int((distance / pixelPointRadius).rounded(.up))))
			for step in 1...steps {
				let fraction = CGFloat(step) / CGFloat(steps)
				rects.append(pointNeighborhood(CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)))
			}
			if rects.count >= 1024 { break }
		}
		return rects
	}

	struct PixelRegion {
		let minX: Int
		let minY: Int
		let maxX: Int
		let maxY: Int

		func contains(column: Int, row: Int) -> Bool {
			column >= minX && column < maxX && row >= minY && row < maxY
		}
	}

	struct PixelMask {
		let parts: [PixelRegion]

		func contains(column: Int, row: Int) -> Bool {
			parts.contains { $0.contains(column: column, row: row) }
		}
	}

	func pixelMask(_ probe: PixelProbe, covering rects: [CGRect]) -> PixelMask? {
		let parts = rects.compactMap { pixelRegion(probe, covering: $0) }
		return parts.isEmpty ? nil : PixelMask(parts: parts)
	}

	private func pixelRegion(_ probe: PixelProbe, covering rect: CGRect) -> PixelRegion? {
		let frame = probe.windowFrame
		guard frame.width > 0, frame.height > 0 else { return nil }
		let clamped = rect.intersection(frame)
		guard !clamped.isNull, !clamped.isEmpty else { return nil }
		let scaleX = Double(probe.config.width) / Double(frame.width)
		let scaleY = Double(probe.config.height) / Double(frame.height)
		let region = PixelRegion(
			minX: max(0, Int((Double(clamped.minX - frame.minX) * scaleX).rounded(.down))),
			minY: max(0, Int((Double(clamped.minY - frame.minY) * scaleY).rounded(.down))),
			maxX: min(probe.config.width, Int((Double(clamped.maxX - frame.minX) * scaleX).rounded(.up))),
			maxY: min(probe.config.height, Int((Double(clamped.maxY - frame.minY) * scaleY).rounded(.up)))
		)
		return region.maxX > region.minX && region.maxY > region.minY ? region : nil
	}

	struct PixelSnapshot {
		let width: Int
		let height: Int
		let bytes: [UInt8]
	}

	struct PixelProbe {
		let filter: SCContentFilter
		let config: SCStreamConfiguration
		let windowFrame: CGRect
		let baseline: PixelSnapshot
	}

	func startPixelProbe(windowId: UInt32) throws -> PixelProbe? {
		guard CGPreflightScreenCaptureAccess() else { return nil }
		try checkpoint()
		let semaphore = DispatchSemaphore(value: 0)
		let found = Box<SCWindow?>(nil)
		SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { shareable, _ in
			found.value = shareable?.windows.first { $0.windowID == windowId }
			semaphore.signal()
		}
		let waited = semaphore.wait(timeout: .now() + Self.pixelBaselineTimeout)
		try checkpoint()
		guard waited == .success, let window = found.value else { return nil }
		let longest = max(window.frame.width, window.frame.height)
		guard longest >= 1 else { return nil }
		let scale = min(1, Self.pixelSampleMaxDimension / Double(longest))
		let config = SCStreamConfiguration()
		config.width = max(1, Int((Double(window.frame.width) * scale).rounded()))
		config.height = max(1, Int((Double(window.frame.height) * scale).rounded()))
		config.showsCursor = false
		config.ignoreShadowsSingleWindow = true
		let filter = SCContentFilter(desktopIndependentWindow: window)
		let pending = PixelProbe(filter: filter, config: config, windowFrame: window.frame, baseline: PixelSnapshot(width: 0, height: 0, bytes: []))
		let captured = capturePixelSnapshot(pending, timeout: Self.pixelBaselineTimeout)
		try checkpoint()
		guard let baseline = captured else { return nil }
		return PixelProbe(filter: filter, config: config, windowFrame: window.frame, baseline: baseline)
	}

	func capturePixelSnapshot(_ probe: PixelProbe, timeout: TimeInterval) -> PixelSnapshot? {
		let semaphore = DispatchSemaphore(value: 0)
		let captured = Box<CGImage?>(nil)
		SCScreenshotManager.captureImage(contentFilter: probe.filter, configuration: probe.config) { image, _ in
			captured.value = image
			semaphore.signal()
		}
		guard semaphore.wait(timeout: .now() + timeout) == .success, let image = captured.value else { return nil }
		let width = probe.config.width
		let height = probe.config.height
		guard width > 0, height > 0,
			let space = CGColorSpace(name: CGColorSpace.sRGB),
			let bitmap = CGContext(
				data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
				space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
			)
		else { return nil }
		bitmap.interpolationQuality = .low
		bitmap.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
		guard let data = bitmap.data else { return nil }
		let bytes = Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: width * height * 4))
		return PixelSnapshot(width: width, height: height, bytes: bytes)
	}

	func pixelChanges(_ lhs: PixelSnapshot, _ rhs: PixelSnapshot, region: PixelMask?) -> (target: Bool, elsewhere: Bool) {
		guard lhs.width == rhs.width, lhs.height == rhs.height, lhs.bytes.count == rhs.bytes.count, lhs.width > 0 else { return (false, true) }
		var inside = 0
		var outside = 0
		let required = Self.pixelChangedSamplesRequired
		let count = min(lhs.bytes.count, lhs.width * lhs.height * 4)
		var index = 0
		while index + 3 < count {
			var changed = false
			for channel in 0..<3 where abs(Int(lhs.bytes[index + channel]) - Int(rhs.bytes[index + channel])) > Self.pixelChannelThreshold {
				changed = true
				break
			}
			if changed {
				let sample = index / 4
				if region?.contains(column: sample % lhs.width, row: sample / lhs.width) == true { inside += 1 } else { outside += 1 }
				if inside >= required && outside >= required { break }
			}
			index += 4
		}
		return (inside >= required, outside >= required)
	}

	func appFocusedElement(pid: Int32) -> AXUIElement? {
		let app = AXUIElementCreateApplication(pid)
		return copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
	}

	private func optionalSameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
		switch (lhs, rhs) {
		case (nil, nil): return true
		case let (left?, right?): return sameElement(left, right)
		default: return false
		}
	}

	private func scrollAreaSignature(from element: AXUIElement) -> String? {
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 12 {
			if stringAttribute(candidate, attribute: kAXRoleAttribute as CFString) == "AXScrollArea" {
				return ["AXVerticalScrollBar", "AXHorizontalScrollBar"].map { name -> String in
					guard let bar = copyAttribute(candidate, attribute: name as CFString).flatMap(asAXElement),
						let value = copyAttribute(bar, attribute: kAXValueAttribute as CFString)
					else { return "-" }
					return String(describing: value)
				}.joined(separator: "|")
			}
			current = parentElement(candidate)
			depth += 1
		}
		return nil
	}

}

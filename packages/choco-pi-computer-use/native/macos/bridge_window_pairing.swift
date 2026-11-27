import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct CGWindowCandidate {
	let windowId: UInt32
	let title: String
	let bounds: CGRect
	let isOnscreen: Bool
	let layer: Int
	let zOrder: Int
}

struct CGWindowOwnerSummary {
	let pid: Int32
	let name: String
}

struct WindowPairing {
	let candidate: CGWindowCandidate?
	let score: Double
	let confidence: String
}

extension Bridge {
	func allCGWindowEntries() -> [[String: Any]] {
		(CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
	}

	func cgWindowOwners(entries suppliedEntries: [[String: Any]]? = nil) -> [CGWindowOwnerSummary] {
		let entries = suppliedEntries ?? allCGWindowEntries()
		var seen = Set<Int32>()
		var owners: [CGWindowOwnerSummary] = []
		for entry in entries {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != 0 || seen.contains(ownerPid) { continue }
			guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
				bounds.width >= 100,
				bounds.height >= 80
			else {
				continue
			}
			let ownerName = (entry[kCGWindowOwnerName as String] as? String) ?? processName(pid: ownerPid) ?? "Unknown App"
			seen.insert(ownerPid)
			owners.append(CGWindowOwnerSummary(pid: ownerPid, name: ownerName))
		}
		return owners
	}

	func pidForWindowId(_ windowId: UInt32) -> Int32? {
		windowInfo(windowId: windowId)?.pid
	}

	func cgWindowCandidates(pid: Int32, entries suppliedEntries: [[String: Any]]? = nil) -> [CGWindowCandidate] {
		let entries = suppliedEntries ?? allCGWindowEntries()
		var candidates: [CGWindowCandidate] = []
		for (zOrder, entry) in entries.enumerated() {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
				ownerPid == pid
			else {
				continue
			}
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != 0 { continue }

			guard let windowNumber = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else {
				continue
			}
			guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
			else {
				continue
			}

			let title = (entry[kCGWindowName as String] as? String) ?? ""
			let isOnscreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
			candidates.append(
				CGWindowCandidate(
					windowId: windowNumber,
					title: title,
					bounds: bounds,
					isOnscreen: isOnscreen,
					layer: layer,
					zOrder: zOrder
				)
			)
			if candidates.count == 128 { break }
		}
		return candidates
	}

	func cgBroadRootOwners(entries: [[String: Any]]) -> [CGWindowOwnerSummary] {
		let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
		var seen = Set<Int32>()
		return entries.compactMap { entry -> CGWindowOwnerSummary? in
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			guard layer == 0 || layer == popupLevel,
				let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
			else { return nil }
			if layer == popupLevel {
				guard (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true else { return nil }
			} else {
				guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
					let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
					bounds.width >= 100,
					bounds.height >= 80
				else { return nil }
			}
			guard seen.insert(pid).inserted else { return nil }
			let name = (entry[kCGWindowOwnerName as String] as? String) ?? processName(pid: pid) ?? "Unknown App"
			return CGWindowOwnerSummary(pid: pid, name: name)
		}
	}

	func cgPopupMenuCandidates(pid: Int32?, entries: [[String: Any]]) -> [CGWindowCandidate] {
		let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
		var candidates: [CGWindowCandidate] = []
		for (zOrder, entry) in entries.enumerated() {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
			if let pid, ownerPid != pid { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			if layer != popupLevel { continue }
			guard let windowNumber = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
				let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
			else { continue }
			let title = (entry[kCGWindowName as String] as? String) ?? ""
			let isOnscreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
			guard isOnscreen else { continue }
			candidates.append(CGWindowCandidate(windowId: windowNumber, title: title, bounds: bounds, isOnscreen: isOnscreen, layer: layer, zOrder: zOrder))
			if candidates.count == 128 { break }
		}
		return candidates
	}

	func openMenuElements(pid: Int32, messagingTimeout: Float = 1.0) -> [AXUIElement] {
		let app = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(app, messagingTimeout)
		let descendants = collectDescendants(startingAt: app, maxDepth: 6)
		var menus = descendants.filter { (stringAttribute($0, attribute: kAXRoleAttribute as CFString) ?? "") == "AXMenu" }
		if menus.isEmpty,
			let focused = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		{
			var current: AXUIElement? = focused
			while let element = current {
				if (stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? "") == "AXMenu" {
					menus.append(element)
					break
				}
				current = copyAttribute(element, attribute: kAXParentAttribute as CFString).flatMap(asAXElement)
			}
		}
		return menus
	}

	func bestCandidate(for element: AXUIElement, candidates: [CGWindowCandidate]) -> CGWindowCandidate? {
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let frame = frameForWindow(element)
		return candidates.max { left, right in
			windowPairScore(frame: frame, title: title, candidate: left) < windowPairScore(frame: frame, title: title, candidate: right)
		}
	}

	func pairingForWindow(_ window: AXUIElement, pid: Int32) -> WindowPairing {
		windowPairings(windows: [window], candidates: cgWindowCandidates(pid: pid))[ObjectIdentifier(window)] ?? WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
	}

	func windowPairings(windows: [AXUIElement], candidates: [CGWindowCandidate]) -> [ObjectIdentifier: WindowPairing] {
		var pairs: [(window: AXUIElement, candidate: CGWindowCandidate, score: Double)] = []
		for window in windows {
			let title = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			let frame = frameForWindow(window)
			for candidate in candidates {
				pairs.append((window, candidate, windowPairScore(frame: frame, title: title, candidate: candidate)))
			}
		}
		pairs.sort { $0.score > $1.score }
		var output: [ObjectIdentifier: WindowPairing] = [:]
		var usedWindows = Set<ObjectIdentifier>()
		var usedCandidateIds = Set<UInt32>()
		for pair in pairs {
			let key = ObjectIdentifier(pair.window)
			if usedWindows.contains(key) || usedCandidateIds.contains(pair.candidate.windowId) { continue }
			usedWindows.insert(key)
			usedCandidateIds.insert(pair.candidate.windowId)
			let frame = frameForWindow(pair.window)
			let title = stringAttribute(pair.window, attribute: kAXTitleAttribute as CFString) ?? ""
			output[key] = WindowPairing(candidate: pair.score >= 0 ? pair.candidate : nil, score: pair.score, confidence: pairingConfidence(frame: frame, title: title, candidate: pair.candidate, score: pair.score))
		}
		for window in windows {
			let key = ObjectIdentifier(window)
			if output[key] == nil {
				output[key] = WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
			}
		}
		return output
	}

	private func windowPairScore(frame: CGRect, title: String, candidate: CGWindowCandidate) -> Double {
		var score = 0.0
		let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if !normalizedTitle.isEmpty && !candidateTitle.isEmpty {
			if normalizedTitle == candidateTitle {
				score += 100
			} else if normalizedTitle.contains(candidateTitle) || candidateTitle.contains(normalizedTitle) {
				score += 50
			}
		}
		if frame.width > 1 && frame.height > 1 {
			let dx = abs(candidate.bounds.origin.x - frame.origin.x)
			let dy = abs(candidate.bounds.origin.y - frame.origin.y)
			let dw = abs(candidate.bounds.size.width - frame.size.width)
			let dh = abs(candidate.bounds.size.height - frame.size.height)
			score -= Double(dx + dy + dw + dh) / 20.0
		}
		if candidate.isOnscreen { score += 10 }
		return score
	}

	private func pairingConfidence(frame: CGRect, title: String, candidate: CGWindowCandidate, score: Double) -> String {
		guard frame.width > 1 && frame.height > 1 else { return "low" }
		let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let candidateTitle = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let titleEqual = !normalizedTitle.isEmpty && !candidateTitle.isEmpty && normalizedTitle == candidateTitle
		let geometryExact = abs(frame.origin.x - candidate.bounds.origin.x) <= 2 && abs(frame.origin.y - candidate.bounds.origin.y) <= 2 && abs(frame.width - candidate.bounds.width) <= 2 && abs(frame.height - candidate.bounds.height) <= 2
		if titleEqual && geometryExact { return "exact" }
		if score >= 50 { return "high" }
		return "low"
	}

	func displayScaleFactor(for frame: CGRect) -> Double {
		var displayCount: UInt32 = 0
		var displays: [CGDirectDisplayID] = []
		if CGGetOnlineDisplayList(0, nil, &displayCount) == .success, displayCount > 0 {
			var listed = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
			if CGGetOnlineDisplayList(displayCount, &listed, &displayCount) == .success {
				displays = Array(listed.prefix(Int(displayCount)))
			}
		}
		let chosen = DisplayGeometry.bestDisplayIndex(for: frame, among: displays.map { CGDisplayBounds($0) })
			.map { displays[$0] } ?? CGMainDisplayID()
		return displayModeScale(chosen) ?? displayModeScale(CGMainDisplayID()) ?? 1.0
	}

	private func displayModeScale(_ display: CGDirectDisplayID) -> Double? {
		guard let mode = CGDisplayCopyDisplayMode(display) else { return nil }
		let width = Double(mode.width)
		guard width > 0 else { return nil }
		let scale = Double(mode.pixelWidth) / width
		return scale > 0 ? scale : nil
	}

}

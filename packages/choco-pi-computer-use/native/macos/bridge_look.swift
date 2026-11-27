import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct LookRecord {
	let lookId: String
	let windowId: UInt32
	let windowFrame: CGRect
	let imageWidth: Int
	let imageHeight: Int
	let hasImage: Bool
	let rootElement: AXUIElement?
	let observedFrame: CGRect?
	var sessionId: String? = currentRequestSessionId()
	var sessionGeneration: Int? = currentRequestSessionGeneration()
}

extension Bridge {
	func look(_ request: [String: Any]) throws -> [String: Any] {
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		let maxDimension = optionalIntArg(request, "maxDimension").map { max(1, $0) }
		let readText = optionalStringArg(request, "readText") ?? "auto"
		let baseLookId = optionalStringArg(request, "baseLookId")
		let includeImage = boolArg(request, "includeImage") ?? true
		guard readText == "auto" || readText == "always" || readText == "never" else {
			throw BridgeFailure(message: "readText must be auto, always, or never", code: "invalid_args")
		}

		let requestedRoot = windowRef.flatMap { refStore.window(for: $0) }
		let requestedRole = requestedRoot.flatMap { stringAttribute($0, attribute: kAXRoleAttribute as CFString) } ?? ""
		let isMenuRoot = requestedRole == "AXMenu" || (windowRef?.hasPrefix("cgmenu:") == true)
		let pid: Int32
		if let windowId, let ownerPid = pidForWindowId(windowId) {
			pid = ownerPid
		} else if let requestedRoot, let owner = pidForElement(requestedRoot) {
			pid = owner
		} else {
			throw BridgeFailure(message: "Root is not owned by a running app", code: "root_not_found")
		}
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request)
		var offSpaceWindow: AXUIElement?
		var offSpaceInfo: [String: Any]?
		if let windowId, !isMenuRoot, OffSpaceSupport.shared.isOffSpace(windowId) {
			if let requestedRoot, pidForElement(requestedRoot) == pid, stringAttribute(requestedRoot, attribute: kAXRoleAttribute as CFString) != nil {
				offSpaceWindow = requestedRoot
				offSpaceInfo = ["discoveryActivation": false, "resolvedBy": "ref"]
			} else if let cached = cachedOffSpaceWindow(pid: pid, windowId: windowId) {
				offSpaceWindow = cached
				offSpaceInfo = ["discoveryActivation": false, "resolvedBy": "cache"]
			} else if let listed = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) {
				offSpaceWindow = listed
				offSpaceInfo = ["discoveryActivation": false, "resolvedBy": "ax_windows"]
			} else {
				let resolved = try offSpaceLookWindow(pid: pid, windowId: windowId, request: request)
				offSpaceWindow = resolved.element
				offSpaceInfo = resolved.info
			}
		}
		let captureStart = Date()
		let shouldCapture = !isMenuRoot && (includeImage || readText == "always")
		let capture = try shouldCapture ? windowId.map { try captureWindow(windowId: $0) } : nil
		let captureMs = capture.map { _ in elapsedMs(captureStart) } ?? 0

		ensureEnhancedAccessibility(pid: pid)
		if let windowRef, windowRef.hasPrefix("cgmenu:"), refStore.window(for: windowRef) == nil {
			let frame = windowId.flatMap { windowInfo(windowId: $0)?.bounds } ?? CGRect(x: 0, y: 0, width: 1, height: 1)
			let lookId = freshLookId()
			storeLookRecord(LookRecord(lookId: lookId, windowId: windowId ?? 0, windowFrame: frame, imageWidth: max(1, Int(frame.width)), imageHeight: max(1, Int(frame.height)), hasImage: false, rootElement: nil, observedFrame: nil))
			let outline = LookNode(element: nil, ref: windowRef, role: "AXMenu", subrole: "", identifier: "", title: "Menu", description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: CGRect(x: 0, y: 0, width: max(1, frame.width), height: max(1, frame.height)), pictureOnly: true)
			return [
				"lookId": lookId,
				"capturedAt": captureStart.timeIntervalSince1970,
				"window": ["windowId": Int(windowId ?? 0), "rootRef": windowRef, "kind": "menu", "framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height], "scaleFactor": displayScaleFactor(for: frame), "isModal": false, "metadata": ["pairing": ["confidence": "low", "score": 0], "sheetCount": 0], "role": "AXMenu", "subrole": ""],
				"outline": outline.payload(),
				"timings": ["captureMs": 0, "describeMs": 0, "readTextMs": 0],
			]
		}
		guard let window = offSpaceWindow ?? windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			throw BridgeFailure(message: "Root is not available through Accessibility", code: "root_not_found")
		}
		let rootElement: AXUIElement
		if let scopeRef = optionalStringArg(request, "scopeRef") {
			guard let scoped = refStore.element(for: scopeRef), isElement(scoped, descendantOf: window) else {
				throw BridgeFailure(message: "Scope ref is stale or outside the target root", code: "element_ref_invalid")
			}
			rootElement = scoped
		} else {
			rootElement = window
		}

		let rootFrame = frameForWindow(window)
		let imageWidth: Int
		let imageHeight: Int
		let imagePayload: [String: Any]?
		let transform: (CGRect) -> CGRect
		if let capture {
			let outputImage = downscaledImage(capture.image, maxDimension: maxDimension) ?? capture.image
			imageWidth = outputImage.width
			imageHeight = outputImage.height
			transform = rectTransform(windowFrame: capture.frame, imageWidth: outputImage.width, imageHeight: outputImage.height)
			if includeImage {
				guard let jpeg = jpegData(image: outputImage, quality: 0.8) else {
					throw BridgeFailure(message: "Failed to encode look image as JPEG", code: "encoding_failed")
				}
				imagePayload = ["jpegBase64": jpeg.base64EncodedString(), "width": outputImage.width, "height": outputImage.height]
			} else {
				imagePayload = nil
			}
		} else {
			imageWidth = max(1, Int(rootFrame.width))
			imageHeight = max(1, Int(rootFrame.height))
			imagePayload = nil
			transform = rectTransform(windowFrame: rootFrame, imageWidth: imageWidth, imageHeight: imageHeight)
		}
		let describeStart = Date()
		let outline = buildLookOutline(root: rootElement, transform: transform)
		let describeMs = elapsedMs(describeStart)

		var readTextMs = 0
		var readTextExecuted = false
		if let capture, readText == "always" {
			readTextExecuted = true
			let textStart = Date()
			let boxes = try recognizeText(in: capture.image, outputWidth: imageWidth, outputHeight: imageHeight)
			attachOCR(boxes, to: outline)
			readTextMs = elapsedMs(textStart)
		}

		let lookId = freshLookId()
		let baseRecord = try baseLookId.flatMap { try lookRecord(for: $0) }
		let observedFrame: CGRect? = baseRecord != nil ? baseRecord?.observedFrame : frameForElement(window)
		storeLookRecord(LookRecord(
			lookId: lookId,
			windowId: windowId ?? baseRecord?.windowId ?? 0,
			windowFrame: baseRecord?.windowFrame ?? capture?.frame ?? rootFrame,
			imageWidth: baseRecord?.imageWidth ?? imageWidth,
			imageHeight: baseRecord?.imageHeight ?? imageHeight,
			hasImage: baseRecord?.hasImage ?? (capture != nil),
			rootElement: baseRecord?.rootElement ?? window,
			observedFrame: observedFrame
		))
		let scale = (capture?.frame.width ?? rootFrame.width) > 0 ? Double(imageWidth) / (capture?.frame.width ?? rootFrame.width) : displayScaleFactor(for: rootFrame)
		let pairing = pairingForWindow(window, pid: pid)
		let role = stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? ""
		let sheetCount = sheetElements(of: window).count
		var response: [String: Any] = [
			"lookId": lookId,
			"capturedAt": captureStart.timeIntervalSince1970,
			"window": [
				"windowId": Int(windowId ?? 0),
				"rootRef": windowRef ?? refStore.storeWindow(window),
				"kind": rootKind(role: role, subrole: subrole),
				"framePoints": ["x": (capture?.frame ?? rootFrame).origin.x, "y": (capture?.frame ?? rootFrame).origin.y, "w": (capture?.frame ?? rootFrame).width, "h": (capture?.frame ?? rootFrame).height],
				"scaleFactor": scale,
				"isModal": (boolAttribute(window, attribute: "AXModal" as CFString) ?? false) || sheetCount > 0 || isDialogLikeRoot(role: role, subrole: subrole),
				"metadata": rootMetadata(pairing: pairing, sheetCount: sheetCount),
				"role": role,
				"subrole": subrole,
			],
			"outline": outline.payload(),
			"timings": ["captureMs": captureMs, "describeMs": describeMs, "readTextMs": readTextMs],
			"readText": ["requested": readText, "executed": readTextExecuted],
		]
		if let imagePayload { response["image"] = imagePayload }
		if let offSpaceInfo { response["offSpace"] = offSpaceInfo }
		return response
	}

	private func elapsedMs(_ start: Date) -> Int {
		max(0, Int(Date().timeIntervalSince(start) * 1000.0))
	}

	private func storeLookRecord(_ record: LookRecord) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		if let id = record.sessionId, let known = lookRetention[id], (record.sessionGeneration ?? 0) < known.generation { return }
		lookRecords[record.lookId] = record
		lookRecordOrder.append(record.lookId)
		let sameOwner = lookRecordOrder.filter { lookRecords[$0]?.sessionId == record.sessionId }
		if sameOwner.count > looksPerSession {
			let evicted = Set(sameOwner.prefix(sameOwner.count - looksPerSession))
			lookRecordOrder.removeAll { evicted.contains($0) }
			for id in evicted { lookRecords.removeValue(forKey: id) }
		}
		let holders = Set(lookRecords.values.compactMap { $0.sessionId })
		if holders.count > maxLookSessions {
			let candidates = holders.filter { $0 != record.sessionId }
				.sorted { (lookRetention[$0]?.lastUsed ?? 0) < (lookRetention[$1]?.lastUsed ?? 0) }
			for id in candidates.prefix(holders.count - maxLookSessions) { dropLookRecordsLocked(sessionId: id) }
		}
	}

	func dropLookRecords(sessionId: String) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		dropLookRecordsLocked(sessionId: sessionId)
	}

	private func dropLookRecordsLocked(sessionId: String) {
		let dropped = Set(lookRecordOrder.filter { lookRecords[$0]?.sessionId == sessionId })
		lookRecordOrder.removeAll { dropped.contains($0) }
		for id in dropped { lookRecords.removeValue(forKey: id) }
		lookRetention.removeValue(forKey: sessionId)
	}

	func requestClientPid(_ request: [String: Any]) -> Int32? {
		let blocklist = (request["appBlocklist"] as? [String: Any])
			?? ((request["actions"] as? [[String: Any]])?.first?["appBlocklist"] as? [String: Any])
		guard let pid = (blocklist?["clientPid"] as? NSNumber)?.int32Value, pid > 0 else { return nil }
		return pid
	}

	func noteLookSession(_ session: (id: String, generation: Int), clientPid: Int32?) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		let now = monotonicSeconds()
		guard var entry = lookRetention[session.id] else {
			let stale = Set(lookRecordOrder.filter { lookRecords[$0]?.sessionId == session.id && lookRecords[$0]?.sessionGeneration != session.generation })
			if !stale.isEmpty {
				lookRecordOrder.removeAll { stale.contains($0) }
				for id in stale { lookRecords.removeValue(forKey: id) }
			}
			lookRetention[session.id] = LookRetention(generation: session.generation, lastUsed: now, clientPid: clientPid)
			return
		}
		if session.generation < entry.generation { return }
		if session.generation > entry.generation {
			dropLookRecordsLocked(sessionId: session.id)
			entry = LookRetention(generation: session.generation, lastUsed: now, clientPid: nil)
		}
		entry.lastUsed = now
		if let clientPid { entry.clientPid = clientPid }
		lookRetention[session.id] = entry
	}

	func sweepLookRetention() {
		let now = monotonicSeconds()
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		guard now - lastLookRetentionSweep >= lookRetentionSweepInterval else { return }
		lastLookRetentionSweep = now
		let holders = Set(lookRecords.values.compactMap { $0.sessionId })
		let gone = lookRetention.filter { id, entry in
			guard now - entry.lastUsed >= ownerTTL else { return false }
			if !holders.contains(id) { return true }
			if let pid = entry.clientPid { return !processExists(pid) }
			return now - entry.lastUsed >= lookRetentionWithoutClient
		}.map { $0.key }
		for id in gone { dropLookRecordsLocked(sessionId: id) }
	}

	private func processExists(_ pid: Int32) -> Bool {
		if kill(pid, 0) == 0 { return true }
		return errno == EPERM
	}

	private func freshLookId() -> String {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		nextLookId += 1
		return "look_\(nextLookId)"
	}

	func lookRecord(for lookId: String) throws -> LookRecord? {
		lookRecordLock.lock()
		let record = lookRecords[lookId]
		lookRecordLock.unlock()
		let caller = currentRequestSessionId()
		if let record, !sessionMayUse(owner: record.sessionId, caller: caller) {
			throw BridgeFailure(message: "Look id '\(lookId)' belongs to another session; nothing was sent. Observe the window in this session first", code: "not_look_owner", effectPossible: false)
		}
		if let record, record.sessionId != nil, record.sessionGeneration != currentRequestSessionGeneration() { return nil }
		return record
	}

	func windowFrameStaleness(_ record: LookRecord) -> BridgeFailure? {
		guard let observed = record.observedFrame, let root = record.rootElement else { return nil }
		let effectPossible = activeRequestContext()?.effectPossible ?? false
		guard let current = frameForElement(root) else {
			return BridgeFailure(message: "Window is no longer readable since look \(record.lookId); observe again", code: "stale_look", effectPossible: effectPossible)
		}
		let tolerance: CGFloat = 1.0
		let moved = abs(current.origin.x - observed.origin.x) > tolerance || abs(current.origin.y - observed.origin.y) > tolerance
		let resized = abs(current.size.width - observed.size.width) > tolerance || abs(current.size.height - observed.size.height) > tolerance
		guard moved || resized else { return nil }
		return BridgeFailure(message: "Window frame changed since look \(record.lookId); observe again", code: "stale_look", effectPossible: effectPossible)
	}

}

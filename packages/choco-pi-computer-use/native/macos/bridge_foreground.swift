import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

let requestClientSocketKey = "pi.computer-use.client-socket"

struct ForegroundSectionState {
	let id: String
	let holder: String
	var explicit: Bool
	var lastSeen: Double
	var targets: Set<Int32>
	var activeRequests: Int
	var userPid: Int32?
	var userWindow: AXUIElement?
	var acquireIds: Set<String> = []
	var restoring = false
}

extension Bridge {
	private func waitForCoordination(context: RequestContext?, limit: TimeInterval, _ condition: () -> Bool) throws -> Bool {
		let end = min(monotonicSeconds() + limit, context?.deadline ?? .infinity)
		coordination.lock()
		while !condition() {
			let now = monotonicSeconds()
			if now >= end { coordination.unlock(); return false }
			_ = coordination.wait(until: Date().addingTimeInterval(min(0.05, end - now)))
			if context?.stopRequested == true {
				coordination.unlock()
				try context?.checkpoint()
				coordination.lock()
			}
		}
		return true
	}

	private func acquireTarget(_ pid: Int32, requestKey: String, sessionKey: String, context: RequestContext?, limit: TimeInterval? = nil) throws {
		let start = monotonicSeconds()
		var blockedBy = "act"
		let acquired = try waitForCoordination(context: context, limit: limit ?? coordinationWaitLimit) {
			expireIdleForegroundSectionLocked()
			if let holder = targetHolders[pid], holder != requestKey { blockedBy = "act"; return false }
			if let section = foregroundSection, section.holder != sessionKey, section.targets.contains(pid) { blockedBy = "foreground_section"; return false }
			return true
		}
		guard acquired else {
			throw BridgeFailure(
				message: blockedBy == "foreground_section"
					? "target_busy: another computer-use session is driving this app in the foreground; nothing was sent. Retry later"
					: "target_busy: another computer-use session is acting on this app; nothing was sent. Retry later",
				code: "target_busy",
				effectPossible: false,
				details: ["inputSent": false, "busyReason": blockedBy, "waitedMs": Int((monotonicSeconds() - start) * 1000), "retry": "later"]
			)
		}
		targetHolders[pid] = requestKey
		coordination.unlock()
	}

	private func releaseTarget(_ pid: Int32, requestKey: String) {
		coordination.lock()
		if targetHolders[pid] == requestKey { targetHolders.removeValue(forKey: pid) }
		coordination.broadcast()
		coordination.unlock()
	}

	func onTarget<T>(_ pid: Int32, keys: (request: String, session: String), context: RequestContext?, limit: TimeInterval? = nil, _ body: () throws -> T) throws -> T {
		try acquireTarget(pid, requestKey: keys.request, sessionKey: keys.session, context: context, limit: limit)
		defer { releaseTarget(pid, requestKey: keys.request) }
		return try body()
	}

	private func isForegroundRequest(_ request: [String: Any]) -> Bool {
		switch request["cmd"] as? String {
		case "act", "actBatch":
			return isGrantedHIDRequest(request)
		case "focusWindow", "restoreUserFocus":
			return (request["foregroundGrant"] as? Bool) == true
		default:
			return false
		}
	}

	func inForeground<T>(_ request: [String: Any], keys: (request: String, session: String), pid: Int32?, context: RequestContext?, _ body: () throws -> T) throws -> T {
		guard isForegroundRequest(request) else { return try body() }
		let implicit = try enterForegroundRequest(key: keys.session, pid: pid, context: context)
		defer { leaveForegroundRequest(key: keys.session, implicit: implicit) }
		return try body()
	}

	private func enterForegroundRequest(key: String, pid: Int32?, context: RequestContext?) throws -> Bool {
		let start = monotonicSeconds()
		let entered = try waitForCoordination(context: context, limit: coordinationWaitLimit) {
			expireIdleForegroundSectionLocked()
			guard let section = foregroundSection else { return true }
			return section.holder == key && !section.restoring
		}
		guard entered else {
			throw BridgeFailure(
				message: "foreground_busy: another computer-use session holds the foreground; nothing was sent. Retry later",
				code: "foreground_busy",
				effectPossible: false,
				details: ["inputSent": false, "waitedMs": Int((monotonicSeconds() - start) * 1000), "retry": "later"]
			)
		}
		defer { coordination.unlock() }
		let now = monotonicSeconds()
		if var section = foregroundSection {
			section.lastSeen = now
			section.activeRequests += 1
			if let pid { section.targets.insert(pid) }
			foregroundSection = section
			armSectionExpiryLocked()
			return false
		}
		foregroundSection = ForegroundSectionState(
			id: UUID().uuidString, holder: key, explicit: false, lastSeen: now,
			targets: pid.map { [$0] } ?? [], activeRequests: 1, userPid: nil, userWindow: nil
		)
		return true
	}

	private func leaveForegroundRequest(key: String, implicit: Bool) {
		coordination.lock()
		if var section = foregroundSection, section.holder == key {
			section.activeRequests = max(0, section.activeRequests - 1)
			section.lastSeen = monotonicSeconds()
			foregroundSection = implicit && !section.explicit && section.activeRequests == 0 ? nil : section
			armSectionExpiryLocked()
		}
		coordination.broadcast()
		coordination.unlock()
	}

	func foregroundSectionCommand(_ request: [String: Any], session: (id: String, generation: Int)?) throws -> [String: Any] {
		guard let session else { throw BridgeFailure(message: "foregroundSection requires session {id, generation}", code: "invalid_args", effectPossible: false) }
		let op = optionalStringArg(request, "op") ?? "acquire"
		let acquireId = optionalStringArg(request, "acquireId").flatMap { $0.isEmpty ? nil : $0 }
		if op == "release" {
			if let acquireId { return cancelSectionAcquire(acquireId, holder: session.id) }
			return ["released": releaseForegroundSection(holder: session.id, restore: false)]
		}
		guard op == "acquire" else { throw BridgeFailure(message: "foregroundSection op must be acquire or release", code: "invalid_args", effectPossible: false) }
		let waitMs = Double(max(0, min(30_000, optionalIntArg(request, "waitMs") ?? 0)))
		let start = monotonicSeconds()
		let client = Thread.current.threadDictionary[requestClientSocketKey] as? Int32
		var abandoned: String?
		if let acquireId {
			coordination.lock()
			pendingSectionAcquires.insert(acquireId)
			coordination.unlock()
		}
		let entered = try waitForCoordination(context: nil, limit: waitMs / 1000) {
			if let acquireId, cancelledSectionAcquires[acquireId] != nil { abandoned = "cancelled"; return true }
			if let client, clientSocketClosed(client) { abandoned = "connection_closed"; return true }
			expireIdleForegroundSectionLocked()
			guard let section = foregroundSection else { return true }
			return section.holder == session.id && !section.restoring
		}
		guard entered else {
			if let acquireId {
				coordination.lock()
				pendingSectionAcquires.remove(acquireId)
				coordination.unlock()
			}
			throw BridgeFailure(
				message: "foreground_busy: another computer-use session holds the foreground; nothing was sent. Retry later",
				code: "foreground_busy",
				effectPossible: false,
				details: ["waitedMs": Int((monotonicSeconds() - start) * 1000), "retry": "later"]
			)
		}
		if let acquireId { pendingSectionAcquires.remove(acquireId) }
		let waited = Int((monotonicSeconds() - start) * 1000)
		if let abandoned {
			coordination.unlock()
			throw BridgeFailure(
				message: "cancelled: this foregroundSection acquire ended before it was granted (\(abandoned)); the section was not taken",
				code: "cancelled",
				effectPossible: false,
				details: ["waitedMs": waited, "reason": abandoned]
			)
		}
		if var section = foregroundSection {
			section.explicit = true
			section.lastSeen = monotonicSeconds()
			if let acquireId { section.acquireIds.insert(acquireId) }
			foregroundSection = section
			armSectionExpiryLocked()
			coordination.unlock()
			return ["acquired": true, "alreadyHeld": true, "sectionId": section.id, "waitedMs": waited]
		}
		let id = UUID().uuidString
		foregroundSection = ForegroundSectionState(
			id: id, holder: session.id, explicit: true, lastSeen: monotonicSeconds(), targets: [], activeRequests: 0,
			userPid: nil, userWindow: nil, acquireIds: acquireId.map { [$0] } ?? []
		)
		armSectionExpiryLocked()
		coordination.unlock()
		let userPid = currentFrontmostPid()
		let userWindow = userPid.flatMap { keyWindow(pid: $0)?.window }
		coordination.lock()
		if var section = foregroundSection, section.id == id {
			section.userPid = userPid
			section.userWindow = userWindow
			foregroundSection = section
		}
		coordination.unlock()
		var result: [String: Any] = ["acquired": true, "alreadyHeld": false, "sectionId": id, "waitedMs": waited]
		if let userPid { result["frontmostPid"] = Int(userPid) }
		return result
	}

	private func cancelSectionAcquire(_ acquireId: String, holder: String) -> [String: Any] {
		coordination.lock()
		defer { coordination.unlock() }
		let now = monotonicSeconds()
		cancelledSectionAcquires = cancelledSectionAcquires.filter { now - $0.value < 60 }
		if cancelledSectionAcquires.count >= 256 {
			for (key, _) in cancelledSectionAcquires.sorted(by: { $0.value < $1.value }).prefix(cancelledSectionAcquires.count - 255) {
				cancelledSectionAcquires.removeValue(forKey: key)
			}
		}
		let waiting = pendingSectionAcquires.contains(acquireId)
		var released = false
		if let section = foregroundSection, section.holder == holder, section.acquireIds.contains(acquireId) {
			if !section.restoring { retireForegroundSectionLocked(section, restore: false) }
			released = true
		} else {
			cancelledSectionAcquires[acquireId] = now
		}
		coordination.broadcast()
		return ["released": released, "cancelledWait": waiting]
	}

	@discardableResult
	func releaseForegroundSection(holder: String, restore: Bool) -> Bool {
		coordination.lock()
		defer { coordination.unlock() }
		guard let section = foregroundSection, section.holder == holder else { return false }
		if !section.restoring { retireForegroundSectionLocked(section, restore: restore) }
		return true
	}

	private func expireIdleForegroundSectionLocked() {
		guard let section = foregroundSection, section.explicit, !section.restoring, section.activeRequests == 0,
			monotonicSeconds() - section.lastSeen >= foregroundSectionIdleTTL
		else { return }
		retireForegroundSectionLocked(section, restore: true)
	}

	private func retireForegroundSectionLocked(_ section: ForegroundSectionState, restore: Bool) {
		sectionExpiryGeneration &+= 1
		guard restore, section.userPid != nil, !section.targets.isEmpty else {
			foregroundSection = nil
			coordination.broadcast()
			return
		}
		var retiring = section
		retiring.restoring = true
		foregroundSection = retiring
		DispatchQueue.global(qos: .userInitiated).async { [self] in
			restoreAfterExpiredSection(retiring)
			coordination.lock()
			if foregroundSection?.id == retiring.id { foregroundSection = nil }
			coordination.broadcast()
			coordination.unlock()
		}
	}

	private func restoreAfterExpiredSection(_ section: ForegroundSectionState) {
		guard let userPid = section.userPid, let front = currentFrontmostPid(), front != userPid, section.targets.contains(front),
			let app = NSRunningApplication(processIdentifier: userPid), !app.isTerminated
		else { return }
		let keys = (request: "restore:" + section.id, session: section.holder)
		_ = try? onTarget(userPid, keys: keys, context: nil, limit: sectionRestoreHoldWait) {
			guard let current = currentFrontmostPid(), current != userPid, section.targets.contains(current) else { return }
			if let window = section.userWindow { _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue) }
			_ = app.activate()
			let end = monotonicSeconds() + sectionRestoreVerifyBound
			while monotonicSeconds() < end {
				if currentFrontmostPid() == userPid, section.userWindow.map({ isKeyWindow($0, pid: userPid) }) ?? true { return }
				usleep(25_000)
			}
		}
	}

	func armSectionExpiryLocked() {
		sectionExpiryGeneration &+= 1
		guard let section = foregroundSection, section.explicit, !section.restoring, section.activeRequests == 0 else { return }
		let generation = sectionExpiryGeneration
		let delay = max(0, section.lastSeen + foregroundSectionIdleTTL - monotonicSeconds()) + 0.02
		DispatchQueue.global().asyncAfter(wallDeadline: .now() + delay) { [weak self] in self?.sectionExpiryTimerFired(generation) }
	}

	private func sectionExpiryTimerFired(_ generation: UInt64) {
		coordination.lock()
		defer { coordination.unlock() }
		guard generation == sectionExpiryGeneration else { return }
		expireIdleForegroundSectionLocked()
		if generation == sectionExpiryGeneration { armSectionExpiryLocked() }
	}

	func clientSocketClosed(_ fd: Int32) -> Bool {
		var byte: UInt8 = 0
		let count = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
		if count == 0 { return true }
		if count < 0 { return errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR }
		return false
	}

	func activeRequestContext() -> RequestContext? {
		Thread.current.threadDictionary[Bridge.requestContextKey] as? RequestContext
	}

	func checkpoint() throws {
		try activeRequestContext()?.checkpoint()
	}

	func foregroundRequired(_ message: String) -> BridgeFailure {
		BridgeFailure(message: message, code: "foreground_required", effectPossible: activeRequestContext()?.effectPossible ?? false)
	}

}

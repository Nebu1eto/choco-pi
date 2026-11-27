import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

let requestSessionKey = "pi.computer-use.request-session"
let requestSessionGenerationKey = "pi.computer-use.request-session-generation"

func currentRequestSessionId() -> String? {
	Thread.current.threadDictionary[requestSessionKey] as? String
}

func currentRequestSessionGeneration() -> Int? {
	Thread.current.threadDictionary[requestSessionGenerationKey] as? Int
}

func sessionMayUse(owner: String?, caller: String?) -> Bool {
	owner == nil || owner == caller
}

extension Bridge {
	func recordCompletedRequest(_ id: String) {
		completedRequestLock.lock()
		recentCompletedRequestIds.removeAll { $0 == id }
		recentCompletedRequestIds.append(id)
		if recentCompletedRequestIds.count > 32 {
			recentCompletedRequestIds.removeFirst(recentCompletedRequestIds.count - 32)
		}
		completedRequestLock.unlock()
	}

	func completedRequestIds() -> [String] {
		completedRequestLock.lock()
		defer { completedRequestLock.unlock() }
		return recentCompletedRequestIds
	}

	func requestSession(_ request: [String: Any]) -> (id: String, generation: Int)? {
		let raw = (request["session"] as? [String: Any])
			?? ((request["actions"] as? [[String: Any]])?.first?["session"] as? [String: Any])
		guard let raw, let id = raw["id"] as? String, !id.isEmpty else { return nil }
		return (id, (raw["generation"] as? NSNumber)?.intValue ?? 0)
	}

	func authorizeOwner(_ session: (id: String, generation: Int)?, pin: Bool) throws {
		let expired = pruneExpiredSessions()
		defer { finishExpiredSessions(expired) }
		ownerLock.lock()
		defer { ownerLock.unlock() }
		guard let session else {
			if pin { sessionlessActiveRequests += 1 }
			return
		}
		let now = monotonicSeconds()
		if let live = sessions[session.id] {
			func refuse(_ message: String) -> BridgeFailure {
				BridgeFailure(message: message, code: "owned_by_other_session", effectPossible: false, details: ["activeRequests": live.active])
			}
			if session.generation < live.generation {
				throw refuse("The helper session is held by a newer generation of this session")
			}
			if session.generation > live.generation && live.active > 0 {
				throw refuse("An older generation of this session still has requests in flight")
			}
			sessions[session.id] = (session.generation, now, live.active + (pin ? 1 : 0))
		} else {
			sessions[session.id] = (session.generation, now, pin ? 1 : 0)
		}
		armSessionExpiryLocked()
	}

	func pruneExpiredSessions() -> [String] {
		ownerLock.lock()
		defer { ownerLock.unlock() }
		let now = monotonicSeconds()
		let expired = sessions.filter { $0.value.active == 0 && now - $0.value.lastSeen >= ownerTTL }.map { $0.key }
		for id in expired { sessions.removeValue(forKey: id) }
		armSessionExpiryLocked()
		return expired
	}

	func armSessionExpiryLocked() {
		sessionExpiryGeneration &+= 1
		guard let due = sessions.values.filter({ $0.active == 0 }).map({ $0.lastSeen + ownerTTL }).min() else { return }
		let generation = sessionExpiryGeneration
		let delay = max(0, due - monotonicSeconds()) + 0.02
		DispatchQueue.global().asyncAfter(wallDeadline: .now() + delay) { [weak self] in self?.sessionExpiryTimerFired(generation) }
	}

	private func sessionExpiryTimerFired(_ generation: UInt64) {
		ownerLock.lock()
		let current = generation == sessionExpiryGeneration
		ownerLock.unlock()
		guard current else { return }
		finishExpiredSessions(pruneExpiredSessions())
	}

	func finishExpiredSessions(_ ids: [String]) {
		for id in ids {
			releaseForegroundSection(holder: id, restore: true)
			if supportsAgentCursor { AgentCursorQueue.release(session: id) }
		}
		sweepLookRetention()
	}

	func endOwnedRequest(_ session: (id: String, generation: Int)?) {
		ownerLock.lock()
		if let session, let current = sessions[session.id], current.generation == session.generation {
			sessions[session.id] = (current.generation, monotonicSeconds(), max(0, current.active - 1))
		} else if session == nil {
			sessionlessActiveRequests = max(0, sessionlessActiveRequests - 1)
		} else if let session, let current = sessions[session.id] {
			sessions[session.id] = (current.generation, current.lastSeen, max(0, current.active - 1))
		}
		armSessionExpiryLocked()
		ownerLock.unlock()
	}

	func refreshOwner(_ session: (id: String, generation: Int)) {
		ownerLock.lock()
		if let current = sessions[session.id] {
			if current.generation == session.generation {
				sessions[session.id] = (current.generation, monotonicSeconds(), current.active)
			}
		} else {
			sessions[session.id] = (session.generation, monotonicSeconds(), 0)
		}
		armSessionExpiryLocked()
		ownerLock.unlock()
		coordination.lock()
		if var section = foregroundSection, section.holder == session.id {
			section.lastSeen = monotonicSeconds()
			foregroundSection = section
			armSectionExpiryLocked()
		}
		coordination.unlock()
	}

	func releaseOwner(_ session: (id: String, generation: Int)?) throws -> Bool {
		ownerLock.lock()
		guard let session, let current = sessions[session.id], session.generation >= current.generation else {
			ownerLock.unlock()
			return false
		}
		if current.active > 0 {
			ownerLock.unlock()
			throw BridgeFailure(message: "release refused: this session has \(current.active) request(s) in flight", code: "owner_busy", effectPossible: false, details: ["activeRequests": current.active])
		}
		sessions.removeValue(forKey: session.id)
		armSessionExpiryLocked()
		ownerLock.unlock()
		dropLookRecords(sessionId: session.id)
		releaseForegroundSection(holder: session.id, restore: false)
		if supportsAgentCursor { AgentCursorQueue.release(session: session.id) }
		return true
	}

	func otherSessionsActive(caller: String?) -> Int {
		ownerLock.lock()
		defer { ownerLock.unlock() }
		var count = caller == nil ? max(0, sessionlessActiveRequests - 1) : sessionlessActiveRequests
		for (id, entry) in sessions where id != caller { count += entry.active }
		return count
	}

	func sessionDiagnostics() -> [String: Any] {
		let now = monotonicSeconds()
		ownerLock.lock()
		let live = sessions.values.filter { $0.active > 0 || now - $0.lastSeen < ownerTTL }
		let active = live.reduce(0) { $0 + $1.active } + sessionlessActiveRequests
		ownerLock.unlock()
		coordination.lock()
		let held = foregroundSection != nil
		let restoring = foregroundSection?.restoring == true
		let busyTargets = targetHolders.count
		coordination.unlock()
		lookRecordLock.lock()
		let retainedSessions = Set(lookRecords.values.compactMap { $0.sessionId }).count
		let retainedLooks = lookRecords.count
		lookRecordLock.unlock()
		return [
			"live": live.count, "activeRequests": active, "foregroundSectionHeld": held, "foregroundSectionRestoring": restoring,
			"busyTargets": busyTargets, "ttlMs": Int(ownerTTL * 1000), "foregroundSectionIdleTtlMs": Int(foregroundSectionIdleTTL * 1000),
			"looks": [
				"sessions": retainedSessions, "records": retainedLooks, "perSession": looksPerSession, "maxSessions": maxLookSessions,
				"retentionWithoutClientMs": Int(lookRetentionWithoutClient * 1000),
			],
		]
	}

	func tracked(requestIds: [String], deadline: Double?, session: (id: String, generation: Int)?, grantedHID: Bool = false, _ body: () throws -> [String: Any]) throws -> [String: Any] {
		var heartbeat: (() -> Void)?
		if let session { heartbeat = { [weak self] in self?.refreshOwner(session) } }
		requestRegistryLock.lock()
		if let duplicate = requestIds.first(where: { activeRequests[$0] != nil }) {
			requestRegistryLock.unlock()
			throw BridgeFailure(message: "Request id '\(duplicate)' is already in flight", code: "invalid_request", effectPossible: false)
		}
		pruneTombstones(now: monotonicSeconds())
		let tombstoned = requestIds.contains { id in
			cancelTombstones.contains { $0.id == id && (session == nil || $0.sessionId == session?.id) }
		}
		let context = RequestContext(requestIds: requestIds, deadline: deadline, sessionId: session?.id, cancelled: tombstoned, heartbeat: heartbeat)
		for id in requestIds { activeRequests[id] = context }
		requestRegistryLock.unlock()
		let threadDictionary = Thread.current.threadDictionary
		threadDictionary[Bridge.requestContextKey] = context
		defer {
			threadDictionary.removeObject(forKey: Bridge.requestContextKey)
			requestRegistryLock.lock()
			for id in requestIds {
				activeRequests.removeValue(forKey: id)
				completedSemanticRequests.removeAll { $0.id == id }
				completedSemanticRequests.append((id, session?.id))
			}
			if completedSemanticRequests.count > 64 {
				completedSemanticRequests.removeFirst(completedSemanticRequests.count - 64)
			}
			requestRegistryLock.unlock()
		}
		do {
			try context.checkpoint()
			return try body()
		} catch var failure as BridgeFailure {
			if failure.effectPossible == nil { failure.effectPossible = context.effectPossible }
			if grantedHID {
				var details = failure.details ?? [:]
				if details["inputSent"] == nil { details["inputSent"] = context.inputEventCount > 0 }
				failure.details = details
			}
			throw failure
		} catch {
			var details: [String: Any]?
			if grantedHID { details = ["inputSent": context.inputEventCount > 0] }
			throw BridgeFailure(message: error.localizedDescription, code: "internal_error", effectPossible: context.effectPossible, details: details)
		}
	}

	private func pruneTombstones(now: Double) {
		cancelTombstones.removeAll { now - $0.at >= tombstoneTTL }
		if cancelTombstones.count > tombstoneLimit {
			cancelTombstones.removeFirst(cancelTombstones.count - tombstoneLimit)
		}
	}

	func cancelRequest(_ request: [String: Any], session: (id: String, generation: Int)?) throws -> [String: Any] {
		let target = try stringArg(request, "target")
		let caller = session?.id
		requestRegistryLock.lock()
		let context = activeRequests[target]
		let completedEntry = completedSemanticRequests.last { $0.id == target }
		let registeredBy = context.map { $0.sessionId } ?? completedEntry?.sessionId
		if let registeredBy, registeredBy != caller {
			requestRegistryLock.unlock()
			throw BridgeFailure(
				message: "cancel refused: request '\(target)' was registered by another session",
				code: "not_request_owner",
				effectPossible: false
			)
		}
		let completed = completedEntry != nil
		if context == nil && !completed {
			let now = monotonicSeconds()
			cancelTombstones.removeAll { $0.id == target && $0.sessionId == caller }
			cancelTombstones.append(CancelTombstone(id: target, at: now, sessionId: caller))
			pruneTombstones(now: now)
		}
		requestRegistryLock.unlock()
		guard let context else {
			return ["acknowledged": true, "state": completed ? "completed" : "not_found"]
		}
		context.requestCancel()
		let waitUntil = monotonicSeconds() + 0.3
		while true {
			requestRegistryLock.lock()
			let stillActive = activeRequests[target] === context
			requestRegistryLock.unlock()
			if context.isStopped {
				return ["acknowledged": true, "state": "stopped", "stoppedAt": context.currentStep, "effectPossible": context.effectPossible]
			}
			if !stillActive {
				return ["acknowledged": true, "state": "completed", "effectPossible": context.effectPossible]
			}
			if monotonicSeconds() >= waitUntil {
				return ["acknowledged": true, "state": "stopping", "effectPossible": true]
			}
			usleep(5_000)
		}
	}

	func requestDeadline(_ requests: [[String: Any]], receivedAt: Double) throws -> Double? {
		if requests.contains(where: { $0["deadlineMs"] != nil && $0["budgetMs"] == nil }) {
			throw BridgeFailure(
				message: "deadlineMs is not accepted since protocol 8; send budgetMs, the request's time budget in milliseconds",
				code: "invalid_args",
				effectPossible: false
			)
		}
		let budgets = requests.compactMap { ($0["budgetMs"] as? NSNumber)?.doubleValue }
		guard let budget = budgets.min() else { return nil }
		guard budget.isFinite, budget >= 0 else {
			throw BridgeFailure(message: "budgetMs must be a finite, non-negative number", code: "invalid_args", effectPossible: false)
		}
		return receivedAt + budget / 1000
	}

}

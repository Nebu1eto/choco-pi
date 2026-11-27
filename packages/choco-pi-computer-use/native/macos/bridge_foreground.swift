import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct ForegroundSectionState {
	let id: String
	let holder: String
	var explicit: Bool
	var lastSeen: Double
	var targets: Set<Int32>
	var activeRequests: Int
	var userPid: Int32?
	var userWindow: AXUIElement?
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

	private func acquireTarget(_ pid: Int32, requestKey: String, sessionKey: String, context: RequestContext?) throws {
		let start = monotonicSeconds()
		var blockedBy = "act"
		let acquired = try waitForCoordination(context: context, limit: coordinationWaitLimit) {
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

	func onTarget<T>(_ pid: Int32, keys: (request: String, session: String), context: RequestContext?, _ body: () throws -> T) throws -> T {
		try acquireTarget(pid, requestKey: keys.request, sessionKey: keys.session, context: context)
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
			return section.holder == key
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
		}
		coordination.broadcast()
		coordination.unlock()
	}

	func foregroundSectionCommand(_ request: [String: Any], session: (id: String, generation: Int)?) throws -> [String: Any] {
		guard let session else { throw BridgeFailure(message: "foregroundSection requires session {id, generation}", code: "invalid_args", effectPossible: false) }
		let op = optionalStringArg(request, "op") ?? "acquire"
		if op == "release" {
			return ["released": releaseForegroundSection(holder: session.id, restore: false)]
		}
		guard op == "acquire" else { throw BridgeFailure(message: "foregroundSection op must be acquire or release", code: "invalid_args", effectPossible: false) }
		let waitMs = Double(max(0, min(30_000, optionalIntArg(request, "waitMs") ?? 0)))
		let start = monotonicSeconds()
		let entered = try waitForCoordination(context: nil, limit: waitMs / 1000) {
			expireIdleForegroundSectionLocked()
			guard let section = foregroundSection else { return true }
			return section.holder == session.id
		}
		guard entered else {
			throw BridgeFailure(
				message: "foreground_busy: another computer-use session holds the foreground; nothing was sent. Retry later",
				code: "foreground_busy",
				effectPossible: false,
				details: ["waitedMs": Int((monotonicSeconds() - start) * 1000), "retry": "later"]
			)
		}
		let waited = Int((monotonicSeconds() - start) * 1000)
		if var section = foregroundSection {
			section.explicit = true
			section.lastSeen = monotonicSeconds()
			foregroundSection = section
			coordination.unlock()
			return ["acquired": true, "alreadyHeld": true, "sectionId": section.id, "waitedMs": waited]
		}
		let id = UUID().uuidString
		foregroundSection = ForegroundSectionState(id: id, holder: session.id, explicit: true, lastSeen: monotonicSeconds(), targets: [], activeRequests: 0, userPid: nil, userWindow: nil)
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

	@discardableResult
	func releaseForegroundSection(holder: String, restore: Bool) -> Bool {
		coordination.lock()
		guard let section = foregroundSection, section.holder == holder else {
			coordination.unlock()
			return false
		}
		foregroundSection = nil
		coordination.broadcast()
		coordination.unlock()
		if restore { restoreAfterExpiredSection(section) }
		return true
	}

	private func expireIdleForegroundSectionLocked() {
		guard let section = foregroundSection, section.explicit, section.activeRequests == 0,
			monotonicSeconds() - section.lastSeen >= foregroundSectionIdleTTL
		else { return }
		foregroundSection = nil
		coordination.broadcast()
		DispatchQueue.global().async { [self] in restoreAfterExpiredSection(section) }
	}

	private func restoreAfterExpiredSection(_ section: ForegroundSectionState) {
		guard let userPid = section.userPid, let front = currentFrontmostPid(), front != userPid, section.targets.contains(front),
			let app = NSRunningApplication(processIdentifier: userPid), !app.isTerminated
		else { return }
		if let window = section.userWindow { _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue) }
		_ = app.activate()
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

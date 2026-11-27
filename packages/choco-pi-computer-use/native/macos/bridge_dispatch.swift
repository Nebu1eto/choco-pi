import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
	func isGrantedHIDRequest(_ request: [String: Any]) -> Bool {
		switch request["cmd"] as? String {
		case "act":
			return isGrantedHIDAct(request)
		case "actBatch":
			return (request["actions"] as? [[String: Any]] ?? []).contains { isGrantedHIDAct($0) }
		default:
			return false
		}
	}

	func handleRequest(_ request: [String: Any], receivedAt: Double) throws -> Any {
		do {
			return try dispatchRequest(request, receivedAt: receivedAt)
		} catch var failure as BridgeFailure {
			guard isGrantedHIDRequest(request) else { throw failure }
			var details = failure.details ?? [:]
			if details["inputSent"] == nil { details["inputSent"] = false }
			failure.details = details
			throw failure
		}
	}

	private func dispatchRequest(_ request: [String: Any], receivedAt: Double) throws -> Any {
		let cmd = try stringArg(request, "cmd")
		let session = requestSession(request)
		let threadDictionary = Thread.current.threadDictionary
		if let session { threadDictionary[requestSessionKey] = session.id } else { threadDictionary.removeObject(forKey: requestSessionKey) }
		if let session { threadDictionary[requestSessionGenerationKey] = session.generation } else { threadDictionary.removeObject(forKey: requestSessionGenerationKey) }
		defer {
			threadDictionary.removeObject(forKey: requestSessionKey)
			threadDictionary.removeObject(forKey: requestSessionGenerationKey)
		}
		let requestKey = "req:" + UUID().uuidString
		let keys = (request: requestKey, session: session?.id ?? requestKey)
		let gated = ownerGatedCommands.contains(cmd)
		if gated {
			try authorizeOwner(session, pin: true)
		} else if let session {
			finishExpiredSessions(pruneExpiredSessions())
			refreshOwner(session)
		}
		if let session { noteLookSession(session, clientPid: requestClientPid(request)) }
		defer { if gated { endOwnedRequest(session) } }

		switch cmd {
		case "claim":
			guard let session else { throw BridgeFailure(message: "claim requires session {id, generation}", code: "invalid_args") }
			try authorizeOwner(session, pin: false)
			return ["claimed": true, "owner": ["id": session.id, "generation": session.generation], "ttlMs": Int(ownerTTL * 1000)]
		case "release":
			return ["released": try releaseOwner(session)]
		case "cancel":
			return try cancelRequest(request, session: session)
		case "foregroundSection":
			return try foregroundSectionCommand(request, session: session)
		case "diagnostics":
			return diagnostics()
		case "checkPermissions":
			return checkPermissions()
		case "registerPermissions":
			return try registerPermissions()
		case "openPermissionPane":
			return try openPermissionPane(request)
		case "shutdown":
			let busy = otherSessionsActive(caller: session?.id)
			if busy > 0 {
				throw BridgeFailure(message: "shutdown refused: other sessions have \(busy) request(s) in flight", code: "helper_busy", effectPossible: false, details: ["activeRequests": busy])
			}
			DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in
				deactivateExtendedTargets()
				exit(0)
			}
			return ["shuttingDown": true]
		case "listApps":
			return listApps()
		case "listWindows":
			return try listWindows(pid: Int32(try intArg(request, "pid")), request: request, scanOffSpace: true)
		case "listRoots":
			return try listRoots(pid: optionalIntArg(request, "pid").map { Int32($0) }, title: optionalStringArg(request, "title"), request: request)
		case "getFrontmost":
			return try getFrontmost()
		case "getUserContext":
			return try getUserContext(request)
		case "beginInputSuppression":
			return try beginInputSuppression()
		case "endInputSuppression":
			return endInputSuppression()
		case "restoreUserFocus":
			return try inForeground(request, keys: keys, pid: nil, context: nil) {
				guard let pid = optionalIntArg(request, "pid").map({ Int32($0) }) else { return try restoreUserFocus(request) }
				return try onTarget(pid, keys: keys, context: nil) { try restoreUserFocus(request) }
			}
		case "focusWindow":
			let pid = Int32(try intArg(request, "pid"))
			return try onTarget(pid, keys: keys, context: nil) {
				try inForeground(request, keys: keys, pid: pid, context: nil) { try focusWindow(request) }
			}
		case "setWindowFrame":
			return try onTarget(Int32(try intArg(request, "pid")), keys: keys, context: nil) { try setWindowFrame(request) }
		case "look":
			return try look(request)
		case "act":
			return try tracked(
				requestIds: [optionalStringArg(request, "requestId")].compactMap { $0 },
				deadline: try requestDeadline([request], receivedAt: receivedAt),
				session: session,
				grantedHID: isGrantedHIDAct(request)
			) {
				let context = activeRequestContext()
				let pid = Int32(try intArg(request, "pid"))
				return try inForeground(request, keys: keys, pid: pid, context: context) {
					try restoringPointer(request, context: context) {
						try onTarget(pid, keys: keys, context: context) { try act(request) }
					}
				}
			}
		case "actBatch":
			let actions = request["actions"] as? [[String: Any]] ?? []
			return try tracked(
				requestIds: ([request] + actions).compactMap { $0["requestId"] as? String },
				deadline: try requestDeadline([request] + actions, receivedAt: receivedAt),
				session: session,
				grantedHID: isGrantedHIDRequest(request)
			) {
				let context = activeRequestContext()
				guard let first = actions.first else { return try actBatch(request) }
				let pid = Int32(try intArg(first, "pid"))
				return try inForeground(request, keys: keys, pid: pid, context: context) {
					try restoringPointer(request, context: context) {
						try onTarget(pid, keys: keys, context: context) { try actBatch(request) }
					}
				}
			}
		case "hitTest":
			return try hitTest(request)
		case "axWaitFor":
			return try axWaitFor(request)
		case "focusedElement":
			return try focusedElement(request)
		case "axReadText":
			return try axReadText(request)
		case "getMousePosition":
			return getMousePosition()
		case "agentCursorState":
			return try agentCursorState(request)
		default:
			throw BridgeFailure(message: "Unknown command '\(cmd)'", code: "unknown_command")
		}
	}

	func stringArg(_ request: [String: Any], _ key: String) throws -> String {
		if let value = request[key] as? String {
			return value
		}
		throw BridgeFailure(message: "Missing string argument '\(key)'", code: "invalid_args")
	}

	func optionalStringArg(_ request: [String: Any], _ key: String) -> String? {
		if let value = request[key] as? String {
			return value
		}
		return nil
	}

	func intArg(_ request: [String: Any], _ key: String) throws -> Int {
		if let value = request[key] as? Int {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.intValue
		}
		if let value = request[key] as? Double {
			return Int(value)
		}
		throw BridgeFailure(message: "Missing integer argument '\(key)'", code: "invalid_args")
	}

	func optionalIntArg(_ request: [String: Any], _ key: String) -> Int? {
		if let value = request[key] as? Int {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.intValue
		}
		if let value = request[key] as? Double {
			return Int(value)
		}
		return nil
	}

	func boolArg(_ request: [String: Any], _ key: String) -> Bool? {
		if let value = request[key] as? Bool { return value }
		if let value = request[key] as? NSNumber { return value.boolValue }
		return nil
	}

	func doubleArg(_ request: [String: Any], _ key: String) throws -> Double {
		if let value = request[key] as? Double {
			return value
		}
		if let value = request[key] as? NSNumber {
			return value.doubleValue
		}
		if let value = request[key] as? Int {
			return Double(value)
		}
		throw BridgeFailure(message: "Missing numeric argument '\(key)'", code: "invalid_args")
	}

}

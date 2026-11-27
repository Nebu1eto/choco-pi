import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
	func hitTest(_ request: [String: Any]) throws -> [String: Any] {
		let lookId = try stringArg(request, "lookId")
		guard let record = try lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look", effectPossible: false)
		}
		let point = lookPoint(record: record, x: try doubleArg(request, "x"), y: try doubleArg(request, "y"))
		try enforceWindowOwners(pid: nil, windowId: record.windowId, windowRef: nil, request: request)
		if let root = record.rootElement, let owner = pidForElement(root) { try enforceAppPolicy(owner: owner, request: request) }
		guard let element = hitTestElement(at: point) else {
			throw BridgeFailure(message: "No element at point", code: "hit_test_failed")
		}
		if let owner = pidForElement(element) { try enforceAppPolicy(owner: owner, request: request) }
		return payloadNode(element: element)
	}

	func act(_ request: [String: Any]) throws -> [String: Any] {
		let context = activeRequestContext()
		let baseline = context?.inputEventCount ?? 0
		do {
			return try deliverAct(request)
		} catch var failure as BridgeFailure {
			if let context, context.extendedDeliveryActivated, failure.code == "foreground_required",
				(failure.details?["keyWindowAcquired"] as? Bool) != false
			{
				return extendedUnverifiedEnding(failure, context: context)
			}
			if let status = context?.extendedDeliveryStatus {
				var details = failure.details ?? [:]
				if details["extendedDelivery"] == nil { details["extendedDelivery"] = status }
				if details["extendedDeliveryReason"] == nil, let reason = context?.extendedDeliveryReason { details["extendedDeliveryReason"] = reason }
				failure.details = details
			}
			guard let context, isGrantedHIDAct(request) else { throw failure }
			var details = failure.details ?? [:]
			if details["inputSent"] == nil { details["inputSent"] = context.inputEventCount > baseline }
			failure.details = details
			throw failure
		}
	}

	func isGrantedHIDAct(_ request: [String: Any]) -> Bool {
		let params = request["params"] as? [String: Any] ?? [:]
		return optionalStringArg(request, "policy") == "foreground" && (request["foregroundGrant"] as? Bool) == true
			&& (params["delivery"] as? String) != "pid"
	}

	private func extendedUnverifiedEnding(_ failure: BridgeFailure, context: RequestContext) -> [String: Any] {
		var performed: [String: Any] = ["delivery": "pid", "extendedDelivery": "used"]
		if let reason = context.extendedDeliveryReason { performed["extendedDeliveryReason"] = reason }
		var evidence: [String: Any] = (failure.details?["evidence"] as? [String: Any]) ?? [:]
		evidence["extendedDelivery"] = "used"
		evidence["observableChange"] = false
		evidence["extendedDeliveryEnding"] = ["code": failure.code, "message": failure.message]
		return ["outcome": "unknown", "performed": performed, "evidence": evidence]
	}

	private func batchStepError(_ failure: BridgeFailure, context: RequestContext?) -> [String: Any] {
		var stepError: [String: Any] = ["code": failure.code, "message": failure.message, "effectPossible": failure.effectPossible ?? context?.effectPossible ?? true]
		if let evidence = failure.details?["evidence"] { stepError["evidence"] = evidence }
		for key in ["inputSent", "activationAttempted", "charactersSent", "destinationReason", "extendedDelivery", "extendedDeliveryReason", "keyWindowAcquired", "observedWindowResolved"] {
			if let value = failure.details?[key] { stepError[key] = value }
		}
		return stepError
	}

	func withDestinationStatus(_ response: [String: Any], context: RequestContext?) -> [String: Any] {
		guard let status = context?.destinationWindowStatus, var performed = response["performed"] as? [String: Any] else { return response }
		var output = response
		performed["destinationWindow"] = status
		output["performed"] = performed
		return output
	}

	enum PreflightVerdict {
		case clear
		case capsUnknown
		case occluded
	}

	private func cgWindowOwnerPid(at point: CGPoint) -> Int32? {
		let entries = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
		for entry in entries {
			guard let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, ownerPid != getpid() else { continue }
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
			let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
			guard layer == 0, alpha > 0,
				let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
				bounds.contains(point)
			else { continue }
			return ownerPid
		}
		return nil
	}

	func preflightVerdict(hit: AXUIElement?, element: AXUIElement?, point: CGPoint, pid: Int32) -> PreflightVerdict {
		let ownerPid = hit.map { pidForElement($0) } ?? cgWindowOwnerPid(at: point)
		if let ownerPid, ownerPid != pid, ownerPid != getpid() { return .occluded }
		guard let element, let hit else { return .capsUnknown }
		if sameElement(hit, element) || isElement(hit, descendantOf: element) || isElement(element, descendantOf: hit) { return .clear }
		let role = stringAttribute(hit, attribute: kAXRoleAttribute as CFString) ?? ""
		if role == "AXWindow" || role == "AXApplication" { return .capsUnknown }
		return .occluded
	}

	func occludedFailure(hit: AXUIElement?, point: CGPoint) -> BridgeFailure {
		if let hit { return BridgeFailure(message: "Target is occluded by \(payloadNode(element: hit))", code: "occluded_target") }
		let owner = cgWindowOwnerPid(at: point).map { appLabel($0) } ?? "another window"
		return BridgeFailure(message: "Target point is covered by a window of \(owner)", code: "occluded_target")
	}

	func attachFrontmost(to response: inout [String: Any], before: pid_t?) {
		if let before { response["frontmostBefore"] = Int(before) }
		if let after = NSWorkspace.shared.frontmostApplication?.processIdentifier { response["frontmostAfter"] = Int(after) }
	}

	func actBatch(_ request: [String: Any]) throws -> [String: Any] {
		guard let actions = request["actions"] as? [[String: Any]], !actions.isEmpty, actions.count <= 20 else {
			throw BridgeFailure(message: "actBatch requires 1...20 actions", code: "invalid_args")
		}
		let pid = Int32(try intArg(actions[0], "pid"))
		let lookId = try stringArg(actions[0], "lookId")
		guard actions.allSatisfy({ ($0["pid"] as? NSNumber)?.int32Value == pid }) else {
			throw BridgeFailure(message: "actBatch actions must target one pid", code: "invalid_args")
		}
		guard actions.allSatisfy({ ($0["lookId"] as? String) == lookId }) else {
			throw BridgeFailure(message: "actBatch actions must belong to one look", code: "invalid_args")
		}
		if let record = try lookRecord(for: lookId) {
			try enforceWindowOwners(pid: pid, windowId: record.windowId, windowRef: nil, request: request, act: true)
		} else {
			try enforceAppPolicy(owner: pid, request: request, act: true)
		}
		let eventsLive = ensureRootObserver(pid: pid)
		let eventCursor = eventsLive ? rootEventCursor(pid: pid) : 0
		let beforeRootSnapshot = rootMetadataSnapshot(pid: pid)
		let beforeCgSignature = cgRootSignature(pid: pid)
		let beforeFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let holdsBatchPhysicalInput = actions.contains { action in
			let rawPolicy = optionalStringArg(action, "policy") ?? "background"
			let params = action["params"] as? [String: Any] ?? [:]
			let granted = rawPolicy == "foreground" && (action["foregroundGrant"] as? Bool) == true
			return granted && (params["delivery"] as? String) != "pid"
		}
		if holdsBatchPhysicalInput { physicalInputLock.lock() }
		defer { if holdsBatchPhysicalInput { physicalInputLock.unlock() } }

		let context = activeRequestContext()
		var steps: [[String: Any]] = []
		var stoppedAt: Int?
		for (index, action) in actions.enumerated() {
			var deferred = action
			deferred["deferRootDelta"] = true
			if deferred["appBlocklist"] == nil, let list = request["appBlocklist"] { deferred["appBlocklist"] = list }
			context?.setStep(index)
			do {
				try checkpoint()
				let step = try act(deferred)
				steps.append(step)
				if (step["outcome"] as? String) == "didnt" { stoppedAt = index; break }
				if (step["evidence"] as? [String: Any])?["extendedDeliveryEnding"] != nil { stoppedAt = index; break }
			} catch var failure as BridgeFailure {
				if failure.code == "cancelled" {
					var partial = failure.result ?? [:]
					partial["stoppedAt"] = index
					partial["steps"] = steps
					failure.result = partial
					throw failure
				}
				let extendedUsed = (failure.details?["extendedDelivery"] as? String) == "used"
				steps.append(["outcome": extendedUsed ? "unknown" : "didnt", "error": batchStepError(failure, context: context)])
				stoppedAt = index
				break
			}
		}
		let outcomes = steps.compactMap { $0["outcome"] as? String }
		let outcome = outcomes.contains("didnt") ? "didnt" : (outcomes.contains("unknown") ? "unknown" : "worked")
		var response: [String: Any] = ["outcome": outcome, "performed": ["transaction": true, "actionCount": steps.count], "steps": steps]
		if let stoppedAt { response["stoppedAt"] = stoppedAt }
		var output = try attachRootDelta(to: response, before: beforeRootSnapshot, beforeFrontmostPid: beforeFrontmostPid, pid: pid, eventsLive: eventsLive, eventCursor: eventCursor, beforeCgSignature: beforeCgSignature)
		attachFrontmost(to: &output, before: beforeFrontmostPid)
		return output
	}

	func axWaitFor(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request)
		ensureEnhancedAccessibility(pid: pid)
		let role = optionalStringArg(request, "role")?.trimmingCharacters(in: .whitespacesAndNewlines)
		let text = optionalStringArg(request, "text")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let expectedValue = optionalStringArg(request, "value")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let waitForGone = boolArg(request, "gone") ?? false
		let scopeExact = boolArg(request, "scopeExact") ?? false
		let timeoutMs = max(100, min(60_000, optionalIntArg(request, "timeoutMs") ?? 10_000))
		let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
		guard role?.isEmpty == false || text?.isEmpty == false || expectedValue?.isEmpty == false else {
			throw BridgeFailure(message: "axWaitFor requires role, text, or value", code: "invalid_args")
		}
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["found": false, "reason": "window_not_found"]
		}
		let rootElement: AXUIElement
		if let scopeRef = optionalStringArg(request, "scopeRef") {
			guard let scoped = refStore.element(for: scopeRef), isElement(scoped, descendantOf: window) else {
				throw BridgeFailure(message: "Condition scope ref is stale or outside the target root", code: "element_ref_invalid")
			}
			rootElement = scoped
		} else {
			rootElement = window
		}
		_ = ensureRootObserver(pid: pid)

		func matches(_ element: AXUIElement) -> Bool {
			let candidateRole = self.stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			if let role, !role.isEmpty, candidateRole != role { return false }
			if let text, !text.isEmpty {
				let subrole = self.stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
				let haystack = [
					self.stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? "",
					self.stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
					self.displayValue(element, role: candidateRole, subrole: subrole),
				].joined(separator: "\n").lowercased()
				if !haystack.contains(text) { return false }
			}
			if let expectedValue, !expectedValue.isEmpty {
				let subrole = self.stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
				if self.displayValue(element, role: candidateRole, subrole: subrole).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != expectedValue { return false }
			}
			return true
		}

		var lastCount = 0
		repeat {
			let changeGeneration = rootChangeGeneration(pid: pid)
			let collected = collectDescendantsWithContext(startingAt: rootElement, maxDepth: 12, maxNodes: 2000)
			let descendants = scopeExact ? Array(collected.prefix(1)) : collected
			lastCount = descendants.count
			if let match = descendants.first(where: { matches($0.element) }) {
				if waitForGone {
					waitForRootChange(pid: pid, since: changeGeneration, until: deadline)
					continue
				}
				let candidateRole = self.stringAttribute(match.element, attribute: kAXRoleAttribute as CFString) ?? ""
				let isBrowser = isBrowser(pid: pid)
				let containsWebArea = descendants.contains { self.stringAttribute($0.element, attribute: kAXRoleAttribute as CFString) == "AXWebArea" }
				return [
					"found": true,
					"target": self.elementPayload(
						element: match.element,
						key: "target",
						source: self.axSource(role: candidateRole, insideWebArea: match.insideWebArea, isBrowser: isBrowser, containsWebArea: containsWebArea)
					),
					"nodeCount": lastCount,
				]
			}
			if waitForGone {
				return ["found": true, "gone": true, "nodeCount": lastCount]
			}
			waitForRootChange(pid: pid, since: changeGeneration, until: deadline)
		} while Date() < deadline

		return ["found": false, "timedOut": true, "nodeCount": lastCount]
	}

}

import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

final class RequestContext {
	let requestIds: [String]
	let deadline: Double?
	let sessionId: String?
	var foregroundGrant = false
	var hidDestination: HIDDestination?
	var hidGestureActive = false
	var hidPointerLastPosted: CGPoint?
	var activationAttempted = false
	var destinationWindowStatus: String?
	var destinationWindowElement: AXUIElement?
	var destinationWindowResolved = false
	var lastDestinationCheck: Date?
	var charactersSent: Int?
	var extendedDelivery: ExtendedDeliveryTarget?
	var pidScrollWindow: ExtendedDeliveryTarget?
	var extendedDeliveryStatus: String?
	var extendedDeliveryReason: String?
	var extendedDeliveryActivated = false
	private let heartbeat: (() -> Void)?
	private let lock = NSLock()
	private var cancelRequested: Bool
	private var effect = false
	private var inputEvents = 0
	private var stopped = false
	private var step = 0

	init(requestIds: [String], deadline: Double?, sessionId: String?, cancelled: Bool = false, heartbeat: (() -> Void)? = nil) {
		self.requestIds = requestIds
		self.deadline = deadline
		self.sessionId = sessionId
		self.cancelRequested = cancelled
		self.heartbeat = heartbeat
	}

	var stopRequested: Bool {
		lock.lock()
		defer { lock.unlock() }
		return cancelRequested || (deadline.map { monotonicSeconds() >= $0 } ?? false)
	}

	func requestCancel() {
		lock.lock()
		cancelRequested = true
		lock.unlock()
	}

	func markEffect() {
		lock.lock()
		effect = true
		lock.unlock()
	}

	var effectPossible: Bool {
		lock.lock()
		defer { lock.unlock() }
		return effect
	}

	func markInputEvent() {
		lock.lock()
		inputEvents += 1
		lock.unlock()
	}

	var inputEventCount: Int {
		lock.lock()
		defer { lock.unlock() }
		return inputEvents
	}

	func beginHIDDestination(_ destination: HIDDestination?) {
		hidDestination = destination
		hidGestureActive = false
		activationAttempted = false
		destinationWindowStatus = nil
		destinationWindowElement = nil
		destinationWindowResolved = false
		lastDestinationCheck = nil
		charactersSent = nil
	}

	var isStopped: Bool {
		lock.lock()
		defer { lock.unlock() }
		return stopped
	}

	var currentStep: Int {
		lock.lock()
		defer { lock.unlock() }
		return step
	}

	func setStep(_ index: Int) {
		lock.lock()
		step = index
		lock.unlock()
	}

	func checkpoint() throws {
		heartbeat?()
		lock.lock()
		let cancelled = cancelRequested
		let expired = deadline.map { monotonicSeconds() >= $0 } ?? false
		if cancelled || expired { stopped = true }
		let effectNow = effect
		let stepNow = step
		lock.unlock()
		guard cancelled || expired else { return }
		throw BridgeFailure(
			message: cancelled ? "Request was cancelled" : "Request deadline passed before delivery completed",
			code: "cancelled",
			effectPossible: effectNow,
			result: [
				"outcome": effectNow ? "partial" : "rejected_before_delivery",
				"stoppedAt": stepNow,
				"reason": cancelled ? "cancelled" : "deadline",
			]
		)
	}
}

final class AXRefStore {
	struct Snapshot {
		let role: String
		let identifier: String
		let label: String
		let rect: CGRect
	}

	private var nextId: UInt64 = 0
	private var windows: [String: AXUIElement] = [:]
	private var windowOwners: [String: Set<String>] = [:]
	private var openWindows: Set<String> = []
	private var elements: [String: AXUIElement] = [:]
	private var elementOwners: [String: String] = [:]
	private var snapshots: [String: Snapshot] = [:]
	private let lock = NSLock()

	func storeWindow(_ window: AXUIElement) -> String {
		lock.lock()
		defer { lock.unlock() }
		let caller = currentRequestSessionId()
		func grant(_ ref: String) {
			if let caller { windowOwners[ref, default: []].insert(caller) } else { openWindows.insert(ref) }
		}
		for (ref, existing) in windows {
			if CFEqual(existing, window) {
				grant(ref)
				return ref
			}
		}
		nextId += 1
		let ref = "w\(nextId)"
		windows[ref] = window
		grant(ref)
		return ref
	}

	func storeElement(_ element: AXUIElement, snapshot: Snapshot? = nil) -> String {
		lock.lock()
		defer { lock.unlock() }
		nextId += 1
		let ref = "e\(nextId)"
		elements[ref] = element
		if let caller = currentRequestSessionId() { elementOwners[ref] = caller }
		snapshots[ref] = snapshot
		return ref
	}

	func callerMayUse(_ ref: String) -> Bool {
		lock.lock()
		defer { lock.unlock() }
		return mayUseLocked(ref)
	}

	private func mayUseLocked(_ ref: String) -> Bool {
		let caller = currentRequestSessionId()
		if windows[ref] != nil {
			if openWindows.contains(ref) { return true }
			guard let caller else { return windowOwners[ref] == nil }
			return windowOwners[ref]?.contains(caller) ?? true
		}
		if elements[ref] != nil { return sessionMayUse(owner: elementOwners[ref], caller: caller) }
		return true
	}

	func window(for ref: String) -> AXUIElement? {
		lock.lock()
		defer { lock.unlock() }
		guard mayUseLocked(ref) else { return nil }
		return windows[ref]
	}

	func element(for ref: String) -> AXUIElement? {
		lock.lock()
		defer { lock.unlock() }
		guard mayUseLocked(ref) else { return nil }
		return elements[ref]
	}

	func snapshot(for ref: String) -> Snapshot? {
		lock.lock()
		defer { lock.unlock() }
		guard mayUseLocked(ref) else { return nil }
		return snapshots[ref]
	}
}

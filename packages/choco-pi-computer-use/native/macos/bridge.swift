import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

struct BridgeFailure: Error {
	let message: String
	let code: String
	var effectPossible: Bool? = nil
	var result: [String: Any]? = nil
	var details: [String: Any]? = nil
}

func monotonicSeconds() -> Double {
	Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
}

struct CancelTombstone {
	let id: String
	let at: Double
	let sessionId: String?
}

struct InputSourceInfo {
	let id: String
	let type: String
	let asciiCapable: Bool

	var composes: Bool { type != (kTISTypeKeyboardLayout as String) && !type.isEmpty }

	static func current() -> InputSourceInfo {
		if Thread.isMainThread { return read() }
		var info = InputSourceInfo(id: "", type: "", asciiCapable: true)
		DispatchQueue.main.sync { info = read() }
		return info
	}

	private static func read() -> InputSourceInfo {
		guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
			return InputSourceInfo(id: "", type: "", asciiCapable: true)
		}
		func string(_ key: CFString) -> String {
			guard let raw = TISGetInputSourceProperty(source, key) else { return "" }
			return (Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String)
		}
		var ascii = true
		if let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) {
			ascii = CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(raw).takeUnretainedValue())
		}
		return InputSourceInfo(id: string(kTISPropertyInputSourceID), type: string(kTISPropertyInputSourceType), asciiCapable: ascii)
	}

	func diagnostics() -> [String: Any] {
		["id": id, "type": type, "asciiCapable": asciiCapable, "composes": composes]
	}
}

let requestSessionKey = "pi.computer-use.request-session"

func currentRequestSessionId() -> String? {
	Thread.current.threadDictionary[requestSessionKey] as? String
}

func sessionMayUse(owner: String?, caller: String?) -> Bool {
	owner == nil || owner == caller
}

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

struct HIDDestination {
	let pid: Int32
	let windowId: UInt32
	let window: AXUIElement?
	let frontmostBefore: pid_t?
	let inputBaseline: Int
}

struct ExtendedDeliveryTarget {
	let pid: Int32
	let windowId: UInt32
	let windowFrame: CGRect
}

final class ExtendedDeliverySupport {
	typealias PostRecordFn = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
	typealias GetPSNFn = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
	typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

	static let measuredOSMajorVersions: [Int] = [27]
	static let shared = ExtendedDeliverySupport()

	let postRecord: PostRecordFn?
	let getPSN: GetPSNFn?
	let setWindowLocation: SetWindowLocationFn?
	let osMajorVersion: Int
	let missingSymbols: [String]

	private init() {
		let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
		let everywhere = UnsafeMutableRawPointer(bitPattern: -2)
		func symbol(_ name: String) -> UnsafeMutableRawPointer? {
			if let skyLight, let found = dlsym(skyLight, name) { return found }
			return dlsym(everywhere, name)
		}
		let post = symbol("SLPSPostEventRecordTo")
		let psn = symbol("GetProcessForPID")
		let location = symbol("CGEventSetWindowLocation")
		postRecord = post.map { unsafeBitCast($0, to: PostRecordFn.self) }
		getPSN = psn.map { unsafeBitCast($0, to: GetPSNFn.self) }
		setWindowLocation = location.map { unsafeBitCast($0, to: SetWindowLocationFn.self) }
		var missing: [String] = []
		if post == nil { missing.append("SLPSPostEventRecordTo") }
		if psn == nil { missing.append("GetProcessForPID") }
		if location == nil { missing.append("CGEventSetWindowLocation") }
		missingSymbols = missing
		osMajorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
	}

	var unavailableReason: String? {
		if !missingSymbols.isEmpty { return "missing_symbols" }
		if !Self.measuredOSMajorVersions.contains(osMajorVersion) { return "os_not_measured" }
		return nil
	}

	var available: Bool { unavailableReason == nil }

	func diagnostics() -> [String: Any] {
		var output: [String: Any] = [
			"available": available,
			"osMajorVersion": osMajorVersion,
			"measuredOSMajorVersions": Self.measuredOSMajorVersions,
			"missingSymbols": missingSymbols,
		]
		if let unavailableReason { output["reason"] = unavailableReason }
		return output
	}
}

final class RequestContext {
	let requestIds: [String]
	let deadline: Double?
	let sessionId: String?
	var foregroundGrant = false
	var hidDestination: HIDDestination?
	var hidGestureActive = false
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

private struct CGWindowCandidate {
	let windowId: UInt32
	let title: String
	let bounds: CGRect
	let isOnscreen: Bool
	let layer: Int
	let zOrder: Int
}

private struct CGWindowOwnerSummary {
	let pid: Int32
	let name: String
}

private struct AXDescendant {
	let element: AXUIElement
	let depth: Int
	let insideWebArea: Bool
	let axVisible: Bool
}

private struct WindowPairing {
	let candidate: CGWindowCandidate?
	let score: Double
	let confidence: String
}

private struct CapturedWindowImage {
	let image: CGImage
	let windowId: UInt32
	let frame: CGRect
}

private struct LookRecord {
	let lookId: String
	let windowId: UInt32
	let windowFrame: CGRect
	let imageWidth: Int
	let imageHeight: Int
	let hasImage: Bool
	let rootElement: AXUIElement?
	let observedFrame: CGRect?
	var sessionId: String? = currentRequestSessionId()
}

private struct RootAXEvent {
	let sequence: UInt64
	let timestamp: TimeInterval
	let notification: String
	let element: AXUIElement?
}

private final class RootAXObserverState {
	let pid: Int32
	let observer: AXObserver
	let change = NSCondition()
	var changeGeneration: UInt64 = 0
	var events: [RootAXEvent] = []
	var nextSequence: UInt64 = 1
	var lastUsed: TimeInterval = Date().timeIntervalSince1970

	init(pid: Int32, observer: AXObserver) {
		self.pid = pid
		self.observer = observer
	}
}

private struct OCRBox {
	let string: String
	let confidence: Double
	let rect: CGRect
}

final class LookNode {
	let element: AXUIElement?
	let ref: String
	let role: String
	let subrole: String
	let identifier: String
	let title: String
	let description: String
	let value: String
	let actions: [String]
	let canPress: Bool
	let canFocus: Bool
	let canSetValue: Bool
	let canScroll: Bool
	let canIncrement: Bool
	let canDecrement: Bool
	let isTextInput: Bool
	let rect: CGRect
	let focused: Bool
	var offscreen: Bool
	var pictureOnly: Bool
	var truncated: Bool
	var scrollExtent: [String: Int]?
	var text: [[String: Any]]
	var children: [LookNode]

	init(element: AXUIElement?, ref: String, role: String, subrole: String, identifier: String, title: String, description: String, value: String, actions: [String], canPress: Bool, canFocus: Bool, canSetValue: Bool, canScroll: Bool, canIncrement: Bool, canDecrement: Bool, isTextInput: Bool, rect: CGRect, focused: Bool = false, offscreen: Bool = false, pictureOnly: Bool = false) {
		self.element = element
		self.ref = ref
		self.role = role
		self.subrole = subrole
		self.identifier = identifier
		self.title = title
		self.description = description
		self.value = value
		self.actions = actions
		self.canPress = canPress
		self.canFocus = canFocus
		self.canSetValue = canSetValue
		self.canScroll = canScroll
		self.canIncrement = canIncrement
		self.canDecrement = canDecrement
		self.isTextInput = isTextInput
		self.rect = rect
		self.focused = focused
		self.offscreen = offscreen
		self.pictureOnly = pictureOnly
		self.truncated = false
		self.text = []
		self.children = []
	}

	func payload() -> [String: Any] {
		var output: [String: Any] = [
			"ref": ref,
			"role": role,
			"subrole": subrole,
			"identifier": identifier,
			"title": title,
			"description": description,
			"value": value,
			"actions": actions,
			"canPress": canPress,
			"canFocus": canFocus,
			"canSetValue": canSetValue,
			"canScroll": canScroll,
			"canIncrement": canIncrement,
			"canDecrement": canDecrement,
			"isTextInput": isTextInput,
			"rect": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height],
			"children": children.map { $0.payload() },
		]
		if focused { output["focused"] = true }
		if offscreen { output["offscreen"] = true }
		if pictureOnly { output["pictureOnly"] = true }
		if truncated { output["truncated"] = true }
		if let scrollExtent { output["scrollExtent"] = scrollExtent }
		if !text.isEmpty { output["text"] = text }
		return output
	}

}

final class Box<T> {
	var value: T
	init(_ value: T) {
		self.value = value
	}
}

func rectPayload(_ rect: CGRect) -> [String: Any] {
	["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height]
}

final class InputSuppressionGuard {
	static let maxSuppressionSeconds: TimeInterval = 30

	private let lock = NSLock()
	private var eventTap: CFMachPort?
	private var eventTapSource: CFRunLoopSource?
	private var tapRunLoop: CFRunLoop?
	private var tapThread: Thread?

	func begin() throws {
		lock.lock()
		if eventTap != nil {
			lock.unlock()
			return
		}
		lock.unlock()

		let eventTypes: [CGEventType] = [
			.keyDown,
			.keyUp,
			.flagsChanged,
			.leftMouseDown,
			.leftMouseUp,
			.rightMouseDown,
			.rightMouseUp,
			.otherMouseDown,
			.otherMouseUp,
			.mouseMoved,
			.leftMouseDragged,
			.rightMouseDragged,
			.otherMouseDragged,
			.scrollWheel,
			.tabletPointer,
			.tabletProximity,
		]
		let mask = eventTypes.reduce(CGEventMask(0)) { partial, type in
			partial | (CGEventMask(1) << CGEventMask(type.rawValue))
		}

		let callback: CGEventTapCallBack = { _proxy, type, event, userInfo in
			guard let userInfo else { return Unmanaged.passUnretained(event) }
			let inputGuard = Unmanaged<InputSuppressionGuard>.fromOpaque(userInfo).takeUnretainedValue()
			if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
				inputGuard.reenableTap()
				return Unmanaged.passUnretained(event)
			}
			return nil
		}

		guard let tap = CGEvent.tapCreate(
			tap: .cgSessionEventTap,
			place: .headInsertEventTap,
			options: .defaultTap,
			eventsOfInterest: mask,
			callback: callback,
			userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		) else {
			throw BridgeFailure(message: "Failed to create input suppression event tap", code: "input_suppression_unavailable")
		}

		lock.lock()
		eventTap = tap
		lock.unlock()
		let thread = Thread { [weak self] in
			guard let self else { return }
			let runLoop = CFRunLoopGetCurrent()
			self.lock.lock()
			self.tapRunLoop = runLoop
			self.eventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
			if let source = self.eventTapSource {
				CFRunLoopAddSource(runLoop, source, .commonModes)
			}
			let watchdog = CFRunLoopTimerCreateWithHandler(
				kCFAllocatorDefault,
				CFAbsoluteTimeGetCurrent() + InputSuppressionGuard.maxSuppressionSeconds,
				0,
				0,
				0
			) { [weak self] _ in
				self?.end()
			}
			if let watchdog {
				CFRunLoopAddTimer(runLoop, watchdog, .commonModes)
			}
			CGEvent.tapEnable(tap: tap, enable: true)
			self.lock.unlock()
			CFRunLoopRun()
		}
		thread.name = "pi-computer-use-input-suppression"
		lock.lock()
		tapThread = thread
		lock.unlock()
		thread.start()

		let deadline = Date().addingTimeInterval(1.0)
		while tapRunLoop == nil && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.01)
		}
		if tapRunLoop == nil {
			end()
			throw BridgeFailure(message: "Timed out starting input suppression", code: "input_suppression_timeout")
		}
	}

	func end() {
		lock.lock()
		let tap = eventTap
		let source = eventTapSource
		let runLoop = tapRunLoop
		eventTap = nil
		eventTapSource = nil
		tapRunLoop = nil
		tapThread = nil
		lock.unlock()

		if let tap {
			CGEvent.tapEnable(tap: tap, enable: false)
		}
		if let source, let runLoop {
			CFRunLoopRemoveSource(runLoop, source, .commonModes)
			CFRunLoopStop(runLoop)
		}
	}

	func reenableTap() {
		lock.lock()
		let tap = eventTap
		lock.unlock()
		if let tap {
			CGEvent.tapEnable(tap: tap, enable: true)
		}
	}

}

enum AncestryResult {
	case found
	case notFound
	case inconclusive
}

enum AncestryRead<Value> {
	case value(Value)
	case absent
	case failed
}

let ancestryWalkLimit = 64

func walkAncestry<Node>(
	from start: Node,
	role: String,
	limit: Int,
	readRole: (Node) -> AncestryRead<String>,
	readParent: (Node) -> AncestryRead<Node>
) -> AncestryResult {
	var current = start
	for _ in 0..<limit {
		switch readRole(current) {
		case .value(let candidateRole):
			if candidateRole == role { return .found }
			if candidateRole == "AXApplication" { return .notFound }
		case .absent:
			break
		case .failed:
			return .inconclusive
		}
		switch readParent(current) {
		case .value(let parent):
			current = parent
		case .absent:
			return .notFound
		case .failed:
			return .inconclusive
		}
	}
	return .inconclusive
}

final class Bridge {
	private let protocolVersion = 8
	private let startedAt = Date().timeIntervalSince1970
	private let refStore = AXRefStore()
	private let inputSuppressionGuard = InputSuppressionGuard()
	private let physicalInputLock = NSRecursiveLock()
	private let supportsAgentCursor = CommandLine.arguments.contains("serve")
	private let browserBundleIds: Set<String> = [
		"com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "net.imput.helium", "org.mozilla.firefox",
	]
	private var enhancedAccessibilityPids = Set<Int32>()
	private let enhancedAccessibilityLock = NSLock()
	private var stdinBuffer = Data()
	private var output = FileHandle.standardOutput
	private var nextLookId: UInt64 = 0
	private var lookRecords: [String: LookRecord] = [:]
	private var lookRecordOrder: [String] = []
	private let lookRecordLock = NSLock()
	private var caretMemory: [(element: AXUIElement, range: CFRange)] = []
	private let caretLock = NSLock()
	private let rootObserverLock = NSLock()
	private var rootObservers: [Int32: RootAXObserverState] = [:]
	private let maxRootObservers = 4
	private let permissionCacheLock = NSLock()
	private var grantedPermissionStatus: [String: Any]?
	private let completedRequestLock = NSLock()
	private var recentCompletedRequestIds: [String] = []
	private let requestRegistryLock = NSLock()
	private var activeRequests: [String: RequestContext] = [:]
	private var completedSemanticRequests: [(id: String, sessionId: String?)] = []
	private var cancelTombstones: [CancelTombstone] = []
	private let tombstoneTTL: TimeInterval = 60
	private let tombstoneLimit = 256
	private static let requestContextKey = "pi.computer-use.request-context"
	private let ownerLock = NSLock()
	private var sessions: [String: (generation: Int, lastSeen: Double, active: Int)] = [:]
	private var sessionlessActiveRequests = 0
	private let ownerTTL: TimeInterval = 30
	private let ownerGatedCommands: Set<String> = ["act", "actBatch", "focusWindow", "setWindowFrame", "beginInputSuppression", "endInputSuppression", "restoreUserFocus", "foregroundSection"]
	private let coordination = NSCondition()
	private var targetHolders: [Int32: String] = [:]
	private var foregroundSection: ForegroundSectionState?
	private let coordinationWaitLimit: TimeInterval = 10
	private let foregroundSectionIdleTTL: TimeInterval = 10
	private let extendedActivationLock = NSLock()
	private var extendedActivations: [Int32: (count: Int, target: ExtendedDeliveryTarget)] = [:]
	private var extendedShuttingDown = false
	private var terminationSources: [DispatchSourceSignal] = []

	func run() {
		if CommandLine.arguments.contains("serve") {
			let socketPath = argumentValue("--socket") ?? defaultSocketPath()
			installTerminationHandlers()
			Thread.detachNewThread { [self] in runServer(socketPath: socketPath) }
			NSApp.run()
			return
		}
		while true {
			autoreleasepool {
				let data = FileHandle.standardInput.availableData
				if data.isEmpty {
					deactivateExtendedTargets()
					exit(0)
				}
				stdinBuffer.append(data)
				processBufferedInput()
			}
		}
	}

	private func argumentValue(_ name: String) -> String? {
		guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else { return nil }
		return CommandLine.arguments[index + 1]
	}

	private func defaultSocketPath() -> String {
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		return "\(home)/Library/Caches/pi-computer-use/bridge.sock"
	}

	private func runServer(socketPath: String) {
		_ = signal(SIGPIPE, SIG_IGN)
		try? FileManager.default.createDirectory(atPath: (socketPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
		let lockPath = "\(socketPath).lock"
		let lockFile = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
		if lockFile < 0 || flock(lockFile, LOCK_EX | LOCK_NB) != 0 {
			if lockFile >= 0 { close(lockFile) }
			exit(0)
		}
		unlink(socketPath)
		let server = socket(AF_UNIX, SOCK_STREAM, 0)
		if server < 0 { close(lockFile); exit(1) }
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let sunPathCapacity = MemoryLayout.size(ofValue: address.sun_path)
		let bytes = Array(socketPath.utf8.prefix(sunPathCapacity - 1))
		withUnsafeMutablePointer(to: &address.sun_path) { pointer in
			pointer.withMemoryRebound(to: CChar.self, capacity: sunPathCapacity) { dest in
				for (index, byte) in bytes.enumerated() { dest[index] = CChar(bitPattern: byte) }
			}
		}
		let bindStatus = withUnsafePointer(to: &address) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		if bindStatus != 0 || listen(server, 8) != 0 { close(server); close(lockFile); exit(1) }
		while true {
			let client = accept(server, nil, nil)
			if client < 0 { continue }
			var noSigPipe: Int32 = 1
			_ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout.size(ofValue: noSigPipe)))
			Thread.detachNewThread { [weak self] in self?.processClient(client) }
		}
	}

	private func processClient(_ client: Int32) {
		let clientInput = FileHandle(fileDescriptor: client, closeOnDealloc: true)
		var buffer = Data()
		let newline = Data([0x0A])
		while true {
			let data = clientInput.availableData
			if data.isEmpty { break }
			buffer.append(data)
			while let range = buffer.range(of: newline) {
				let lineData = buffer.subdata(in: 0..<range.lowerBound)
				buffer.removeSubrange(0..<range.upperBound)
				if let line = String(data: lineData, encoding: .utf8), !line.isEmpty { handleLine(line, to: client) }
			}
		}
		clientInput.closeFile()
	}

	private func processBufferedInput() {
		let newline = Data([0x0A])
		while let range = stdinBuffer.range(of: newline) {
			let lineData = stdinBuffer.subdata(in: 0..<range.lowerBound)
			stdinBuffer.removeSubrange(0..<range.upperBound)

			guard !lineData.isEmpty else { continue }
			guard let line = String(data: lineData, encoding: .utf8) else { continue }
			handleLine(line)
		}
	}

	private func handleLine(_ line: String, to responseSocket: Int32? = nil) {
		let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }

		let fallbackId = "invalid"
		var completionId: String?
		let receivedAt = monotonicSeconds()
		defer {
			if responseSocket != nil, let completionId { recordCompletedRequest(completionId) }
		}
		do {
			guard let jsonData = trimmed.data(using: .utf8) else {
				throw BridgeFailure(message: "Input was not valid UTF-8", code: "invalid_request")
			}
			guard let object = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
				throw BridgeFailure(message: "Request must be a JSON object", code: "invalid_request")
			}
			let id = (object["id"] as? String) ?? fallbackId
			completionId = id

			do {
				let result = try handleRequest(object, receivedAt: receivedAt)
				send([
					"id": id,
					"ok": true,
					"result": result,
				], to: responseSocket)
			} catch let failure as BridgeFailure {
				var error: [String: Any] = [
					"message": failure.message,
					"code": failure.code,
				]
				if let effectPossible = failure.effectPossible { error["effectPossible"] = effectPossible }
				for (key, value) in failure.details ?? [:] where error[key] == nil { error[key] = value }
				var payload: [String: Any] = ["id": id, "ok": false, "error": error]
				if let result = failure.result { payload["result"] = result }
				send(payload, to: responseSocket)
			} catch {
				send([
					"id": id,
					"ok": false,
					"error": [
						"message": error.localizedDescription,
						"code": "internal_error",
					],
				], to: responseSocket)
			}
		} catch let failure as BridgeFailure {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": failure.message,
					"code": failure.code,
				],
			], to: responseSocket)
		} catch {
			send([
				"id": fallbackId,
				"ok": false,
				"error": [
					"message": error.localizedDescription,
					"code": "internal_error",
				],
			], to: responseSocket)
		}
	}

	private func send(_ payload: [String: Any], to responseSocket: Int32? = nil) {
		guard JSONSerialization.isValidJSONObject(payload),
			let data = try? JSONSerialization.data(withJSONObject: payload),
			let line = String(data: data, encoding: .utf8),
			let out = (line + "\n").data(using: .utf8)
		else {
			return
		}

		guard let responseSocket else {
			try? output.write(contentsOf: out)
			return
		}
		out.withUnsafeBytes { raw in
			guard let base = raw.baseAddress else { return }
			var offset = 0
			while offset < raw.count {
				let sent = Darwin.send(responseSocket, base.advanced(by: offset), raw.count - offset, 0)
				if sent <= 0 { return }
				offset += sent
			}
		}
	}

	private func recordCompletedRequest(_ id: String) {
		completedRequestLock.lock()
		recentCompletedRequestIds.removeAll { $0 == id }
		recentCompletedRequestIds.append(id)
		if recentCompletedRequestIds.count > 32 {
			recentCompletedRequestIds.removeFirst(recentCompletedRequestIds.count - 32)
		}
		completedRequestLock.unlock()
	}

	private func completedRequestIds() -> [String] {
		completedRequestLock.lock()
		defer { completedRequestLock.unlock() }
		return recentCompletedRequestIds
	}

	private func requestSession(_ request: [String: Any]) -> (id: String, generation: Int)? {
		let raw = (request["session"] as? [String: Any])
			?? ((request["actions"] as? [[String: Any]])?.first?["session"] as? [String: Any])
		guard let raw, let id = raw["id"] as? String, !id.isEmpty else { return nil }
		return (id, (raw["generation"] as? NSNumber)?.intValue ?? 0)
	}

	private func authorizeOwner(_ session: (id: String, generation: Int)?, pin: Bool) throws {
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
	}

	private func pruneExpiredSessions() -> [String] {
		ownerLock.lock()
		defer { ownerLock.unlock() }
		let now = monotonicSeconds()
		let expired = sessions.filter { $0.value.active == 0 && now - $0.value.lastSeen >= ownerTTL }.map { $0.key }
		for id in expired { sessions.removeValue(forKey: id) }
		return expired
	}

	private func finishExpiredSessions(_ ids: [String]) {
		for id in ids {
			dropLookRecords(sessionId: id)
			releaseForegroundSection(holder: id, restore: true)
		}
	}

	private func endOwnedRequest(_ session: (id: String, generation: Int)?) {
		ownerLock.lock()
		if let session, let current = sessions[session.id], current.generation == session.generation {
			sessions[session.id] = (current.generation, monotonicSeconds(), max(0, current.active - 1))
		} else if session == nil {
			sessionlessActiveRequests = max(0, sessionlessActiveRequests - 1)
		} else if let session, let current = sessions[session.id] {
			sessions[session.id] = (current.generation, current.lastSeen, max(0, current.active - 1))
		}
		ownerLock.unlock()
	}

	private func refreshOwner(_ session: (id: String, generation: Int)) {
		ownerLock.lock()
		if let current = sessions[session.id] {
			if current.generation == session.generation {
				sessions[session.id] = (current.generation, monotonicSeconds(), current.active)
			}
		} else {
			sessions[session.id] = (session.generation, monotonicSeconds(), 0)
		}
		ownerLock.unlock()
		coordination.lock()
		if var section = foregroundSection, section.holder == session.id {
			section.lastSeen = monotonicSeconds()
			foregroundSection = section
		}
		coordination.unlock()
	}

	private func releaseOwner(_ session: (id: String, generation: Int)?) throws -> Bool {
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
		ownerLock.unlock()
		dropLookRecords(sessionId: session.id)
		releaseForegroundSection(holder: session.id, restore: false)
		return true
	}

	private func otherSessionsActive(caller: String?) -> Int {
		ownerLock.lock()
		defer { ownerLock.unlock() }
		var count = caller == nil ? max(0, sessionlessActiveRequests - 1) : sessionlessActiveRequests
		for (id, entry) in sessions where id != caller { count += entry.active }
		return count
	}

	private func sessionDiagnostics() -> [String: Any] {
		let now = monotonicSeconds()
		ownerLock.lock()
		let live = sessions.values.filter { $0.active > 0 || now - $0.lastSeen < ownerTTL }
		let active = live.reduce(0) { $0 + $1.active } + sessionlessActiveRequests
		ownerLock.unlock()
		coordination.lock()
		let held = foregroundSection != nil
		let busyTargets = targetHolders.count
		coordination.unlock()
		return ["live": live.count, "activeRequests": active, "foregroundSectionHeld": held, "busyTargets": busyTargets, "ttlMs": Int(ownerTTL * 1000)]
	}

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

	private func onTarget<T>(_ pid: Int32, keys: (request: String, session: String), context: RequestContext?, _ body: () throws -> T) throws -> T {
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

	private func inForeground<T>(_ request: [String: Any], keys: (request: String, session: String), pid: Int32?, context: RequestContext?, _ body: () throws -> T) throws -> T {
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

	private func foregroundSectionCommand(_ request: [String: Any], session: (id: String, generation: Int)?) throws -> [String: Any] {
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
	private func releaseForegroundSection(holder: String, restore: Bool) -> Bool {
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

	private func activeRequestContext() -> RequestContext? {
		Thread.current.threadDictionary[Bridge.requestContextKey] as? RequestContext
	}

	private func checkpoint() throws {
		try activeRequestContext()?.checkpoint()
	}

	private func foregroundRequired(_ message: String) -> BridgeFailure {
		BridgeFailure(message: message, code: "foreground_required", effectPossible: activeRequestContext()?.effectPossible ?? false)
	}

	private static let windowLevelFocusRoles: Set<String> = ["AXWindow", "AXSheet", "AXDrawer", "AXApplication", "AXSystemWide"]

	private func axFocusRefusal(_ element: AXUIElement, foregroundGranted: Bool) -> BridgeFailure? {
		if foregroundGranted { return nil }
		guard let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString), !role.isEmpty else {
			return foregroundRequired("The focus target's role is unreadable; focusing it requires a host foreground grant")
		}
		if Bridge.windowLevelFocusRoles.contains(role) {
			return foregroundRequired("Focusing a \(role) is window-level focus and requires a host foreground grant")
		}
		switch ancestorRole(element, role: "AXWebArea") {
		case .notFound:
			return nil
		case .found:
			if activeRequestContext()?.extendedDelivery != nil { return nil }
			return foregroundRequired("Focusing web content requires a host foreground grant")
		case .inconclusive:
			return foregroundRequired("The focus target's web-content ancestry is inconclusive (ancestry inconclusive); focusing it requires a host foreground grant")
		}
	}

	private func setAXFocus(_ element: AXUIElement, foregroundGranted: Bool) throws -> AXError {
		if let refusal = axFocusRefusal(element, foregroundGranted: foregroundGranted) { throw refusal }
		try checkpoint()
		activeRequestContext()?.markEffect()
		return AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	}

	private func replaceTextThroughEditor(_ element: AXUIElement, text: String, foregroundGranted: Bool) throws -> (value: String?, stage: String) {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		guard ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role), !isSecureTextElement(role: role, subrole: subrole) else { return (nil, "role") }
		func settable(_ attribute: String) -> Bool {
			var flag = DarwinBoolean(false)
			return AXUIElementIsAttributeSettable(element, attribute as CFString, &flag) == .success && flag.boolValue
		}
		if boolAttribute(element, attribute: kAXFocusedAttribute as CFString) != true {
			guard settable(kAXFocusedAttribute) else { return (nil, "focus_not_settable") }
			guard try setAXFocus(element, foregroundGranted: foregroundGranted) == .success else { return (nil, "focus_failed") }
		}
		guard settable(kAXSelectedTextAttribute) else { return (nil, "selected_text_not_settable") }
		guard settable(kAXSelectedTextRangeAttribute) else { return (nil, "range_not_settable") }
		try checkpoint()
		let current = stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
		var range = CFRange(location: 0, length: (current as NSString).length)
		guard let selection = AXValueCreate(.cfRange, &range),
			AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection) == .success
		else { return (nil, "range_failed") }
		let status = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
		guard status == .success else { return (nil, "selected_text_failed_\(status.rawValue)") }
		return (stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? "", "written")
	}

	private func rememberCaret(_ element: AXUIElement) {
		guard let range = textBaseline(element)?.selection else { return }
		caretLock.lock()
		defer { caretLock.unlock() }
		caretMemory.removeAll { CFEqual($0.element, element) }
		caretMemory.append((element, range))
		if caretMemory.count > 64 { caretMemory.removeFirst(caretMemory.count - 64) }
	}

	private func rememberedCaret(_ element: AXUIElement) -> CFRange? {
		caretLock.lock()
		defer { caretLock.unlock() }
		return caretMemory.last { CFEqual($0.element, element) }?.range
	}

	private func focusKeepingCaret(_ element: AXUIElement, foregroundGranted: Bool) throws -> AXError {
		if boolAttribute(element, attribute: kAXFocusedAttribute as CFString) == true { return .success }
		let status = try setAXFocus(element, foregroundGranted: foregroundGranted)
		guard status == .success, let after = textBaseline(element), let selection = after.selection else { return status }
		let length = (after.value as NSString).length
		guard length > 0, selection.location == 0, selection.length == length else { return status }
		var caret = CFRange(location: length, length: 0)
		if let remembered = rememberedCaret(element), remembered.location >= 0, remembered.length >= 0, remembered.location + remembered.length <= length {
			caret = remembered
		}
		if let value = AXValueCreate(.cfRange, &caret) {
			_ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
		}
		return status
	}

	struct TextBaseline {
		let value: String
		let selection: CFRange?
	}

	private func textBaseline(_ element: AXUIElement) -> TextBaseline? {
		guard let value = stringAttribute(element, attribute: kAXValueAttribute as CFString) else { return nil }
		var selection: CFRange?
		if let raw = copyAttribute(element, attribute: kAXSelectedTextRangeAttribute as CFString), CFGetTypeID(raw as CFTypeRef) == AXValueGetTypeID() {
			let axValue = unsafeBitCast(raw as CFTypeRef, to: AXValue.self)
			var range = CFRange()
			if AXValueGetType(axValue) == .cfRange, AXValueGetValue(axValue, .cfRange, &range) { selection = range }
		}
		return TextBaseline(value: value, selection: selection)
	}

	private func expectedTypedValue(_ baseline: TextBaseline, text: String) -> String {
		let current = baseline.value as NSString
		guard let range = baseline.selection, range.location >= 0, range.length >= 0, range.location + range.length <= current.length else {
			return baseline.value + text
		}
		return current.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
	}

	private func insertTextThroughEditor(_ element: AXUIElement, text: String, foregroundGranted: Bool) throws -> (value: String?, expected: String)? {
		guard !text.isEmpty, !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		guard ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role), !isSecureTextElement(role: role, subrole: subrole) else { return nil }
		guard ancestorRole(element, role: "AXWebArea") == .notFound else { return nil }
		func settable(_ attribute: String) -> Bool {
			var flag = DarwinBoolean(false)
			return AXUIElementIsAttributeSettable(element, attribute as CFString, &flag) == .success && flag.boolValue
		}
		if boolAttribute(element, attribute: kAXFocusedAttribute as CFString) != true {
			guard settable(kAXFocusedAttribute), try focusKeepingCaret(element, foregroundGranted: foregroundGranted) == .success else { return nil }
		}
		guard settable(kAXSelectedTextAttribute), let baseline = textBaseline(element) else { return nil }
		try checkpoint()
		activeRequestContext()?.markEffect()
		let status = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
		let value = stringAttribute(element, attribute: kAXValueAttribute as CFString)
		if status != .success && value == baseline.value { return nil }
		return (value, expectedTypedValue(baseline, text: text))
	}

	private func requirePidKeyDestination(pid: Int32, record: LookRecord, element: AXUIElement?) throws -> String {
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.5)
		let observed = lookWindowElement(record, pid: pid) ?? windowElement(pid: pid, windowId: record.windowId)
		let effect = activeRequestContext()?.effectPossible ?? false
		func conflict(_ window: AXUIElement) -> BridgeFailure {
			let title = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			return BridgeFailure(
				message: "key_window_conflict: keyboard input of \(appLabel(pid)) goes to another of its windows (\"\(title)\"), not the observed one; no key was sent. Another session or the user may be using that window: retry later, or observe and act on the window that has the keyboard focus",
				code: "key_window_conflict",
				effectPossible: effect,
				details: ["inputSent": false, "focusedWindowTitle": title, "retry": "later_or_other_window"]
			)
		}
		if let keyWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement),
			let observed, !windowsRelated(keyWindow, observed)
		{
			throw conflict(keyWindow)
		}
		if let focused = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement) {
			let focusedRole = stringAttribute(focused, attribute: kAXRoleAttribute as CFString) ?? ""
			let focusedWindow = copyAttribute(focused, attribute: kAXWindowAttribute as CFString).flatMap(asAXElement)
				?? (Bridge.windowLevelFocusRoles.contains(focusedRole) ? focused : nil)
			if let focusedWindow, let observed, !windowsRelated(focusedWindow, observed) { throw conflict(focusedWindow) }
			if let element, !(sameElement(focused, element) || isElement(focused, descendantOf: element) || isElement(element, descendantOf: focused)) {
				throw BridgeFailure(message: "The app's keyboard focus is not on the target element; no key was sent. Pointer input or a foreground grant is needed to focus it", code: "foreground_required", effectPossible: effect, details: ["inputSent": false])
			}
			if focusedWindow != nil && observed != nil { return "verified" }
		}
		let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		if windows.count == 1, let observed, windowsRelated(windows[0], observed) { return "single_window" }
		throw BridgeFailure(message: "The helper could not verify which window of the app receives keys; no key was sent", code: "foreground_required", effectPossible: effect, details: ["inputSent": false])
	}

	private func requireKeyTextSource(delivery: String) throws {
		guard delivery == "hid" else { return }
		let source = InputSourceInfo.current()
		guard source.composes else { return }
		throw BridgeFailure(
			message: "input_source_composes: the current input source (\(source.id)) composes typed keys, so this text would not arrive as requested; no key was sent. Use set_text on a native field, or switch to a keyboard layout input source",
			code: "input_source_composes",
			effectPossible: activeRequestContext()?.effectPossible ?? false,
			details: ["inputSent": false, "inputSource": source.diagnostics()]
		)
	}

	private func tracked(requestIds: [String], deadline: Double?, session: (id: String, generation: Int)?, grantedHID: Bool = false, _ body: () throws -> [String: Any]) throws -> [String: Any] {
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

	private func cancelRequest(_ request: [String: Any], session: (id: String, generation: Int)?) throws -> [String: Any] {
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

	private func requestDeadline(_ requests: [[String: Any]], receivedAt: Double) throws -> Double? {
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

	private func isGrantedHIDRequest(_ request: [String: Any]) -> Bool {
		switch request["cmd"] as? String {
		case "act":
			return isGrantedHIDAct(request)
		case "actBatch":
			return (request["actions"] as? [[String: Any]] ?? []).contains { isGrantedHIDAct($0) }
		default:
			return false
		}
	}

	private func handleRequest(_ request: [String: Any], receivedAt: Double) throws -> Any {
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
		defer { threadDictionary.removeObject(forKey: requestSessionKey) }
		let requestKey = "req:" + UUID().uuidString
		let keys = (request: requestKey, session: session?.id ?? requestKey)
		let gated = ownerGatedCommands.contains(cmd)
		if gated {
			try authorizeOwner(session, pin: true)
		} else if let session {
			finishExpiredSessions(pruneExpiredSessions())
			refreshOwner(session)
		}
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
			return try listWindows(pid: Int32(try intArg(request, "pid")))
		case "listRoots":
			return try listRoots(pid: optionalIntArg(request, "pid").map { Int32($0) }, title: optionalStringArg(request, "title"))
		case "getFrontmost":
			return try getFrontmost()
		case "getUserContext":
			return try getUserContext(request)
		case "beginInputSuppression":
			return try beginInputSuppression()
		case "endInputSuppression":
			return endInputSuppression()
		case "restoreUserFocus":
			return try inForeground(request, keys: keys, pid: nil, context: nil) { try restoreUserFocus(request) }
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
					try onTarget(pid, keys: keys, context: context) { try act(request) }
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
					try onTarget(pid, keys: keys, context: context) { try actBatch(request) }
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

	private func stringArg(_ request: [String: Any], _ key: String) throws -> String {
		if let value = request[key] as? String {
			return value
		}
		throw BridgeFailure(message: "Missing string argument '\(key)'", code: "invalid_args")
	}

	private func optionalStringArg(_ request: [String: Any], _ key: String) -> String? {
		if let value = request[key] as? String {
			return value
		}
		return nil
	}

	private func intArg(_ request: [String: Any], _ key: String) throws -> Int {
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

	private func optionalIntArg(_ request: [String: Any], _ key: String) -> Int? {
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

	private func boolArg(_ request: [String: Any], _ key: String) -> Bool? {
		if let value = request[key] as? Bool { return value }
		if let value = request[key] as? NSNumber { return value.boolValue }
		return nil
	}

	private func doubleArg(_ request: [String: Any], _ key: String) throws -> Double {
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

	private func processPath(pid: pid_t) -> String? {
		var buffer = [CChar](repeating: 0, count: 4096)
		let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
		return length > 0 ? String(cString: buffer) : nil
	}

	private func processName(pid: pid_t) -> String? {
		processPath(pid: pid).map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent }
	}

	private func diagnostics() -> [String: Any] {
		let permissions: [String: Any] = [
			"accessibility": AXIsProcessTrusted(),
			"screenRecording": {
				if #available(macOS 10.15, *) { return CGPreflightScreenCaptureAccess() }
				return true
			}(),
		]
		#if arch(arm64)
		let arch = "arm64"
		#elseif arch(x86_64)
		let arch = "x86_64"
		#else
		let arch = "unknown"
		#endif
		let parentPid = Int32(getppid())
		let parentApp = NSRunningApplication(processIdentifier: parentPid)
		let parentPath = processPath(pid: parentPid)
		var output: [String: Any] = [
			"protocolVersion": protocolVersion,
			"architectureVersion": 1,
			"invariants": [
				"state-scoped-observations", "bounded-observation-history", "multi-root-forest", "progressive-disclosure", "atomic-physical-input", "concurrent-requests",
				"transactional-batching", "foreground-grant-enforced", "request-cancellation", "session-ownership", "owner-checked-cancel", "monotonic-deadlines",
				"verified-focus-restore", "owner-checked-app-blocklist", "local-pointer-evidence",
				"client-ancestry-blocklist", "hid-input-sent-on-every-error", "observed-window-destination",
				"post-release-destination-check", "path-segment-pointer-evidence", "editor-text-commit",
				"extended-background-delivery", "multi-session", "per-target-serialization", "exclusive-foreground-section",
				"session-scoped-looks", "layout-independent-text", "verified-text-entry", "pid-key-destination-check",
			],
			"pid": Int32(getpid()),
			"parentPid": parentPid,
			"executablePath": CommandLine.arguments.first ?? "",
			"startedAt": startedAt,
			"macOS": ProcessInfo.processInfo.operatingSystemVersionString,
			"arch": arch,
			"accessibility": permissions["accessibility"] ?? false,
			"screenRecording": permissions["screenRecording"] ?? false,
			"recentCompletedRequestIds": completedRequestIds(),
			"extendedDelivery": ExtendedDeliverySupport.shared.diagnostics(),
			"sessions": sessionDiagnostics(),
			"inputSource": InputSourceInfo.current().diagnostics(),
		]
		if let parentPath {
			output["parentPath"] = parentPath
		}
		if let parentAppName = parentApp?.localizedName ?? parentPath.map({ URL(fileURLWithPath: $0).lastPathComponent }) {
			output["parentAppName"] = parentAppName
		}
		if let parentBundleId = parentApp?.bundleIdentifier {
			output["parentBundleId"] = parentBundleId
		}
		return output
	}

	private func screenRecordingCapturable() -> Bool {
		if #available(macOS 14.0, *) {
			let sema = DispatchSemaphore(value: 0)
			let capturable = Box<Bool>(false)
			SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { shareable, error in
				if let shareable = shareable {
					capturable.value = !shareable.displays.isEmpty
				}
				sema.signal()
			}
			guard sema.wait(timeout: .now() + .seconds(5)) == .success else { return false }
			return capturable.value
		}
		if #available(macOS 10.15, *) {
			return CGPreflightScreenCaptureAccess()
		}
		return true
	}

	private func permissionSource() -> [String: Any] {
		let parentPid = Int32(getppid())
		let executable = CommandLine.arguments.first ?? ""
		var source: [String: Any] = [
			"pid": Int(getpid()),
			"parentPid": Int(parentPid),
			"executablePath": executable,
			"macOS": ProcessInfo.processInfo.operatingSystemVersionString,
		]
		if let parentPath = processPath(pid: parentPid) {
			source["parentPath"] = parentPath
		}
		if let parentBundleId = NSRunningApplication(processIdentifier: parentPid)?.bundleIdentifier {
			source["parentBundleId"] = parentBundleId
		}
		let attribution: String
		if executable.contains("/pi-computer-use.app/Contents/MacOS/"), parentPid == 1 {
			attribution = "helper-app"
		} else {
			attribution = "caller"
		}
		source["attribution"] = attribution
		return source
	}

	private func checkPermissions() -> [String: Any] {
		permissionCacheLock.lock()
		if let cached = grantedPermissionStatus {
			permissionCacheLock.unlock()
			return cached
		}
		permissionCacheLock.unlock()
		let accessibility = AXIsProcessTrusted()
		let screenRecordingPreflight: Bool
		if #available(macOS 10.15, *) {
			screenRecordingPreflight = CGPreflightScreenCaptureAccess()
		} else {
			screenRecordingPreflight = true
		}
		let capturable = screenRecordingCapturable()
		let result: [String: Any] = [
			"accessibility": accessibility,
			"screenRecording": capturable,
			"screenRecordingPreflight": screenRecordingPreflight,
			"screenRecordingCapturable": capturable,
			"source": permissionSource(),
		]
		if accessibility && capturable {
			permissionCacheLock.lock()
			grantedPermissionStatus = result
			permissionCacheLock.unlock()
		}
		return result
	}

	private func registerPermissions() throws -> [String: Any] {
		let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
		let accessibility = AXIsProcessTrustedWithOptions(options)
		if #available(macOS 10.15, *) {
			_ = CGRequestScreenCaptureAccess()
		}
		let capturable = screenRecordingCapturable()
		return [
			"accessibility": accessibility,
			"screenRecording": capturable,
			"screenRecordingCapturable": capturable,
		]
	}

	private func openPermissionPane(_ request: [String: Any]) throws -> [String: Any] {
		let kind = try stringArg(request, "kind")
		let urlString: String
		switch kind {
		case "accessibility":
			urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
		case "screenRecording", "screenrecording":
			urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
		default:
			throw BridgeFailure(message: "Unknown permission pane '\(kind)'", code: "invalid_args")
		}

		guard let url = URL(string: urlString) else {
			throw BridgeFailure(message: "Invalid permission pane URL", code: "internal_error")
		}
		let opened = NSWorkspace.shared.open(url)
		return ["opened": opened]
	}

	private func pidIsAlive(_ pid: pid_t) -> Bool {
		pid > 0 && kill(pid, 0) == 0
	}

	private func listApps(cgEntries: [[String: Any]]? = nil) -> [[String: Any]] {
		let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let apps = NSWorkspace.shared.runningApplications.filter { app in
			app.processIdentifier != getpid() && pidIsAlive(app.processIdentifier)
		}
		var seen = Set<Int32>()
		var output = apps.map { app in
			seen.insert(app.processIdentifier)
			var data: [String: Any] = [
				"appName": app.localizedName ?? processName(pid: app.processIdentifier) ?? "Unknown App",
				"pid": Int(app.processIdentifier),
				"isFrontmost": app.processIdentifier == frontmostPid,
			]
			if let bundleId = app.bundleIdentifier {
				data["bundleId"] = bundleId
			}
			return data
		}

		for owner in cgWindowOwners(entries: cgEntries) where owner.pid != getpid() && !seen.contains(owner.pid) && pidIsAlive(owner.pid) {
			seen.insert(owner.pid)
			output.append([
				"appName": owner.name,
				"pid": Int(owner.pid),
				"isFrontmost": owner.pid == frontmostPid,
			])
		}
		return output
	}

	private func getFrontmost() throws -> [String: Any] {
		let frontPid = currentFrontmostPid() ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
		guard let frontPid, let app = NSRunningApplication(processIdentifier: frontPid) else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		var result: [String: Any] = ["appName": app.localizedName ?? "Unknown App", "pid": Int(frontPid)]
		if let bundleId = app.bundleIdentifier { result["bundleId"] = bundleId }
		guard let key = keyWindow(pid: frontPid) else {
			result["windowSource"] = "unknown"
			return result
		}
		result["windowSource"] = key.source
		result["windowTitle"] = stringAttribute(key.window, attribute: kAXTitleAttribute as CFString) ?? ""
		result["windowRef"] = refStore.storeWindow(key.window)
		if let windowId = cgWindowId(of: key.window, pid: frontPid) { result["windowId"] = Int(windowId) }
		return result
	}

	private func keyWindow(pid: Int32) -> (window: AXUIElement, source: String)? {
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.5)
		if let focused = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement) {
			return (focused, "focused")
		}
		if let main = copyAttribute(appElement, attribute: kAXMainWindowAttribute as CFString).flatMap(asAXElement) {
			return (main, "main")
		}
		return nil
	}

	private func cgWindowId(of window: AXUIElement, pid: Int32) -> UInt32? {
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.5)
		let windows = Array(axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).prefix(128))
		let candidates = cgWindowCandidates(pid: pid)
		let pairings = windowPairings(windows: windows, candidates: candidates)
		for candidate in windows {
			if sameElement(candidate, window) { return pairings[ObjectIdentifier(candidate)]?.candidate?.windowId }
			for sheet in sheetElements(of: candidate) where sameElement(sheet, window) {
				return bestCandidate(for: sheet, candidates: candidates)?.windowId
			}
		}
		return nil
	}

	private func isKeyWindow(_ window: AXUIElement, pid: Int32) -> Bool {
		guard let key = keyWindow(pid: pid), key.source == "focused" else { return false }
		return windowsRelated(key.window, window)
	}

	private func waitUntil(seconds: Double, _ condition: () -> Bool) -> Bool {
		let end = monotonicSeconds() + seconds
		while true {
			if condition() { return true }
			if monotonicSeconds() >= end { return false }
			usleep(20_000)
		}
	}

	private func getUserContext(_ request: [String: Any]) throws -> [String: Any] {
		guard let app = NSWorkspace.shared.frontmostApplication else {
			throw BridgeFailure(message: "No frontmost app available", code: "frontmost_unavailable")
		}
		let pid = app.processIdentifier
		try enforceAppPolicy(owner: pid, request: request)
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement)
		let focusedElement = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement)
		var result: [String: Any] = [
			"appName": app.localizedName ?? "Unknown App",
			"pid": Int(pid),
		]
		if let bundleId = app.bundleIdentifier {
			result["bundleId"] = bundleId
		}
		if let window = focusedWindow {
			result["window"] = [
				"title": stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? "",
				"role": stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? "",
				"subrole": stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? "",
			]
		}
		if let element = focusedElement {
			let focusedRole = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let focusedSubrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
			result["focusedElement"] = [
				"role": focusedRole,
				"subrole": focusedSubrole,
				"title": stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? "",
				"description": stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
				"value": displayValue(element, role: focusedRole, subrole: focusedSubrole),
			]
		}
		return result
	}

	private func beginInputSuppression() throws -> [String: Any] {
		try inputSuppressionGuard.begin()
		return ["active": true]
	}

	private func endInputSuppression() -> [String: Any] {
		inputSuppressionGuard.end()
		return ["active": false]
	}

	private struct AppBlocklist {
		let bundleIds: Set<String>
		let pids: Set<Int32>
		var unknownAncestryOf: Int32?
	}

	private func appBlocklist(_ request: [String: Any]) throws -> AppBlocklist {
		guard let raw = request["appBlocklist"] else { return AppBlocklist(bundleIds: [], pids: []) }
		guard let object = raw as? [String: Any],
			let bundleIds = (object["bundleIds"] ?? [String]()) as? [String],
			let pids = (object["pids"] ?? [NSNumber]()) as? [NSNumber]
		else {
			throw BridgeFailure(message: "appBlocklist must be {bundleIds: [string], pids: [integer], clientPid?: integer}", code: "invalid_args", effectPossible: false)
		}
		var blockedPids = Set(pids.map { $0.int32Value })
		var unknownAncestryOf: Int32?
		if let rawClient = object["clientPid"] {
			guard let clientPid = rawClient as? NSNumber, clientPid.int32Value > 1 else {
				throw BridgeFailure(message: "appBlocklist.clientPid must be a process id", code: "invalid_args", effectPossible: false)
			}
			if let ancestry = processAncestry(of: clientPid.int32Value) {
				blockedPids.formUnion(ancestry)
			} else {
				unknownAncestryOf = clientPid.int32Value
			}
		}
		let normalized = bundleIds.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
		return AppBlocklist(bundleIds: Set(normalized), pids: blockedPids, unknownAncestryOf: unknownAncestryOf)
	}

	private func parentPid(of pid: Int32) -> Int32? {
		var info = kinfo_proc()
		var size = MemoryLayout<kinfo_proc>.stride
		var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
		let status = mib.withUnsafeMutableBufferPointer { buffer in
			sysctl(buffer.baseAddress, u_int(buffer.count), &info, &size, nil, 0)
		}
		guard status == 0, size > 0, info.kp_proc.p_pid == pid else { return nil }
		return info.kp_eproc.e_ppid
	}

	private static let processAncestryLimit = 4096

	private func processAncestry(of pid: Int32) -> Set<Int32>? {
		var chain = Set<Int32>()
		var current = pid
		while current > 1 {
			guard chain.count < Self.processAncestryLimit, chain.insert(current).inserted, let parent = parentPid(of: current) else { return nil }
			current = parent
		}
		return chain
	}

	private func ownerBundleIds(pid: Int32) -> (bundleIds: [String], pathKnown: Bool) {
		var ids: [String] = []
		if let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier { ids.append(bundleId) }
		guard let path = processPath(pid: pid) else { return (ids, false) }
		var url = URL(fileURLWithPath: path)
		while url.pathComponents.count > 1 {
			url.deleteLastPathComponent()
			if url.pathExtension.lowercased() == "app", let bundleId = Bundle(url: url)?.bundleIdentifier, !ids.contains(bundleId) {
				ids.append(bundleId)
			}
		}
		return (ids, true)
	}

	private func enforceAppPolicy(owner pid: Int32, request: [String: Any], act: Bool = false) throws {
		let list = try appBlocklist(request)
		let identity = ownerBundleIds(pid: pid)
		let ownBundleId = Bundle.main.bundleIdentifier?.lowercased()
		let lowered = identity.bundleIds.map { $0.lowercased() }
		let match: String
		var bundleId = identity.bundleIds.first
		if pid == getpid() || (ownBundleId != nil && lowered.contains(ownBundleId ?? "")) {
			match = "helper"
		} else if list.unknownAncestryOf != nil {
			match = "unknown_ancestry"
		} else if list.pids.contains(pid) {
			match = "pid"
		} else if let index = lowered.firstIndex(where: { list.bundleIds.contains($0) }) {
			match = "bundle_id"
			bundleId = identity.bundleIds[index]
		} else if !list.bundleIds.isEmpty && identity.bundleIds.isEmpty && !identity.pathKnown {
			match = "unknown_owner"
		} else {
			return
		}
		let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? processName(pid: pid) ?? "pid \(pid)"
		var details: [String: Any] = ["blockedPid": Int(pid), "blockedApp": name, "blockMatch": match]
		if let bundleId { details["blockedBundleId"] = bundleId }
		if act { details["inputSent"] = false }
		if let client = list.unknownAncestryOf { details["unknownAncestryOf"] = Int(client) }
		let label = [bundleId, "pid \(pid)"].compactMap { $0 }.joined(separator: ", ")
		let reason: String
		switch match {
		case "unknown_owner":
			reason = "the helper could not identify the real owner of the requested window or element, so it refused it"
		case "unknown_ancestry":
			reason = "the helper could not walk the complete process ancestry of the client (pid \(list.unknownAncestryOf ?? 0)), "
				+ "so it cannot rule out that this app hosts the client (unknown ancestry), and refused it"
		default:
			reason = "the helper refused the real owner of the requested window or element"
		}
		throw BridgeFailure(
			message: "app_blocked: computer-use is not allowed to operate \(name) (\(label)); \(reason), and nothing was observed or sent to it",
			code: "app_blocked",
			effectPossible: false,
			details: details
		)
	}

	private func enforceWindowOwners(pid: Int32?, windowId: UInt32?, windowRef: String?, request: [String: Any], act: Bool = false) throws {
		var owners: [Int32] = []
		if let pid { owners.append(pid) }
		if let windowId, windowId != 0, let owner = pidForWindowId(windowId) { owners.append(owner) }
		if let windowRef, let stored = refStore.window(for: windowRef), let owner = pidForElement(stored) { owners.append(owner) }
		var seen = Set<Int32>()
		for owner in owners where seen.insert(owner).inserted {
			try enforceAppPolicy(owner: owner, request: request, act: act)
		}
	}

	private func requireForegroundGrant(_ request: [String: Any], _ operation: String) throws {
		guard (request["foregroundGrant"] as? Bool) == true else {
			throw BridgeFailure(message: "\(operation) activates or raises a window and requires a host foreground grant", code: "foreground_required", effectPossible: false)
		}
	}

	private func restoreUserFocus(_ request: [String: Any]) throws -> [String: Any] {
		try requireForegroundGrant(request, "restoreUserFocus")
		let pid = Int32(try intArg(request, "pid"))
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
			throw BridgeFailure(message: "App with pid \(pid) is no longer running", code: "app_not_found")
		}
		let frontBefore = currentFrontmostPid()
		var result: [String: Any] = ["appName": app.localizedName ?? "Unknown App", "restored": false, "appRestored": false, "windowRestored": false]
		if let frontBefore { result["frontmostBefore"] = Int(frontBefore) }
		if let expected = optionalIntArg(request, "expectedFrontmostPid"), frontBefore != Int32(expected) {
			result["reason"] = "frontmost_changed"
			return result
		}
		let resolved = userWindow(pid: pid, request: request)
		result["windowMatch"] = resolved.match
		if let window = resolved.window {
			result["windowTitle"] = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		}
		if frontBefore != pid {
			result["activationRequested"] = true
			_ = app.activate()
		}
		let appFront = waitUntil(seconds: 0.6) { currentFrontmostPid() == pid }
		var windowRestored = false
		if appFront, let window = resolved.window { windowRestored = try makeKeyWindow(window, pid: pid) }
		let windowNamed = resolved.match != "none"
		result["appRestored"] = appFront
		result["windowRestored"] = windowRestored
		result["restored"] = appFront && (!windowNamed || windowRestored)
		if !appFront {
			result["reason"] = "app_not_frontmost"
		} else if windowNamed && !windowRestored {
			result["reason"] = resolved.window == nil ? "window_not_found" : "window_not_key"
		}
		return result
	}

	private func userWindow(pid: Int32, request: [String: Any]) -> (window: AXUIElement?, match: String) {
		let windowRef = optionalStringArg(request, "windowRef")
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		if let windowRef, let stored = refStore.window(for: windowRef), pidForElement(stored) == pid,
			stringAttribute(stored, attribute: kAXRoleAttribute as CFString) != nil
		{
			return (stored, "ref")
		}
		if let windowId { return (windowElement(pid: pid, windowId: windowId), "id") }
		if windowRef != nil { return (nil, "ref") }
		let title = optionalStringArg(request, "windowTitle")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
		if title.isEmpty { return (nil, "none") }
		let appElement = AXUIElementCreateApplication(pid)
		let match = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).first {
			(stringAttribute($0, attribute: kAXTitleAttribute as CFString) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == title
		}
		return (match, "title")
	}

	private func makeKeyWindow(_ window: AXUIElement, pid: Int32) throws -> Bool {
		if isKeyWindow(window, pid: pid) { return true }
		_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		_ = try setAXFocus(window, foregroundGranted: true)
		_ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		return waitUntil(seconds: 0.4) { isKeyWindow(window, pid: pid) }
	}

	private func setWindowFrame(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request, act: true)
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["ok": false, "reason": "window_not_found"]
		}
		let x = try doubleArg(request, "x")
		let y = try doubleArg(request, "y")
		let width = max(100.0, try doubleArg(request, "width"))
		let height = max(80.0, try doubleArg(request, "height"))
		var origin = CGPoint(x: x, y: y)
		var size = CGSize(width: width, height: height)
		guard let originValue = AXValueCreate(.cgPoint, &origin), let sizeValue = AXValueCreate(.cgSize, &size) else {
			throw BridgeFailure(message: "Failed to create AX frame values", code: "frame_value_failed")
		}
		let positionStatus = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, originValue)
		let sizeStatus = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
		let frame = frameForWindow(window)
		return [
			"ok": positionStatus == .success || sizeStatus == .success,
			"positionStatus": Int(positionStatus.rawValue),
			"sizeStatus": Int(sizeStatus.rawValue),
			"framePoints": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height],
		]
	}

	private func focusWindow(_ request: [String: Any]) throws -> [String: Any] {
		try requireForegroundGrant(request, "focusWindow")
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request, act: true)
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
			return ["focused": false, "reason": "window_not_found"]
		}

		let appElement = AXUIElementCreateApplication(pid)
		if let focusedWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement),
			sameElement(focusedWindow, window)
		{
			return ["focused": true, "alreadyFocused": true]
		}

		let setMainStatus = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		let setFocusedStatus = try setAXFocus(window, foregroundGranted: true)
		let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		let focused = setMainStatus == .success || setFocusedStatus == .success || raiseStatus == .success
		var result: [String: Any] = [
			"focused": focused,
			"setMain": setMainStatus == .success,
			"setFocused": setFocusedStatus == .success,
			"raised": raiseStatus == .success,
		]
		if !focused {
			result["reason"] = "focus_failed"
		}
		return result
	}

	private func rootKind(role: String, subrole: String) -> String {
		if role == "AXSheet" { return "sheet" }
		if subrole.localizedCaseInsensitiveContains("popover") { return "popover" }
		if subrole.localizedCaseInsensitiveContains("dialog") || role == "AXDialog" { return "dialog" }
		return "window"
	}

	private func isDialogLikeRoot(role: String, subrole: String) -> Bool {
		let text = "\(role) \(subrole)"
		return text.range(of: "dialog", options: [.caseInsensitive]) != nil
			|| text.range(of: "modal", options: [.caseInsensitive]) != nil
			|| text.range(of: "sheet", options: [.caseInsensitive]) != nil
	}

	private func rootMetadata(pairing: WindowPairing, sheetCount: Int) -> [String: Any] {
		["pairing": ["confidence": pairing.confidence, "score": pairing.score], "sheetCount": sheetCount]
	}

	private func broadRootCandidateApps(entries: [[String: Any]]) -> [[String: Any]] {
		cgBroadRootOwners(entries: entries).compactMap { owner in
			guard owner.pid != getpid(), pidIsAlive(owner.pid) else { return nil }
			var app: [String: Any] = ["appName": owner.name, "pid": Int(owner.pid)]
			if let bundleId = NSRunningApplication(processIdentifier: owner.pid)?.bundleIdentifier {
				app["bundleId"] = bundleId
			}
			return app
		}
	}

	private func listRoots(pid: Int32?, title: String? = nil) throws -> [String: Any] {
		let requestedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
		let entries = allCGWindowEntries()
		let isBroadDiscovery = pid == nil && requestedTitle.isEmpty
		let apps: [[String: Any]]
		if let pid {
			apps = [["pid": Int(pid)]]
		} else if !requestedTitle.isEmpty {
			let matchingPids = Set(entries.compactMap { entry -> Int32? in
				let candidate = ((entry[kCGWindowName as String] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
				guard candidate == requestedTitle || candidate.contains(requestedTitle) else { return nil }
				return (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
			})
			apps = listApps(cgEntries: entries).filter { app in
				guard let rawPid = app["pid"] as? Int else { return false }
				return matchingPids.contains(Int32(rawPid))
			}
		} else {
			apps = broadRootCandidateApps(entries: entries)
		}
		var roots: [[String: Any]] = []
		for app in apps {
			guard let rawPid = app["pid"] as? Int else { continue }
			let appPid = Int32(rawPid)
			let appName = app["appName"] as? String ?? processName(pid: appPid) ?? "Unknown App"
			let bundleId = app["bundleId"] as? String
			for var root in (try? listWindows(pid: appPid, cgEntries: entries, messagingTimeout: isBroadDiscovery ? 0.25 : 1.0)) ?? [] {
				root["pid"] = rawPid
				root["appName"] = appName
				if let bundleId { root["bundleId"] = bundleId }
				roots.append(root)
			}
			let popupCandidates = cgPopupMenuCandidates(pid: appPid, entries: entries)
			let menuElements = popupCandidates.isEmpty ? [] : openMenuElements(pid: appPid, messagingTimeout: isBroadDiscovery ? 0.25 : 1.0)
			for (index, candidate) in popupCandidates.enumerated() {
				let menuElement = index < menuElements.count ? menuElements[index] : nil
				let menuRef = menuElement.map { refStore.storeWindow($0) } ?? "cgmenu:\(candidate.windowId)"
				var menu: [String: Any] = [
					"kind": "menu",
					"rootRef": menuRef,
					"windowRef": menuRef,
					"windowId": Int(candidate.windowId),
					"zOrder": candidate.zOrder,
					"title": menuElement.flatMap { stringAttribute($0, attribute: kAXTitleAttribute as CFString) } ?? candidate.title,
					"role": "AXMenu",
					"subrole": "",
					"isModal": false,
					"framePoints": ["x": candidate.bounds.origin.x, "y": candidate.bounds.origin.y, "w": candidate.bounds.width, "h": candidate.bounds.height],
					"scaleFactor": displayScaleFactor(for: candidate.bounds),
					"isMinimized": false,
					"isOnscreen": candidate.isOnscreen,
					"isMain": false,
					"isFocused": true,
					"metadata": ["pairing": ["confidence": menuElement == nil ? "low" : "high", "score": menuElement == nil ? 0 : 100], "sheetCount": 0],
					"pid": rawPid,
					"appName": appName,
				]
				if let bundleId { menu["bundleId"] = bundleId }
				roots.append(menu)
			}
		}
		roots.sort { (($0["zOrder"] as? Int) ?? Int.max) < (($1["zOrder"] as? Int) ?? Int.max) }
		return ["roots": roots]
	}

	private func listWindows(pid: Int32, cgEntries: [[String: Any]]? = nil, messagingTimeout: Float = 1.0) throws -> [[String: Any]] {
		ensureEnhancedAccessibility(pid: pid)
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, messagingTimeout)
		let windows = Array(axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).prefix(128))
		let candidates = cgWindowCandidates(pid: pid, entries: cgEntries)
		let pairings = windowPairings(windows: windows, candidates: candidates)

		var output: [[String: Any]] = []
		for (zIndex, window) in windows.enumerated() {
			let axTitle = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			let axRole = stringAttribute(window, attribute: kAXRoleAttribute as CFString) ?? ""
			let axSubrole = stringAttribute(window, attribute: kAXSubroleAttribute as CFString) ?? ""
			let axFrame = frameForWindow(window)
			let pairing = pairings[ObjectIdentifier(window)] ?? WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
			let candidate = pairing.candidate

			let effectiveFrame = axFrame.width > 1 && axFrame.height > 1 ? axFrame : (candidate?.bounds ?? axFrame)
			if effectiveFrame.width < 100 || effectiveFrame.height < 80 { continue }
			let hasUsableAXFrame = axFrame.width > 1 && axFrame.height > 1
			let title = hasUsableAXFrame && !axTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? axTitle : (candidate?.title.isEmpty == false ? candidate!.title : axTitle)
			let windowRef = refStore.storeWindow(window)
			let isMinimized = boolAttribute(window, attribute: kAXMinimizedAttribute as CFString) ?? false
			let isMain = boolAttribute(window, attribute: kAXMainAttribute as CFString) ?? false
			let isFocused = boolAttribute(window, attribute: kAXFocusedAttribute as CFString) ?? false
			let sheetCount = sheetElements(of: window).count
			let isModal = (boolAttribute(window, attribute: "AXModal" as CFString) ?? false) || sheetCount > 0 || isDialogLikeRoot(role: axRole, subrole: axSubrole)
			let scale = displayScaleFactor(for: effectiveFrame)

			var item: [String: Any] = [
				"kind": rootKind(role: axRole, subrole: axSubrole),
				"rootRef": windowRef,
				"windowRef": windowRef,
				"zOrder": candidate?.zOrder ?? zIndex,
				"title": title,
				"role": axRole,
				"subrole": axSubrole,
				"isModal": isModal,
				"framePoints": [
					"x": effectiveFrame.origin.x,
					"y": effectiveFrame.origin.y,
					"w": effectiveFrame.size.width,
					"h": effectiveFrame.size.height,
				],
				"scaleFactor": scale,
				"isMinimized": isMinimized,
				"isOnscreen": candidate?.isOnscreen ?? !isMinimized,
				"isMain": isMain,
				"isFocused": isFocused,
				"metadata": rootMetadata(pairing: pairing, sheetCount: sheetCount),
			]
			if let candidate {
				item["windowId"] = Int(candidate.windowId)
			}
			output.append(item)

			for sheet in sheetElements(of: window) {
				let sheetRef = refStore.storeWindow(sheet)
				let sheetFrame = frameForWindow(sheet)
				let sheetCandidate = bestCandidate(for: sheet, candidates: candidates)
				var sheetItem: [String: Any] = [
					"kind": "sheet",
					"rootRef": sheetRef,
					"windowRef": sheetRef,
					"zOrder": sheetCandidate?.zOrder ?? candidate?.zOrder ?? zIndex,
					"title": stringAttribute(sheet, attribute: kAXTitleAttribute as CFString) ?? title,
					"role": stringAttribute(sheet, attribute: kAXRoleAttribute as CFString) ?? "AXSheet",
					"subrole": stringAttribute(sheet, attribute: kAXSubroleAttribute as CFString) ?? "",
					"isModal": true,
					"framePoints": ["x": sheetFrame.origin.x, "y": sheetFrame.origin.y, "w": sheetFrame.width, "h": sheetFrame.height],
					"scaleFactor": displayScaleFactor(for: sheetFrame),
					"isMinimized": false,
					"isOnscreen": sheetCandidate?.isOnscreen ?? candidate?.isOnscreen ?? !isMinimized,
					"isMain": false,
					"isFocused": isFocused,
					"metadata": ["pairing": ["confidence": sheetCandidate == nil ? pairing.confidence : "high", "score": sheetCandidate == nil ? pairing.score : 100], "sheetCount": 0],
				]
				if let sheetCandidate { sheetItem["windowId"] = Int(sheetCandidate.windowId) }
				output.append(sheetItem)
			}
		}
		return output
	}

	private func look(_ request: [String: Any]) throws -> [String: Any] {
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
		guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
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
		return response
	}

	private func elapsedMs(_ start: Date) -> Int {
		max(0, Int(Date().timeIntervalSince(start) * 1000.0))
	}

	private func storeLookRecord(_ record: LookRecord) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		lookRecords[record.lookId] = record
		lookRecordOrder.append(record.lookId)
		let sameOwner = lookRecordOrder.filter { lookRecords[$0]?.sessionId == record.sessionId }
		if sameOwner.count > 8 {
			let evicted = Set(sameOwner.prefix(sameOwner.count - 8))
			lookRecordOrder.removeAll { evicted.contains($0) }
			for id in evicted { lookRecords.removeValue(forKey: id) }
		}
	}

	private func dropLookRecords(sessionId: String) {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		let dropped = Set(lookRecordOrder.filter { lookRecords[$0]?.sessionId == sessionId })
		lookRecordOrder.removeAll { dropped.contains($0) }
		for id in dropped { lookRecords.removeValue(forKey: id) }
	}

	private func freshLookId() -> String {
		lookRecordLock.lock()
		defer { lookRecordLock.unlock() }
		nextLookId += 1
		return "look_\(nextLookId)"
	}

	private func lookRecord(for lookId: String) throws -> LookRecord? {
		lookRecordLock.lock()
		let record = lookRecords[lookId]
		lookRecordLock.unlock()
		if let record, !sessionMayUse(owner: record.sessionId, caller: currentRequestSessionId()) {
			throw BridgeFailure(message: "Look id '\(lookId)' belongs to another session; nothing was sent. Observe the window in this session first", code: "not_look_owner", effectPossible: false)
		}
		return record
	}

	private func windowFrameStaleness(_ record: LookRecord) -> BridgeFailure? {
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

	private func rectTransform(windowFrame: CGRect, imageWidth: Int, imageHeight: Int) -> (CGRect) -> CGRect {
		let sx = windowFrame.width > 0 ? Double(imageWidth) / windowFrame.width : 1.0
		let sy = windowFrame.height > 0 ? Double(imageHeight) / windowFrame.height : 1.0
		return { frame in
			let x = (frame.origin.x - windowFrame.origin.x) * sx
			let y = (frame.origin.y - windowFrame.origin.y) * sy
			let w = frame.width * sx
			let h = frame.height * sy
			return self.clampRect(CGRect(x: x, y: y, width: w, height: h), width: imageWidth, height: imageHeight)
		}
	}

	private func clampRect(_ rect: CGRect, width: Int, height: Int) -> CGRect {
		let maxX = Double(width)
		let maxY = Double(height)
		let x1 = min(max(rect.minX, 0), maxX)
		let y1 = min(max(rect.minY, 0), maxY)
		let x2 = min(max(rect.maxX, 0), maxX)
		let y2 = min(max(rect.maxY, 0), maxY)
		return CGRect(x: x1, y: y1, width: max(0, x2 - x1), height: max(0, y2 - y1))
	}

	private func buildLookOutline(root: AXUIElement, transform: @escaping (CGRect) -> CGRect) -> LookNode {
		let rootNode = lookNode(element: root, transform: transform, offscreen: false)
		let nodeLimit = 2000
		let deadline = Date().addingTimeInterval(20.0)
		var walked = 1
		var seen = Set<ObjectIdentifier>([ObjectIdentifier(root)])
		var queue: [(AXUIElement, LookNode)] = [(root, rootNode)]
		var index = 0
		while index < queue.count {
			let (element, node) = queue[index]
			index += 1
			let children = axElementArray(element, attribute: kAXChildrenAttribute as CFString)
			if children.isEmpty { continue }
			if walked >= nodeLimit || Date() >= deadline {
				node.truncated = true
				continue
			}
			let visibleByKind = visibleChildrenByKind(element)
			for child in children {
				if walked >= nodeLimit || Date() >= deadline {
					node.truncated = true
					break
				}
				let identity = ObjectIdentifier(child)
				if seen.contains(identity) { continue }
				seen.insert(identity)
				let role = stringAttribute(child, attribute: kAXRoleAttribute as CFString) ?? ""
				let offscreen = childOffscreen(child, role: role, visibleByKind: visibleByKind)
				let childNode = lookNode(element: child, transform: transform, offscreen: offscreen)
				node.children.append(childNode)
				queue.append((child, childNode))
				walked += 1
			}
		}
		return rootNode
	}

	private func lookNode(element: AXUIElement, transform: (CGRect) -> CGRect, offscreen: Bool) -> LookNode {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let actions = actionNames(element)
		var valueSettable = DarwinBoolean(false)
		let valueStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
		var focusedSettable = DarwinBoolean(false)
		let focusedStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusedSettable)
		let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let description = stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
		let value = displayValue(element, role: role, subrole: subrole)
		let screenRect = frameForElement(element) ?? .zero
		let node = LookNode(
			element: element,
			ref: refStore.storeElement(element, snapshot: AXRefStore.Snapshot(
				role: role,
				identifier: stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? "",
				label: normalizedLabel([title, description, value].joined(separator: " ")),
				rect: screenRect
			)),
			role: role,
			subrole: subrole,
			identifier: stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? "",
			title: title,
			description: description,
			value: value,
			actions: actions,
			canPress: actions.contains(kAXPressAction as String),
			canFocus: focusedStatus == .success && focusedSettable.boolValue,
			canSetValue: valueStatus == .success && valueSettable.boolValue,
			canScroll: supportsAnyScrollAction(element),
			canIncrement: actions.contains(kAXIncrementAction as String),
			canDecrement: actions.contains(kAXDecrementAction as String),
			isTextInput: textRoles.contains(role),
			rect: transform(screenRect),
			focused: boolAttribute(element, attribute: kAXFocusedAttribute as CFString) == true,
			offscreen: offscreen
		)
		if node.canScroll {
			let rows = axElementArray(element, attribute: kAXRowsAttribute as CFString)
			let visibleRows = axElementArrayIfPresent(element, attribute: kAXVisibleRowsAttribute as CFString)
			if !rows.isEmpty, let visibleRows {
				node.scrollExtent = ["seen": visibleRows.count, "total": rows.count]
			}
		}
		return node
	}

	private func visibleChildrenByKind(_ element: AXUIElement) -> [String: [AXUIElement]?] {
		[
			"AXRow": axElementArrayIfPresent(element, attribute: kAXVisibleRowsAttribute as CFString),
			"AXColumn": axElementArrayIfPresent(element, attribute: kAXVisibleColumnsAttribute as CFString),
			"AXCell": axElementArrayIfPresent(element, attribute: kAXVisibleCellsAttribute as CFString),
			"*": axElementArrayIfPresent(element, attribute: kAXVisibleChildrenAttribute as CFString),
		]
	}

	private func childOffscreen(_ child: AXUIElement, role: String, visibleByKind: [String: [AXUIElement]?]) -> Bool {
		let key = role == "AXRow" || role == "AXColumn" || role == "AXCell" ? role : "*"
		guard let visible = visibleByKind[key] ?? nil else { return false }
		return !visible.contains { sameElement($0, child) }
	}

	private func recognizeText(in image: CGImage, outputWidth: Int, outputHeight: Int) throws -> [OCRBox] {
		let semaphore = DispatchSemaphore(value: 0)
		let recognized = Box<[OCRBox]>([])
		let recognizedError = Box<Error?>(nil)
		let request = VNRecognizeTextRequest { request, error in
			defer { semaphore.signal() }
			if let error {
				recognizedError.value = error
				return
			}
			let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
			recognized.value = observations.compactMap { observation in
				guard let candidate = observation.topCandidates(1).first else { return nil }
				let box = observation.boundingBox
				let x = box.origin.x * Double(outputWidth)
				let y = (1.0 - box.origin.y - box.height) * Double(outputHeight)
				let w = box.width * Double(outputWidth)
				let h = box.height * Double(outputHeight)
				return OCRBox(string: candidate.string, confidence: Double(candidate.confidence), rect: CGRect(x: x, y: y, width: w, height: h))
			}
		}
		request.recognitionLevel = .accurate
		request.usesLanguageCorrection = false
		try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
		if semaphore.wait(timeout: .now() + .seconds(8)) == .timedOut {
			throw BridgeFailure(message: "Text recognition timed out", code: "text_recognition_timeout")
		}
		if let error = recognizedError.value {
			throw BridgeFailure(message: "Text recognition failed: \(error.localizedDescription)", code: "text_recognition_failed")
		}
		return recognized.value
	}

	private func attachOCR(_ boxes: [OCRBox], to root: LookNode) {
		var pictureOnlyIndex = 0
		for box in boxes {
			if ocrBoxDuplicatesAXLabel(box, in: root) { continue }
			let center = CGPoint(x: box.rect.midX, y: box.rect.midY)
			if let node = deepestNode(containing: center, in: root) {
				node.text.append(["string": box.string, "confidence": box.confidence, "rect": ["x": box.rect.origin.x, "y": box.rect.origin.y, "w": box.rect.width, "h": box.rect.height]])
			} else {
				pictureOnlyIndex += 1
				let parent = deepestContainer(containing: center, in: root) ?? root
				parent.children.append(LookNode(element: nil, ref: "pic_\(pictureOnlyIndex)", role: "AXImage", subrole: "", identifier: "", title: box.string, description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: box.rect, pictureOnly: true))
			}
		}
	}

	private func ocrBoxDuplicatesAXLabel(_ box: OCRBox, in root: LookNode) -> Bool {
		let boxLabel = normalizedLabel(box.string)
		if boxLabel.isEmpty { return true }
		var queue = [root]
		var index = 0
		while index < queue.count {
			let node = queue[index]
			index += 1
			if !node.pictureOnly, node.rect.intersects(box.rect) {
				let fields = [node.title, node.value, node.description]
				if fields.contains(where: { normalizedLabel($0) == boxLabel }) { return true }
			}
			queue.append(contentsOf: node.children)
		}
		return false
	}

	private func deepestNode(containing point: CGPoint, in root: LookNode) -> LookNode? {
		guard root.rect.contains(point), !root.pictureOnly else { return nil }
		for child in root.children.reversed() {
			if let match = deepestNode(containing: point, in: child) { return match }
		}
		return root
	}

	private func deepestContainer(containing point: CGPoint, in root: LookNode) -> LookNode? {
		guard root.rect.contains(point) else { return nil }
		for child in root.children.reversed() {
			if let match = deepestContainer(containing: point, in: child) { return match }
		}
		return root
	}

	private func lookPoint(record: LookRecord, x: Double, y: Double) -> CGPoint {
		let relX = min(max(x / max(1.0, Double(record.imageWidth)), 0), 1)
		let relY = min(max(y / max(1.0, Double(record.imageHeight)), 0), 1)
		return CGPoint(x: record.windowFrame.origin.x + record.windowFrame.width * relX, y: record.windowFrame.origin.y + record.windowFrame.height * relY)
	}

	private func payloadNode(element: AXUIElement) -> [String: Any] {
		let node = lookNode(element: element, transform: { $0 }, offscreen: false)
		var payload = node.payload()
		payload["children"] = []
		return payload
	}

	private func normalizedLabel(_ value: String) -> String {
		value.lowercased().components(separatedBy: CharacterSet.whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
	}

	private func ensureRootObserver(pid: Int32) -> Bool {
		rootObserverLock.lock()
		if let existing = rootObservers[pid] {
			existing.lastUsed = Date().timeIntervalSince1970
			rootObserverLock.unlock()
			return true
		}
		rootObserverLock.unlock()

		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		var observer: AXObserver?
		let createStatus = AXObserverCreate(pid, { observer, element, notification, refcon in
			guard let refcon else { return }
			let bridge = Unmanaged<Bridge>.fromOpaque(refcon).takeUnretainedValue()
			bridge.recordRootAXEvent(observer: observer, notification: notification as String, element: element)
		}, &observer)
		guard createStatus == .success, let observer else { return false }

		let state = RootAXObserverState(pid: pid, observer: observer)
		let context = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		let notifications: [CFString] = [
			"AXWindowCreated" as CFString,
			"AXSheetCreated" as CFString,
			"AXMenuOpened" as CFString,
			"AXMenuClosed" as CFString,
			"AXUIElementDestroyed" as CFString,
			"AXFocusedWindowChanged" as CFString,
			kAXValueChangedNotification as CFString,
			kAXTitleChangedNotification as CFString,
			kAXSelectedChildrenChangedNotification as CFString,
			kAXLayoutChangedNotification as CFString,
		]
		var registered = false
		let observedElements = [appElement] + axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		for observed in observedElements {
			for notification in notifications {
				let status = AXObserverAddNotification(observer, observed, notification, context)
				if status == .success || status == .notificationAlreadyRegistered { registered = true }
			}
		}
		guard registered else { return false }

		rootObserverLock.lock()
		if rootObservers.count >= maxRootObservers,
			let evict = rootObservers.values.min(by: { $0.lastUsed < $1.lastUsed })?.pid
		{
			rootObservers.removeValue(forKey: evict)
		}
		rootObservers[pid] = state
		rootObserverLock.unlock()

		let source = AXObserverGetRunLoopSource(observer)
		Thread.detachNewThread {
			CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
			CFRunLoopRun()
		}
		return true
	}

	private func recordRootAXEvent(observer: AXObserver, notification: String, element: AXUIElement) {
		rootObserverLock.lock()
		let state = rootObservers.values.first { CFEqual($0.observer, observer) }
		if let state {
			state.events.append(RootAXEvent(sequence: state.nextSequence, timestamp: Date().timeIntervalSince1970, notification: notification, element: element))
			state.nextSequence += 1
			if state.events.count > 64 { state.events.removeFirst(state.events.count - 64) }
		}
		rootObserverLock.unlock()
		if let state {
			state.change.lock()
			state.changeGeneration += 1
			state.change.broadcast()
			state.change.unlock()
		}
	}

	private func rootChangeGeneration(pid: Int32) -> UInt64 {
		rootObserverLock.lock()
		let state = rootObservers[pid]
		rootObserverLock.unlock()
		guard let state else { return 0 }
		state.change.lock()
		defer { state.change.unlock() }
		return state.changeGeneration
	}

	private func waitForRootChange(pid: Int32, since generation: UInt64, until deadline: Date) {
		rootObserverLock.lock()
		let state = rootObservers[pid]
		rootObserverLock.unlock()
		guard let state else {
			Thread.sleep(forTimeInterval: min(0.2, max(0, deadline.timeIntervalSinceNow)))
			return
		}
		state.change.lock()
		if state.changeGeneration == generation {
			_ = state.change.wait(until: min(deadline, Date().addingTimeInterval(0.2)))
		}
		state.change.unlock()
	}

	private func rootEventCursor(pid: Int32) -> UInt64 {
		rootObserverLock.lock()
		defer { rootObserverLock.unlock() }
		return rootObservers[pid]?.nextSequence ?? 1
	}

	private func rootEvents(pid: Int32, since cursor: UInt64) -> [RootAXEvent] {
		rootObserverLock.lock()
		defer { rootObserverLock.unlock() }
		guard let events = rootObservers[pid]?.events else { return [] }
		return events.filter { $0.sequence >= cursor }
	}

	private func cgRootSignature(pid: Int32) -> Set<UInt32> {
		guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
		var ids = Set<UInt32>()
		for entry in entries {
			guard let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, owner == pid else { continue }
			guard let windowId = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
			ids.insert(windowId)
		}
		return ids
	}

	private func refindElement(ref: String, pid: Int32, windowId: UInt32) -> AXUIElement? {
		guard let snapshot = refStore.snapshot(for: ref),
			let window = windowElement(pid: pid, windowId: windowId)
		else { return nil }
		let targetCenter = CGPoint(x: snapshot.rect.midX, y: snapshot.rect.midY)
		let candidates = collectDescendants(startingAt: window, maxDepth: 8).filter { candidate in
			let role = stringAttribute(candidate, attribute: kAXRoleAttribute as CFString) ?? ""
			guard role == snapshot.role else { return false }
			let identifier = stringAttribute(candidate, attribute: "AXIdentifier" as CFString) ?? ""
			if !snapshot.identifier.isEmpty { return identifier == snapshot.identifier }
			let subrole = stringAttribute(candidate, attribute: kAXSubroleAttribute as CFString) ?? ""
			let title = stringAttribute(candidate, attribute: kAXTitleAttribute as CFString) ?? ""
			let description = stringAttribute(candidate, attribute: kAXDescriptionAttribute as CFString) ?? ""
			let value = displayValue(candidate, role: role, subrole: subrole)
			return normalizedLabel([title, description, value].joined(separator: " ")) == snapshot.label
		}
		return candidates.min { left, right in
			let leftFrame = frameForElement(left) ?? .zero
			let rightFrame = frameForElement(right) ?? .zero
			let leftDistance = hypot(leftFrame.midX - targetCenter.x, leftFrame.midY - targetCenter.y)
			let rightDistance = hypot(rightFrame.midX - targetCenter.x, rightFrame.midY - targetCenter.y)
			return leftDistance < rightDistance
		}
	}

	private func hitTest(_ request: [String: Any]) throws -> [String: Any] {
		let lookId = try stringArg(request, "lookId")
		guard let record = try lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
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

	private func act(_ request: [String: Any]) throws -> [String: Any] {
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

	private func isGrantedHIDAct(_ request: [String: Any]) -> Bool {
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

	private func deliverAct(_ request: [String: Any]) throws -> [String: Any] {
		activeRequestContext()?.extendedDeliveryStatus = nil
		activeRequestContext()?.extendedDeliveryReason = nil
		activeRequestContext()?.extendedDeliveryActivated = false
		let lookId = try stringArg(request, "lookId")
		guard let record = try lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look")
		}
		let pid = Int32(try intArg(request, "pid"))
		let action = try stringArg(request, "action")
		let target = request["target"] as? [String: Any] ?? [:]
		let params = request["params"] as? [String: Any] ?? [:]
		try enforceWindowOwners(pid: pid, windowId: record.windowId, windowRef: nil, request: request, act: true)
		if let root = record.rootElement, let owner = pidForElement(root) { try enforceAppPolicy(owner: owner, request: request, act: true) }
		let requestedPolicy = optionalStringArg(request, "policy") ?? "background"
		let policy = requestedPolicy == "default" ? "background" : requestedPolicy
		let foregroundGranted = policy == "foreground" && (request["foregroundGrant"] as? Bool) == true
		if policy == "foreground" && !foregroundGranted {
			throw foregroundRequired("Foreground delivery requires a host foreground grant on the request")
		}
		let context = activeRequestContext()
		context?.foregroundGrant = foregroundGranted
		try checkpoint()
		if let stale = windowFrameStaleness(record) { throw stale }
		let deferRootDelta = boolArg(request, "deferRootDelta") ?? false
		let delivery = foregroundGranted && (params["delivery"] as? String) != "pid" ? "hid" : "pid"
		let extendedPlan = extendedDeliveryPlan(request: request, record: record, pid: pid, action: action, target: target, policy: policy, delivery: delivery)
		context?.extendedDeliveryStatus = extendedPlan.status
		context?.extendedDeliveryReason = extendedPlan.reason
		let extendedTarget = context == nil ? nil : extendedPlan.target
		defer {
			if let extendedTarget {
				context?.extendedDelivery = nil
				endExtendedDelivery(extendedTarget)
			}
		}
		let extendedObservedWindow = extendedTarget == nil ? nil : lookWindowElement(record, pid: pid) ?? windowElement(pid: pid, windowId: record.windowId)
		if let extendedTarget {
			do {
				try beginExtendedDelivery(extendedTarget)
			} catch let failure as BridgeFailure {
				context?.extendedDeliveryStatus = "not_applicable"
				context?.extendedDeliveryReason = failure.code
				throw failure
			}
			context?.extendedDeliveryActivated = true
			context?.extendedDelivery = extendedTarget
			if ["typeText", "keypress", "setText"].contains(action) {
				try requireExtendedKeyWindow(extendedTarget, window: extendedObservedWindow)
			} else {
				try settleExtendedKeyWindow(extendedTarget, window: extendedObservedWindow)
			}
		}
		let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
		let observedWindow = lookWindowElement(record, pid: pid)
		context?.beginHIDDestination(
			delivery == "hid"
				? HIDDestination(pid: pid, windowId: record.windowId, window: observedWindow, frontmostBefore: frontmostBefore, inputBaseline: context?.inputEventCount ?? 0)
				: nil
		)
		var holdsPhysicalInput = false
		func acquirePhysicalInputIfNeeded() {
			if delivery == "hid" && !holdsPhysicalInput {
				physicalInputLock.lock()
				holdsPhysicalInput = true
			}
		}
		defer { if holdsPhysicalInput { physicalInputLock.unlock() } }
		var performed: [String: Any] = ["delivery": delivery]
		var element: AXUIElement?
		var rawPoint: CGPoint?
		var preflightCapsUnknown = false
		let eventsLive = !deferRootDelta && ensureRootObserver(pid: pid)
		let eventCursor = eventsLive ? rootEventCursor(pid: pid) : 0
		let beforeRootSnapshot = deferRootDelta ? [:] : rootMetadataSnapshot(pid: pid)
		let beforeCgSignature = deferRootDelta ? [] : cgRootSignature(pid: pid)
		let pointerBaselineCg: Set<UInt32> = (action == "press" || action == "click") ? (deferRootDelta ? cgRootSignature(pid: pid) : beforeCgSignature) : []
		let beforeFrontmostPid = deferRootDelta ? nil : NSWorkspace.shared.frontmostApplication?.processIdentifier
		let beforeSheetCount = windowElement(pid: pid, windowId: record.windowId).map { sheetElements(of: $0).count } ?? 0
		let beforeFocusedWindow = focusedWindowSummary(pid: pid)
		func focusedWindowChanged() -> Bool {
			guard focusedWindowSummary(pid: pid) != beforeFocusedWindow else { return false }
			return !activationFocusLanded()
		}
		func activationFocusLanded() -> Bool {
			guard extendedTarget != nil, let window = extendedObservedWindow else { return false }
			return isKeyWindow(window, pid: pid)
		}
		let beforeValue: String?
		let beforeSelected: String?
		func finish(_ response: [String: Any]) throws -> [String: Any] {
			let response = withExtendedDeliveryStatus(withDestinationStatus(response, context: context), plan: extendedPlan)
			if deferRootDelta { return response }
			var output = try attachRootDelta(to: response, before: beforeRootSnapshot, beforeFrontmostPid: beforeFrontmostPid, pid: pid, eventsLive: eventsLive, eventCursor: eventCursor, beforeCgSignature: beforeCgSignature)
			attachFrontmost(to: &output, before: frontmostBefore)
			return output
		}

		let focusResolved = optionalStringArg(request, "focusResolution") == "ax_focused_element"
		if focusResolved {
			let appElement = AXUIElementCreateApplication(pid)
			if let focused = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement) {
				var focusedPid: pid_t = 0
				if AXUIElementGetPid(focused, &focusedPid) == .success, focusedPid != pid {
					try enforceAppPolicy(owner: focusedPid, request: request, act: true)
					throw foregroundRequired("The focused element belongs to another process (pid \(focusedPid))")
				}
				element = focused
				beforeValue = stringAttribute(focused, attribute: kAXValueAttribute as CFString)
				beforeSelected = stringAttribute(focused, attribute: kAXSelectedTextAttribute as CFString)
			} else {
				beforeValue = nil
				beforeSelected = nil
			}
			if record.hasImage, let xNumber = target["x"] as? NSNumber, let yNumber = target["y"] as? NSNumber {
				rawPoint = lookPoint(record: record, x: xNumber.doubleValue, y: yNumber.doubleValue)
			}
			performed["focusResolution"] = "ax_focused_element"
		} else if let ref = target["ref"] as? String {
			var refound = false
			let cached = refStore.element(for: ref)
			let cachedIsLive = cached.map {
				stringAttribute($0, attribute: kAXRoleAttribute as CFString) != nil && frameForElement($0) != nil
			} ?? false
			let resolved: AXUIElement?
			if cachedIsLive {
				resolved = cached
			} else {
				refound = true
				resolved = refindElement(ref: ref, pid: pid, windowId: record.windowId)
			}
			guard let stored = resolved else {
				throw BridgeFailure(message: "Element reference is stale", code: "stale_ref")
			}
			if let owner = pidForElement(stored), owner != pid { try enforceAppPolicy(owner: owner, request: request, act: true) }
			if refound { performed["refound"] = true }
			element = stored
			beforeValue = stringAttribute(stored, attribute: kAXValueAttribute as CFString)
			beforeSelected = stringAttribute(stored, attribute: kAXSelectedTextAttribute as CFString)
		} else if let xNumber = target["x"] as? NSNumber, let yNumber = target["y"] as? NSNumber {
			guard record.hasImage else {
				throw BridgeFailure(message: "Coordinate targeting is unavailable for this outline-only root", code: "coordinate_unavailable_for_root")
			}
			rawPoint = lookPoint(record: record, x: xNumber.doubleValue, y: yNumber.doubleValue)
			beforeValue = nil
			beforeSelected = nil
		} else {
			throw BridgeFailure(message: "act target must include ref or x/y", code: "invalid_args")
		}

		func coordinatePoint() throws -> CGPoint {
			if let element, let frame = frameForElement(element) {
				return CGPoint(x: frame.midX, y: frame.midY)
			}
			if let rawPoint { return rawPoint }
			throw BridgeFailure(message: "No coordinate grounding is available", code: "coordinate_unavailable")
		}

		func animateCursor(at point: CGPoint) {
			guard supportsAgentCursor,
				(request["cursorOverlay"] as? Bool ?? true),
				delivery == "pid",
				policy != "ax_only",
				["press", "click", "moveMouse", "scroll", "drag"].contains(action)
			else { return }
			Task { @MainActor in AgentCursor.shared.animate(to: point, above: record.windowId) }
		}

		func focusTargetForPhysicalInput() throws {
			guard delivery == "hid" else { return }
			guard foregroundGranted else { throw foregroundRequired("Activating or raising the target requires a host foreground grant") }
			try checkpoint()
			context?.markEffect()
			context?.activationAttempted = true
			if let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
				performed["activated"] = app.activate()
			}
			if let window = windowElement(pid: pid, windowId: record.windowId) ?? observedWindow {
				_ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
				_ = try setAXFocus(window, foregroundGranted: foregroundGranted)
				performed["raised"] = AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
			}
			usleep(20_000)
		}

		func preflight(_ point: CGPoint) throws {
			for attempt in 0..<4 {
				let hit = hitTestElement(at: point)
				switch preflightVerdict(hit: hit, element: element, point: point, pid: pid) {
				case .clear:
					return
				case .capsUnknown:
					preflightCapsUnknown = true
					return
				case .occluded:
					break
				}
				if delivery == "hid" && attempt < 3 {
					try focusTargetForPhysicalInput()
					usleep(20_000)
					continue
				}
				throw occludedFailure(hit: hit, point: point)
			}
		}

		var pidPointerPosted = false
		var pointerWithoutAXAction = false

		func settlePointerChange(_ observe: () -> Bool) throws -> Bool {
			for _ in 0..<6 {
				try checkpoint()
				usleep(50_000)
				if observe() { return true }
			}
			return false
		}

		func pointerChangeObserved(_ target: AXUIElement?, baselineCg: Set<UInt32>, frontmostTargetOnly: Bool = false) -> Bool {
			if let target {
				if stringAttribute(target, attribute: kAXValueAttribute as CFString) != beforeValue { return true }
				if stringAttribute(target, attribute: kAXSelectedTextAttribute as CFString) != beforeSelected { return true }
			}
			if focusedWindowChanged() { return true }
			let sheets = windowElement(pid: pid, windowId: record.windowId).map { sheetElements(of: $0).count } ?? beforeSheetCount
			if sheets != beforeSheetCount { return true }
			if cgRootSignature(pid: pid) != baselineCg { return true }
			let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
			if frontmostTargetOnly { return front != frontmostBefore && front == pid }
			return front != frontmostBefore
		}

		var attemptProbe: PointerProbe?
		var attemptPixels: PixelProbe?
		var attemptRegions: [CGRect] = []
		var attemptRegionKind = "point"
		var effectBeforeAttempt = false
		func dragPoints() throws -> [CGPoint] {
			guard let rawPath = params["path"] as? [[String: Any]], rawPath.count >= 2 else {
				throw BridgeFailure(message: "drag requires path", code: "invalid_args")
			}
			return try rawPath.map { raw -> CGPoint in
				guard let pathX = (raw["x"] as? NSNumber)?.doubleValue, let pathY = (raw["y"] as? NSNumber)?.doubleValue else {
					throw BridgeFailure(message: "drag path entries require x and y", code: "invalid_args")
				}
				return lookPoint(record: record, x: pathX, y: pathY)
			}
		}
		func beginBackgroundPidAttempt(at point: CGPoint) throws {
			effectBeforeAttempt = context?.effectPossible ?? false
			let path = action == "drag" ? try dragPoints() : []
			attemptPixels = try startPixelProbe(windowId: record.windowId)
			attemptProbe = capturePointerProbe(pid: pid, element: element, point: point)
			if action == "drag" {
				attemptRegions = Self.pathNeighborhoods(path)
				attemptRegionKind = "point"
			} else if let element, let frame = frameForElement(element), frame.width > 0, frame.height > 0 {
				attemptRegions = [frame.insetBy(dx: -Self.pixelTargetMargin, dy: -Self.pixelTargetMargin)]
				attemptRegionKind = "element"
			} else {
				attemptRegions = Self.pathNeighborhoods([point])
				attemptRegionKind = "point"
			}
		}
		func settleBackgroundAttempt(_ probe: PointerProbe) throws -> SettledAttempt {
			let start = Date()
			var compared = false
			var elsewhere = false
			var foreignFront: pid_t?
			let region = attemptPixels.flatMap { pixels in pixelMask(pixels, covering: attemptRegions) }
			func noteForeignFront() {
				guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
					front != frontmostBefore, front != pid
				else { return }
				foreignFront = front
			}
			func pixelEvidence(axChanged: Bool, pixelChanged: Bool) -> [String: Any] {
				var evidence: [String: Any]
				if compared {
					evidence = ["pixelCheck": "compared", "pixelChange": pixelChanged, "pixelChangeOutsideTarget": elsewhere]
				} else {
					evidence = ["pixelCheck": attemptPixels != nil && axChanged ? "not_needed" : "unavailable"]
				}
				if attemptPixels != nil {
					evidence["pixelRegion"] = region == nil ? "outside_window" : attemptRegionKind
					if let first = attemptRegions.first {
						let rect = attemptRegions.dropFirst().reduce(first) { $0.union($1) }
						evidence["pixelRegionPoints"] = ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height]
						evidence["pixelRegionParts"] = attemptRegions.count
					}
				}
				if let foreignFront {
					evidence["frontmostChangedElsewhere"] = true
					evidence["frontmostChangedTo"] = Int(foreignFront)
				}
				return evidence
			}
			for _ in 0..<6 {
				try checkpoint()
				usleep(50_000)
				noteForeignFront()
				if pointerChangeObserved(element, baselineCg: probe.baselineCg, frontmostTargetOnly: true)
					|| pointerProbeChanged(probe, ignoreFocusedElement: activationFocusLanded() && focusedWindowSummary(pid: pid) != beforeFocusedWindow) {
					try checkpoint()
					return SettledAttempt(changed: true, elsewhere: elsewhere, evidence: pixelEvidence(axChanged: true, pixelChanged: false))
				}
				let remaining = Self.pointerSettleBudget - Date().timeIntervalSince(start)
				if let pixels = attemptPixels, remaining > 0.03 {
					try checkpoint()
					let timeout = min(Self.pixelCaptureTimeout, remaining)
					let captured = capturePixelSnapshot(pixels, timeout: timeout)
					try checkpoint()
					if let current = captured {
						compared = true
						let change = pixelChanges(pixels.baseline, current, region: region)
						if change.elsewhere { elsewhere = true }
						if change.target {
							noteForeignFront()
							return SettledAttempt(changed: true, elsewhere: elsewhere, evidence: pixelEvidence(axChanged: false, pixelChanged: true))
						}
					}
				}
				if Date().timeIntervalSince(start) >= Self.pointerSettleBudget { break }
			}
			try checkpoint()
			noteForeignFront()
			return SettledAttempt(changed: false, elsewhere: elsewhere, evidence: pixelEvidence(axChanged: false, pixelChanged: false))
		}
		func executeCoordinates(_ point: CGPoint) throws {
			guard element != nil || record.hasImage else {
				throw BridgeFailure(message: "Coordinate grounding is unavailable for this outline-only root", code: "coordinate_unavailable_for_root")
			}
			performed["grounding"] = "coordinates"
			if delivery == "pid" { performed["verification"] = "caller_required" }
			acquirePhysicalInputIfNeeded()
			try focusTargetForPhysicalInput()
			if delivery == "hid" { try preflight(point) }
			switch action {
			case "press", "click":
				animateCursor(at: point)
				try postMouseClick(at: point, pid: pid, button: mouseButton(params["button"] as? String ?? "left"), clickCount: max(1, min(3, (params["clickCount"] as? NSNumber)?.intValue ?? 1)), delivery: delivery)
				if delivery == "pid" { pidPointerPosted = true }
			case "moveMouse":
				animateCursor(at: point)
				try postMouseMove(to: point, pid: pid, delivery: delivery)
			case "scroll":
				animateCursor(at: point)
				if delivery == "pid", context?.extendedDelivery == nil, record.windowId != 0 {
					context?.pidScrollWindow = ExtendedDeliveryTarget(pid: pid, windowId: record.windowId, windowFrame: record.windowFrame)
				}
				defer { context?.pidScrollWindow = nil }
				try postScrollWheel(at: point, deltaX: (params["scrollX"] as? NSNumber)?.intValue ?? 0, deltaY: (params["scrollY"] as? NSNumber)?.intValue ?? 0, pid: pid, delivery: delivery)
			case "drag":
				let points = try dragPoints()
				animateCursor(at: point)
				try postMouseDrag(points: points, pid: pid, delivery: delivery)
			default:
				throw BridgeFailure(message: "Action \(action) cannot use coordinate grounding", code: "invalid_args")
			}
		}

		func refreshElement() -> AXUIElement? {
			guard let ref = target["ref"] as? String,
				let refreshed = refindElement(ref: ref, pid: pid, windowId: record.windowId)
			else { return nil }
			element = refreshed
			performed["refound"] = true
			return refreshed
		}

		var axFocusedTarget: AXUIElement?
		if let element, action == "press" || action == "click" {
			let elementRole = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]
			let webAncestry = ancestorRole(element, role: "AXWebArea")
			let inWebArea = webAncestry != .notFound
			let isTextRole = textRoles.contains(elementRole)
			let extendedWeb = extendedTarget != nil && webAncestry == .found
			let extendedWebPress = extendedWeb && !isTextRole && supportsAction(element, action: kAXPressAction as CFString)
			let extendedWebPointer = extendedWeb && !isTextRole && !extendedWebPress
			let requiresPointerFocus = (inWebArea || isTextRole) && !extendedWebPress && !extendedWebPointer
			if webAncestry == .inconclusive && !foregroundGranted && (isTextRole || policy == "background") {
				throw foregroundRequired("The target's web-content ancestry is inconclusive (ancestry inconclusive); acting on it requires a host foreground grant")
			}
			if isTextRole && (!inWebArea || extendedWeb) && (policy == "background" || policy == "ax_only") {
				var focusSettable = DarwinBoolean(false)
				let settableStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusSettable)
				let canSetFocus = settableStatus == .success && focusSettable.boolValue
				if !canSetFocus && policy == "background" {
					throw foregroundRequired("The text field does not accept accessibility focus; focusing it requires pointer input")
				}
				if canSetFocus {
					let cursorPoint = try? coordinatePoint()
					var focusElement = element
					var status = try setAXFocus(focusElement, foregroundGranted: foregroundGranted)
					if status != .success, let refreshed = refreshElement() {
						focusElement = refreshed
						status = try setAXFocus(focusElement, foregroundGranted: foregroundGranted)
					}
					if status == .success {
						performed["delivery"] = "ax"
						performed["grounding"] = "focus"
						performed["focused"] = true
						axFocusedTarget = focusElement
						if let cursorPoint { animateCursor(at: cursorPoint) }
					} else if policy == "background" {
						throw foregroundRequired("The text field rejected the accessibility focus request; focusing it requires pointer input")
					}
				}
			}
			if axFocusedTarget != nil {
			} else if requiresPointerFocus && policy != "ax_only" {
				if policy == "foreground" {
					try executeCoordinates(coordinatePoint())
				} else {
					throw foregroundRequired("Web content requires pointer input")
				}
			} else if supportsAction(element, action: kAXPressAction as CFString) {
				let cursorPoint = try? coordinatePoint()
				try checkpoint()
				context?.markEffect()
				var status = AXUIElementPerformAction(element, kAXPressAction as CFString)
				if status != .success, let refreshed = refreshElement(), supportsAction(refreshed, action: kAXPressAction as CFString) {
					status = AXUIElementPerformAction(refreshed, kAXPressAction as CFString)
				}
				if status == .success {
					performed["grounding"] = "description"
					performed["delivery"] = "ax"
					if let cursorPoint { animateCursor(at: cursorPoint) }
				} else {
					try executeCoordinates(coordinatePoint())
				}
			} else {
				if !foregroundGranted && (!inWebArea || extendedWebPointer) {
					guard policy == "background" else {
						throw foregroundRequired("target has no accessibility action; pointer delivery needs a host foreground grant")
					}
					let point = try coordinatePoint()
					try beginBackgroundPidAttempt(at: point)
					try executeCoordinates(point)
				} else {
					pointerWithoutAXAction = true
					try executeCoordinates(coordinatePoint())
				}
			}
		} else if let element, action == "setText" {
			let text = params["text"] as? String ?? ""
			if ancestorRole(element, role: "AXWebArea") != .notFound {
				if let refusal = axFocusRefusal(element, foregroundGranted: foregroundGranted) { throw refusal }
				acquirePhysicalInputIfNeeded()
				try focusTargetForPhysicalInput()
				_ = try setAXFocus(element, foregroundGranted: foregroundGranted)
				let currentValue = stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
				var range = CFRange(location: 0, length: (currentValue as NSString).length)
				let selected = AXValueCreate(.cfRange, &range).map {
					AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, $0) == .success
				} ?? false
				if !selected {
					try postKeyPress(keys: ["cmd", "a"], pid: pid, delivery: delivery)
					usleep(20_000)
				}
				if extendedTarget != nil {
					try postUnicodeText(text, pid: pid, delivery: delivery)
					performed["textEntry"] = "characters"
				} else {
					try postAtomicUnicodeText(text, pid: pid, delivery: delivery)
				}
				usleep(40_000)
				let verificationElement = refreshElement() ?? element
				let value = stringAttribute(verificationElement, attribute: kAXValueAttribute as CFString) ?? ""
				performed["grounding"] = "keyboard-events"
				performed["delivery"] = delivery
				performed["selectionGrounding"] = selected ? "ax" : "keyboard"
				return try finish(["outcome": value == text ? "worked" : "didnt", "performed": performed, "evidence": ["value": value]])
			}
			var targetElement = element
			try checkpoint()
			context?.markEffect()
			let commit = try replaceTextThroughEditor(element, text: text, foregroundGranted: foregroundGranted)
			if let value = commit.value, value == text {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				performed["textCommit"] = "selected_text"
				return try finish(["outcome": "worked", "performed": performed, "evidence": ["value": value]])
			}
			performed["textCommitUnavailable"] = commit.stage
			var status = AXUIElementSetAttributeValue(targetElement, kAXValueAttribute as CFString, text as CFTypeRef)
			if status != .success, let refreshed = refreshElement() {
				targetElement = refreshed
				status = AXUIElementSetAttributeValue(targetElement, kAXValueAttribute as CFString, text as CFTypeRef)
			}
			if status == .success {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				let value = stringAttribute(targetElement, attribute: kAXValueAttribute as CFString) ?? ""
				performed["textCommit"] = "value"
				return try finish(["outcome": "unknown", "performed": performed, "evidence": ["value": value, "valueWriteOnly": true, "valueMatches": value == text]])
			}
			try executeCoordinates(coordinatePoint())
		} else if action == "typeText" {
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			let text = params["text"] as? String ?? ""
			if let element, !focusResolved, try focusKeepingCaret(element, foregroundGranted: foregroundGranted) == .success {
				performed["focused"] = true
			}
			if let element, let inserted = try insertTextThroughEditor(element, text: text, foregroundGranted: foregroundGranted) {
				performed["delivery"] = "ax"
				performed["grounding"] = "description"
				performed["textEntry"] = "selected_text"
				performed["focused"] = true
				let matches = inserted.value == inserted.expected
				rememberCaret(element)
				var evidence: [String: Any] = ["valueChanged": inserted.value != beforeValue, "valueMatches": matches]
				if let value = inserted.value { evidence["value"] = value } else { evidence["valueReadable"] = false }
				return try finish(["outcome": matches ? "worked" : "unknown", "performed": performed, "evidence": evidence])
			}
			acquirePhysicalInputIfNeeded()
			if delivery == "hid" && !preserveFocus { try focusTargetForPhysicalInput() }
			try requireKeyTextSource(delivery: delivery)
			if delivery == "pid" && extendedTarget == nil {
				performed["keyDestination"] = try requirePidKeyDestination(pid: pid, record: record, element: element)
			}
			let baseline = element.flatMap { textBaseline($0) }
			if delivery == "hid" { context?.charactersSent = 0 }
			try postUnicodeText(text, pid: pid, delivery: delivery)
			performed["grounding"] = "coordinates"
			performed["textEntry"] = "characters"
			if let element, !text.isEmpty {
				usleep(30_000)
				let read = stringAttribute(element, attribute: kAXValueAttribute as CFString)
				let afterValue = read ?? ""
				let changed = afterValue != (baseline?.value ?? beforeValue ?? "")
				let expected = baseline.map { expectedTypedValue($0, text: text) }
				let matches = expected.map { afterValue == $0 } ?? false
				var evidence: [String: Any] = ["value": afterValue, "valueChanged": changed, "valueMatches": matches]
				if read == nil { evidence["valueReadable"] = false }
				rememberCaret(element)
				let outcome = matches ? "worked" : (changed ? "unknown" : "didnt")
				return try finish(["outcome": outcome, "performed": performed, "evidence": evidence])
			}
		} else if action == "keypress" {
			let preserveFocus = params["preserveFocus"] as? Bool ?? false
			guard let keys = params["keys"] as? [String], !keys.isEmpty else {
				throw BridgeFailure(message: "keypress requires keys", code: "invalid_args")
			}
			if let element {
				if !focusResolved, try focusKeepingCaret(element, foregroundGranted: foregroundGranted) == .success {
					performed["focused"] = true
				}
				let normalizedKeys = keys.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
				if normalizedKeys.count == 2,
					normalizedKeys.last == "a",
					["cmd", "command", "meta"].contains(normalizedKeys.first ?? ""),
					let value = stringAttribute(element, attribute: kAXValueAttribute as CFString)
				{
					var range = CFRange(location: 0, length: (value as NSString).length)
					try checkpoint()
					context?.markEffect()
					if let selection = AXValueCreate(.cfRange, &range),
						AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection) == .success
					{
						performed["selectionGrounding"] = "ax"
					}
				}
			}
			acquirePhysicalInputIfNeeded()
			if delivery == "hid" && !preserveFocus { try focusTargetForPhysicalInput() }
			if delivery == "hid", keys.contains(where: { keyCharacters($0, flags: []) != nil && keyChord($0.split(separator: "+").map(String.init)) == nil }), keyChord(keys) == nil {
				try requireKeyTextSource(delivery: delivery)
			}
			if delivery == "pid" && extendedTarget == nil {
				performed["keyDestination"] = try requirePidKeyDestination(pid: pid, record: record, element: element)
			}
			try postKeyPress(keys: keys, pid: pid, delivery: delivery)
			performed["grounding"] = "coordinates"
			if let element {
				usleep(30_000)
				rememberCaret(element)
			}
		} else if let element, action == "scroll" {
			let cursorPoint = try? coordinatePoint()
			let before = scrollPositionSignature(element)
			try checkpoint()
			context?.markEffect()
			let result = performScrollActionOrAncestor(startingAt: element, targetPid: pid, scrollX: (params["scrollX"] as? NSNumber)?.intValue ?? 0, scrollY: (params["scrollY"] as? NSNumber)?.intValue ?? 0, steps: 1)
			if (result["scrolled"] as? Bool) == true {
				performed["grounding"] = "description"
				performed["delivery"] = "ax"
				if let cursorPoint { animateCursor(at: cursorPoint) }
				let after = scrollPositionSignature(element)
				return try finish(["outcome": before != after ? "worked" : "unknown", "performed": performed])
			}
			try executeCoordinates(coordinatePoint())
		} else {
			let point = try coordinatePoint()
			if policy == "background" && !foregroundGranted && ["press", "click", "scroll", "drag"].contains(action) {
				try beginBackgroundPidAttempt(at: point)
			}
			try executeCoordinates(point)
		}

		if let probe = attemptProbe {
			let settled = try settleBackgroundAttempt(probe)
			var evidence: [String: Any] = ["deliveryUsed": "pid_pointer", "pidPointerAttempted": true]
			evidence["observableChange"] = settled.changed
			evidence.merge(settled.evidence) { _, new in new }
			if settled.changed {
				if focusedWindowChanged() { evidence["windowChanged"] = true }
				return try finish(["outcome": "worked", "performed": performed, "evidence": evidence])
			}
			if settled.elsewhere {
				evidence["changeOutsideTarget"] = true
				return try finish(["outcome": "unknown", "performed": performed, "evidence": evidence])
			}
			if extendedTarget != nil {
				return try finish(["outcome": "unknown", "performed": performed, "evidence": evidence])
			}
			throw BridgeFailure(
				message: "Pid-targeted pointer input produced no observable change; pointer delivery needs a host foreground grant",
				code: "foreground_required",
				effectPossible: effectBeforeAttempt,
				details: ["evidence": evidence]
			)
		}

		let afterSheetCount = windowElement(pid: pid, windowId: record.windowId).map { sheetElements(of: $0).count } ?? beforeSheetCount
		let windowChanged = focusedWindowChanged() || beforeSheetCount != afterSheetCount
		var outcome = preflightCapsUnknown ? "unknown" : "unknown"
		var evidence: [String: Any] = [:]
		var pointerNoChange = false
		if let element, action == "press" || action == "click" {
			let afterValue = stringAttribute(element, attribute: kAXValueAttribute as CFString)
			let afterSelected = stringAttribute(element, attribute: kAXSelectedTextAttribute as CFString)
			if beforeValue != afterValue || beforeSelected != afterSelected || windowChanged {
				outcome = "worked"
			}
			if pidPointerPosted && pointerWithoutAXAction && axFocusedTarget == nil && outcome != "worked" {
				let changed = try settlePointerChange { pointerChangeObserved(element, baselineCg: pointerBaselineCg) }
				evidence["observableChange"] = changed
				if changed {
					outcome = "worked"
				} else {
					outcome = "didnt"
					pointerNoChange = true
				}
			}
			if let focusTarget = axFocusedTarget {
				let appElement = AXUIElementCreateApplication(pid)
				func focusHeld() -> Bool {
					if boolAttribute(focusTarget, attribute: kAXFocusedAttribute as CFString) == true { return true }
					guard let focused = copyAttribute(appElement, attribute: kAXFocusedUIElementAttribute as CFString).flatMap(asAXElement) else { return false }
					return sameElement(focused, focusTarget) || isElement(focused, descendantOf: focusTarget)
				}
				var held = focusHeld()
				var attempt = 0
				while !held && attempt < 4 {
					try checkpoint()
					usleep(25_000)
					held = focusHeld()
					attempt += 1
				}
				evidence["focusHeld"] = held
				if held {
					outcome = "worked"
				} else if outcome != "worked" {
					outcome = "didnt"
				}
			}
		} else if windowChanged {
			outcome = "worked"
		}
		if windowChanged { evidence["windowChanged"] = true }
		var response: [String: Any] = ["outcome": outcome, "performed": performed]
		if !evidence.isEmpty { response["evidence"] = evidence }
		var output = try finish(response)
		if pointerNoChange, let delta = output["rootDelta"] as? [[String: Any]], !delta.isEmpty {
			output["outcome"] = "worked"
			var upgraded = output["evidence"] as? [String: Any] ?? [:]
			upgraded["observableChange"] = true
			upgraded["rootDelta"] = true
			output["evidence"] = upgraded
		}
		return output
	}

	private struct PointerProbe {
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

	private func capturePointerProbe(pid: Int32, element: AXUIElement?, point: CGPoint) -> PointerProbe {
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

	private func pointerProbeChanged(_ base: PointerProbe, ignoreFocusedElement: Bool = false) -> Bool {
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

	private static let pointerSettleBudget: TimeInterval = 0.4
	private static let pixelCaptureTimeout: TimeInterval = 0.12
	private static let pixelBaselineTimeout: TimeInterval = 0.25
	private static let pixelSampleMaxDimension: Double = 320
	private static let pixelChannelThreshold = 24
	private static let pixelChangedSamplesRequired = 2
	private static let pixelTargetMargin: CGFloat = 8
	private static let pixelPointRadius: CGFloat = 32

	private struct SettledAttempt {
		let changed: Bool
		let elsewhere: Bool
		let evidence: [String: Any]
	}

	private static func pointNeighborhood(_ point: CGPoint) -> CGRect {
		CGRect(x: point.x - pixelPointRadius, y: point.y - pixelPointRadius, width: 2 * pixelPointRadius, height: 2 * pixelPointRadius)
	}

	private static func pathNeighborhoods(_ points: [CGPoint]) -> [CGRect] {
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

	private struct PixelRegion {
		let minX: Int
		let minY: Int
		let maxX: Int
		let maxY: Int

		func contains(column: Int, row: Int) -> Bool {
			column >= minX && column < maxX && row >= minY && row < maxY
		}
	}

	private struct PixelMask {
		let parts: [PixelRegion]

		func contains(column: Int, row: Int) -> Bool {
			parts.contains { $0.contains(column: column, row: row) }
		}
	}

	private func pixelMask(_ probe: PixelProbe, covering rects: [CGRect]) -> PixelMask? {
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

	private struct PixelSnapshot {
		let width: Int
		let height: Int
		let bytes: [UInt8]
	}

	private struct PixelProbe {
		let filter: SCContentFilter
		let config: SCStreamConfiguration
		let windowFrame: CGRect
		let baseline: PixelSnapshot
	}

	private func startPixelProbe(windowId: UInt32) throws -> PixelProbe? {
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

	private func capturePixelSnapshot(_ probe: PixelProbe, timeout: TimeInterval) -> PixelSnapshot? {
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

	private func pixelChanges(_ lhs: PixelSnapshot, _ rhs: PixelSnapshot, region: PixelMask?) -> (target: Bool, elsewhere: Bool) {
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

	private func appFocusedElement(pid: Int32) -> AXUIElement? {
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

	private func batchStepError(_ failure: BridgeFailure, context: RequestContext?) -> [String: Any] {
		var stepError: [String: Any] = ["code": failure.code, "message": failure.message, "effectPossible": failure.effectPossible ?? context?.effectPossible ?? true]
		if let evidence = failure.details?["evidence"] { stepError["evidence"] = evidence }
		for key in ["inputSent", "activationAttempted", "charactersSent", "destinationReason", "extendedDelivery", "extendedDeliveryReason", "keyWindowAcquired", "observedWindowResolved"] {
			if let value = failure.details?[key] { stepError[key] = value }
		}
		return stepError
	}

	private func withDestinationStatus(_ response: [String: Any], context: RequestContext?) -> [String: Any] {
		guard let status = context?.destinationWindowStatus, var performed = response["performed"] as? [String: Any] else { return response }
		var output = response
		performed["destinationWindow"] = status
		output["performed"] = performed
		return output
	}

	private enum PreflightVerdict {
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

	private func preflightVerdict(hit: AXUIElement?, element: AXUIElement?, point: CGPoint, pid: Int32) -> PreflightVerdict {
		let ownerPid = hit.map { pidForElement($0) } ?? cgWindowOwnerPid(at: point)
		if let ownerPid, ownerPid != pid, ownerPid != getpid() { return .occluded }
		guard let element, let hit else { return .capsUnknown }
		if sameElement(hit, element) || isElement(hit, descendantOf: element) || isElement(element, descendantOf: hit) { return .clear }
		let role = stringAttribute(hit, attribute: kAXRoleAttribute as CFString) ?? ""
		if role == "AXWindow" || role == "AXApplication" { return .capsUnknown }
		return .occluded
	}

	private func occludedFailure(hit: AXUIElement?, point: CGPoint) -> BridgeFailure {
		if let hit { return BridgeFailure(message: "Target is occluded by \(payloadNode(element: hit))", code: "occluded_target") }
		let owner = cgWindowOwnerPid(at: point).map { appLabel($0) } ?? "another window"
		return BridgeFailure(message: "Target point is covered by a window of \(owner)", code: "occluded_target")
	}

	private func attachFrontmost(to response: inout [String: Any], before: pid_t?) {
		if let before { response["frontmostBefore"] = Int(before) }
		if let after = NSWorkspace.shared.frontmostApplication?.processIdentifier { response["frontmostAfter"] = Int(after) }
	}

	private func actBatch(_ request: [String: Any]) throws -> [String: Any] {
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

	private func rootIdentity(_ root: [String: Any]) -> String {
		if let windowId = root["windowId"] as? Int, windowId > 0 { return "window:\(windowId)" }
		let kind = root["kind"] as? String ?? "window"
		let title = root["title"] as? String ?? ""
		let role = root["role"] as? String ?? ""
		let frame = root["framePoints"] as? [String: Any] ?? [:]
		let x = Int((frame["x"] as? NSNumber)?.doubleValue ?? 0)
		let y = Int((frame["y"] as? NSNumber)?.doubleValue ?? 0)
		let w = Int((frame["w"] as? NSNumber)?.doubleValue ?? 0)
		let h = Int((frame["h"] as? NSNumber)?.doubleValue ?? 0)
		return "meta:\(kind):\(role):\(title):\(x),\(y),\(w),\(h)"
	}

	private func rootMetadataSnapshot(pid: Int32) -> [String: [String: Any]] {
		let roots = ((try? listRoots(pid: pid)["roots"] as? [[String: Any]]) ?? [])
		return Dictionary(uniqueKeysWithValues: roots.map { (rootIdentity($0), $0) })
	}

	private func rootDelta(before: [String: [String: Any]], beforeFrontmostPid: pid_t?, pid: Int32) -> [[String: Any]] {
		let after = rootMetadataSnapshot(pid: pid)
		var delta: [[String: Any]] = []
		for (key, root) in after where before[key] == nil {
			delta.append(rootDeltaItem(change: "appeared", root: root, pid: pid))
		}
		for (key, root) in before where after[key] == nil {
			delta.append(rootDeltaItem(change: "closed", root: root, pid: pid))
		}
		for (key, root) in after {
			if (root["isFocused"] as? Bool) == true && (before[key]?["isFocused"] as? Bool) != true {
				delta.append(rootDeltaItem(change: "focused", root: root, pid: pid))
			}
		}
		if let beforeFrontmostPid, beforeFrontmostPid != NSWorkspace.shared.frontmostApplication?.processIdentifier {
			if let frontmost = NSWorkspace.shared.frontmostApplication {
				delta.append(["change": "focused", "kind": "app", "title": frontmost.localizedName ?? processName(pid: frontmost.processIdentifier) ?? "Unknown App", "pid": Int(frontmost.processIdentifier)])
			}
		}
		return delta
	}

	private func rootDeltaItem(change: String, root: [String: Any], pid: Int32) -> [String: Any] {
		var item: [String: Any] = ["change": change, "kind": root["kind"] as? String ?? "window", "title": root["title"] as? String ?? "", "pid": root["pid"] as? Int ?? Int(pid)]
		if let isModal = root["isModal"] as? Bool { item["isModal"] = isModal }
		if let metadata = root["metadata"] as? [String: Any] { item["metadata"] = metadata }
		if let ref = root["rootRef"] as? String ?? root["windowRef"] as? String { item["ref"] = ref }
		return item
	}

	private func attachRootDelta(to response: [String: Any], before: [String: [String: Any]], beforeFrontmostPid: pid_t?, pid: Int32, eventsLive: Bool, eventCursor: UInt64, beforeCgSignature: Set<UInt32>) throws -> [String: Any] {
		var output = response
		var performed = output["performed"] as? [String: Any] ?? [:]

		let signalNotifications: Set<String> = ["AXWindowCreated", "AXSheetCreated", "AXMenuOpened", "AXMenuClosed", "AXFocusedWindowChanged"]
		var source = "snapshot"
		let deadline = Date().addingTimeInterval(0.40)
		while Date() < deadline {
			try checkpoint()
			if cgRootSignature(pid: pid) != beforeCgSignature { source = "cg-poll"; break }
			if let beforeFrontmostPid, NSWorkspace.shared.frontmostApplication?.processIdentifier != beforeFrontmostPid { source = "cg-poll"; break }
			if eventsLive && rootEvents(pid: pid, since: eventCursor).contains(where: { signalNotifications.contains($0.notification) }) { source = "events"; break }
			usleep(30_000)
		}

		var delta = rootDelta(before: before, beforeFrontmostPid: beforeFrontmostPid, pid: pid)
		if delta.isEmpty && source != "snapshot" {
			for _ in 0..<3 where delta.isEmpty {
				try checkpoint()
				usleep(80_000)
				delta = rootDelta(before: before, beforeFrontmostPid: beforeFrontmostPid, pid: pid)
			}
		}
		performed["deltaSource"] = source
		output["performed"] = performed
		if !delta.isEmpty { output["rootDelta"] = delta }
		return output
	}

	private func focusedWindowSummary(pid: Int32) -> String {
		let app = AXUIElementCreateApplication(pid)
		guard let element = copyAttribute(app, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement) else { return "none" }
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		return "\(role):\(title)"
	}

	private func scrollPositionSignature(_ element: AXUIElement) -> String {
		let names: [CFString] = ["AXVerticalScrollBar" as CFString, "AXHorizontalScrollBar" as CFString, kAXValueAttribute as CFString]
		return names.map { String(describing: copyAttribute(element, attribute: $0) ?? "" as CFTypeRef) }.joined(separator: "|")
	}

	private func axWaitFor(_ request: [String: Any]) throws -> [String: Any] {
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

	private func hitTestElement(at point: CGPoint) -> AXUIElement? {
		let systemWide = AXUIElementCreateSystemWide()
		var hitElement: AXUIElement?
		let status = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hitElement)
		guard status == .success, let hitElement else { return nil }
		return hitElement
	}

	private let axScrollDownAction = "AXScrollDown" as CFString
	private let axScrollUpAction = "AXScrollUp" as CFString
	private let axScrollLeftAction = "AXScrollLeft" as CFString
	private let axScrollRightAction = "AXScrollRight" as CFString

	private func scrollActionNames(scrollX: Int, scrollY: Int) -> [CFString] {
		var actions: [CFString] = []
		if scrollY > 0 { actions.append(axScrollDownAction) }
		if scrollY < 0 { actions.append(axScrollUpAction) }
		if scrollX > 0 { actions.append(axScrollRightAction) }
		if scrollX < 0 { actions.append(axScrollLeftAction) }
		return actions
	}

	private func supportsAnyScrollAction(_ element: AXUIElement) -> Bool {
		let actions = Set(actionNames(element))
		return actions.contains(axScrollDownAction as String) || actions.contains(axScrollUpAction as String) || actions.contains(axScrollLeftAction as String) || actions.contains(axScrollRightAction as String)
	}

	private func performScrollActionOrAncestor(startingAt element: AXUIElement, targetPid: Int32, scrollX: Int, scrollY: Int, steps: Int) -> [String: Any] {
		let actions = scrollActionNames(scrollX: scrollX, scrollY: scrollY)
		guard !actions.isEmpty else { return ["scrolled": false, "reason": "zero_delta"] }
		var current: AXUIElement? = element
		var depth = 0

		while let candidate = current, depth < 10 {
			if let pid = pidForElement(candidate), pid != targetPid {
				return ["scrolled": false, "reason": "pid_mismatch", "ownerPid": Int(pid)]
			}
			var didScroll = false
			for _ in 0..<steps {
				for action in actions where supportsAction(candidate, action: action) {
					let status = AXUIElementPerformAction(candidate, action)
					if status == .success { didScroll = true }
				}
			}
			if didScroll { return ["scrolled": true] }
			current = parentElement(candidate)
			depth += 1
		}

		return ["scrolled": false, "reason": "no_scroll_action"]
	}

	private func performActionOrAncestor(startingAt element: AXUIElement, action: CFString, targetPid: Int32) -> [String: Any] {
		var current: AXUIElement? = element
		var depth = 0

		while let candidate = current, depth < 10 {
			if let pid = pidForElement(candidate), pid != targetPid {
				return ["performed": false, "reason": "pid_mismatch", "ownerPid": Int(pid)]
			}

			if supportsAction(candidate, action: action) {
				let actionStatus = AXUIElementPerformAction(candidate, action)
				if actionStatus == .success {
					return ["performed": true]
				}
			}

			current = parentElement(candidate)
			depth += 1
		}

		return ["performed": false, "reason": "no_matching_action"]
	}

	private func windowElement(pid: Int32, windowId: UInt32?, windowRef: String? = nil) -> AXUIElement? {
		if let windowRef, let stored = refStore.window(for: windowRef) {
			AXUIElementSetMessagingTimeout(stored, 1.0)
			var ownerPid: pid_t = 0
			if AXUIElementGetPid(stored, &ownerPid) == .success, ownerPid == pid {
				return stored
			}
		}

		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 1.0)
		let windows = Array(axElementArray(appElement, attribute: kAXWindowsAttribute as CFString).prefix(128))
		guard !windows.isEmpty else { return nil }
		guard let windowId else {
			return windows.first
		}
		let candidates = cgWindowCandidates(pid: pid)
		let pairings = windowPairings(windows: windows, candidates: candidates)
		for window in windows {
			if pairings[ObjectIdentifier(window)]?.candidate?.windowId == windowId {
				return window
			}
			for sheet in sheetElements(of: window) {
				if bestCandidate(for: sheet, candidates: candidates)?.windowId == windowId {
					return sheet
				}
			}
		}
		return nil
	}

	private func findDescendant(startingAt root: AXUIElement, maxDepth: Int, predicate: (AXUIElement) -> Bool) -> AXUIElement? {
		collectDescendants(startingAt: root, maxDepth: maxDepth).first(where: predicate)
	}

	private func ensureEnhancedAccessibility(pid: Int32) {
		enhancedAccessibilityLock.lock()
		let inserted = enhancedAccessibilityPids.insert(pid).inserted
		enhancedAccessibilityLock.unlock()
		if !inserted { return }
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		let enhancedStatus = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
		let manualStatus = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
		if isBrowser(pid: pid) && (enhancedStatus == .success || manualStatus == .success) {
			Thread.sleep(forTimeInterval: 0.35)
		}
	}

	private func isBrowser(pid: Int32) -> Bool {
		let app = NSRunningApplication(processIdentifier: pid)
		if browserBundleIds.contains(app?.bundleIdentifier ?? "") { return true }
		let name = (app?.localizedName ?? processName(pid: pid) ?? "").lowercased()
		return ["chrome", "chromium", "brave", "edge", "vivaldi", "opera", "firefox", "helium"].contains { name.contains($0) }
	}

	private func collectDescendants(startingAt root: AXUIElement, maxDepth: Int, maxNodes: Int = 5000) -> [AXUIElement] {
		collectDescendantsWithContext(startingAt: root, maxDepth: maxDepth, maxNodes: maxNodes).map(\.element)
	}

	private func collectDescendantsWithContext(startingAt root: AXUIElement, maxDepth: Int, maxNodes: Int = 5000) -> [AXDescendant] {
		let nodeLimit = max(1, maxNodes)
		var queue: [(AXUIElement, Int, Bool, Bool)] = [(root, 0, false, true)]
		var seen = Set<ObjectIdentifier>()
		var index = 0
		var output: [AXDescendant] = []
		while index < queue.count && output.count < nodeLimit {
			let (element, depth, parentInsideWebArea, inheritedVisible) = queue[index]
			index += 1
			let identity = ObjectIdentifier(element)
			if seen.contains(identity) { continue }
			seen.insert(identity)
			let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
			let insideWebArea = parentInsideWebArea || role == "AXWebArea"
			output.append(AXDescendant(element: element, depth: depth, insideWebArea: insideWebArea, axVisible: inheritedVisible))
			if depth >= maxDepth { continue }
			let children = axElementArray(element, attribute: kAXChildrenAttribute as CFString)
			let visibleChildren = visibleAXChildren(element)
			for child in children {
				if queue.count >= nodeLimit { break }
				let childVisible = inheritedVisible && (visibleChildren.map { set in set.contains { self.sameElement($0, child) } } ?? true)
				queue.append((child, depth + 1, insideWebArea, childVisible))
			}
		}
		return output
	}

	private func visibleAXChildren(_ element: AXUIElement) -> [AXUIElement]? {
		let attributes: [CFString] = [
			kAXVisibleChildrenAttribute as CFString,
			kAXVisibleRowsAttribute as CFString,
			kAXVisibleColumnsAttribute as CFString,
			kAXVisibleCellsAttribute as CFString,
		]
		let visible = attributes.flatMap { axElementArray(element, attribute: $0) }
		return visible.isEmpty ? nil : visible
	}

	private func insideWebAreaMap(_ descendants: [AXDescendant]) -> [ObjectIdentifier: Bool] {
		var output: [ObjectIdentifier: Bool] = [:]
		for descendant in descendants {
			let key = ObjectIdentifier(descendant.element)
			output[key] = (output[key] ?? false) || descendant.insideWebArea
		}
		return output
	}

	private func axSource(role: String, insideWebArea: Bool, isBrowser: Bool, containsWebArea: Bool) -> String {
		if insideWebArea || role == "AXWebArea" { return "web_content_ax" }
		if isBrowser || containsWebArea { return "browser_chrome_ax" }
		return "desktop_ax"
	}

	private func frameForElement(_ element: AXUIElement) -> CGRect? {
		let origin = pointAttribute(element, attribute: kAXPositionAttribute as CFString)
		let size = sizeAttribute(element, attribute: kAXSizeAttribute as CFString)
		guard let origin, let size, size.width > 0, size.height > 0 else { return nil }
		return CGRect(origin: origin, size: size)
	}

	private func elementPayload(element: AXUIElement, key: String, score: Double? = nil, source: String? = nil, axVisible: Bool = true) -> [String: Any] {
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let description = stringAttribute(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
		let identifier = stringAttribute(element, attribute: "AXIdentifier" as CFString) ?? ""
		let value = displayValue(element, role: role, subrole: subrole)
		let frame = frameForElement(element)
		let parentFrame = copyAttribute(element, attribute: kAXParentAttribute as CFString).flatMap(asAXElement).flatMap(frameForElement)
		let centerX = frame.map { $0.midX } ?? 0
		let centerY = frame.map { $0.midY } ?? 0
		var valueSettable = DarwinBoolean(false)
		let valueStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
		var focusedSettable = DarwinBoolean(false)
		let focusedStatus = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &focusedSettable)
		let actions = actionNames(element)
		let canSetValue = valueStatus == .success && valueSettable.boolValue
		let textRoles: Set<String> = [
			"AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField",
		]
		var payload: [String: Any] = [
			key: true,
			"elementRef": refStore.storeElement(element),
			"role": role,
			"subrole": subrole,
			"title": title,
			"description": description,
			"identifier": identifier,
			"value": value,
			"actions": actions,
			"isTextInput": textRoles.contains(role),
			"canSetValue": canSetValue,
			"canFocus": focusedStatus == .success && focusedSettable.boolValue,
			"canPress": actions.contains(kAXPressAction as String),
			"canScroll": supportsAnyScrollAction(element),
			"canIncrement": actions.contains(kAXIncrementAction as String),
			"canDecrement": actions.contains(kAXDecrementAction as String),
			"axVisible": axVisible,
			"x": centerX,
			"y": centerY,
		]
		if let frame {
			payload["frame"] = ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height]
		}
		if let parentFrame {
			payload["parentFrame"] = ["x": parentFrame.origin.x, "y": parentFrame.origin.y, "w": parentFrame.width, "h": parentFrame.height]
		}
		if let score {
			payload["score"] = score
		}
		if let source {
			payload["source"] = source
		}
		return payload
	}

	private func pidForElement(_ element: AXUIElement) -> Int32? {
		var pid: pid_t = 0
		let status = AXUIElementGetPid(element, &pid)
		guard status == .success else { return nil }
		return Int32(pid)
	}

	private func parentElement(_ element: AXUIElement) -> AXUIElement? {
		guard let value = copyAttribute(element, attribute: kAXParentAttribute as CFString) else {
			return nil
		}
		return asAXElement(value)
	}

	private func sameElement(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
		CFEqual(lhs as CFTypeRef, rhs as CFTypeRef)
	}

	private func isElement(_ element: AXUIElement, descendantOf ancestor: AXUIElement) -> Bool {
		var current: AXUIElement? = element
		var depth = 0
		while let candidate = current, depth < 20 {
			if sameElement(candidate, ancestor) {
				return true
			}
			current = parentElement(candidate)
			depth += 1
		}
		return false
	}

	private func ancestryRead<Value>(_ element: AXUIElement, _ attribute: CFString, _ convert: (AnyObject) -> Value?) -> AncestryRead<Value> {
		var value: AnyObject?
		switch AXUIElementCopyAttributeValue(element, attribute, &value) {
		case .success:
			guard let value, let converted = convert(value) else { return .failed }
			return .value(converted)
		case .noValue, .attributeUnsupported:
			return .absent
		default:
			return .failed
		}
	}

	private func ancestorRole(_ element: AXUIElement, role: String) -> AncestryResult {
		walkAncestry(
			from: element,
			role: role,
			limit: ancestryWalkLimit,
			readRole: { ancestryRead($0, kAXRoleAttribute as CFString) { $0 as? String } },
			readParent: { ancestryRead($0, kAXParentAttribute as CFString) { asAXElement($0) } }
		)
	}

	private func actionNames(_ element: AXUIElement) -> [String] {
		var actionsValue: CFArray?
		let status = AXUIElementCopyActionNames(element, &actionsValue)
		guard status == .success else { return [] }
		guard let actionsArray = actionsValue as? [AnyObject] else { return [] }
		return actionsArray.compactMap { $0 as? String }
	}

	private func supportsAction(_ element: AXUIElement, action: CFString) -> Bool {
		actionNames(element).contains(action as String)
	}

	private func focusedElement(_ request: [String: Any]) throws -> [String: Any] {
		let pid = Int32(try intArg(request, "pid"))
		let windowId = optionalIntArg(request, "windowId").map { UInt32($0) }
		let windowRef = optionalStringArg(request, "windowRef")
		try enforceWindowOwners(pid: pid, windowId: windowId, windowRef: windowRef, request: request)
		let app = AXUIElementCreateApplication(pid)
		guard let focusedValue = copyAttribute(app, attribute: kAXFocusedUIElementAttribute as CFString),
			let element = asAXElement(focusedValue)
		else {
			return ["exists": false]
		}
		if let owner = pidForElement(element), owner != pid { try enforceAppPolicy(owner: owner, request: request) }
		if windowId != nil || windowRef != nil {
			guard let window = windowElement(pid: pid, windowId: windowId, windowRef: windowRef) else {
				return ["exists": false, "reason": "window_not_found"]
			}
			guard isElement(element, descendantOf: window) else {
				return ["exists": false, "reason": "focused_element_outside_window"]
			}
		}

		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"

		var settable = DarwinBoolean(false)
		let settableStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
		let canSetValue = settableStatus == .success && settable.boolValue

		let textRoles: Set<String> = [
			"AXTextField",
			"AXTextArea",
			"AXTextView",
			"AXSearchField",
			"AXComboBox",
			"AXEditableText",
			"AXSecureTextField",
		]

		let isTextInput = textRoles.contains(role) || canSetValue
		let elementRef = refStore.storeElement(element)

		return [
			"exists": true,
			"elementRef": elementRef,
			"role": role,
			"subrole": subrole,
			"isTextInput": isTextInput,
			"isSecure": secure,
			"canSetValue": canSetValue,
		]
	}

	private func axReadText(_ request: [String: Any]) throws -> [String: Any] {
		let elementRef = try stringArg(request, "elementRef")
		let offset = max(0, optionalIntArg(request, "offset") ?? 0)
		let limit = max(1, min(100_000, optionalIntArg(request, "limit") ?? 4_000))
		guard let element = refStore.element(for: elementRef) else {
			throw BridgeFailure(message: "Element reference is no longer valid", code: "element_ref_invalid")
		}
		guard let owner = pidForElement(element) else {
			throw BridgeFailure(message: "Element reference is no longer valid", code: "element_ref_invalid")
		}
		try enforceAppPolicy(owner: owner, request: request)
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		guard !isSecureTextElement(role: role, subrole: subrole) else {
			throw BridgeFailure(message: "Refers to a secure text field; refusing to read its value", code: "secure_text_unreadable")
		}
		guard let value = stringAttribute(element, attribute: kAXValueAttribute as CFString) else {
			throw BridgeFailure(message: "Element has no readable AXValue. Call snapshot/screenshot and choose a text-bearing ref.", code: "text_unavailable")
		}
		let characters = Array(value)
		if offset >= characters.count {
			return ["text": "", "offset": offset, "limit": limit, "totalChars": characters.count, "hasMore": false]
		}
		let end = min(characters.count, offset + limit)
		return [
			"text": String(characters[offset..<end]),
			"offset": offset,
			"limit": limit,
			"totalChars": characters.count,
			"hasMore": end < characters.count,
		]
	}

	private func getMousePosition() -> [String: Any] {
		let position = NSEvent.mouseLocation
		return ["x": position.x, "y": position.y]
	}

	private func copyAttribute(_ element: AXUIElement, attribute: CFString) -> AnyObject? {
		var value: AnyObject?
		let status = AXUIElementCopyAttributeValue(element, attribute, &value)
		guard status == .success else { return nil }
		return value
	}

	private func boolAttribute(_ element: AXUIElement, attribute: CFString) -> Bool? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		if let boolValue = value as? Bool {
			return boolValue
		}
		if let number = value as? NSNumber {
			return number.boolValue
		}
		return nil
	}

	private func stringAttribute(_ element: AXUIElement, attribute: CFString) -> String? {
		copyAttribute(element, attribute: attribute) as? String
	}

	private func isSecureTextElement(role: String, subrole: String) -> Bool {
		role == "AXSecureTextField" || subrole == "AXSecureTextField"
	}

	private func displayValue(_ element: AXUIElement, role: String, subrole: String) -> String {
		if isSecureTextElement(role: role, subrole: subrole) { return "" }
		return stringAttribute(element, attribute: kAXValueAttribute as CFString) ?? ""
	}

	private func sheetElements(of window: AXUIElement) -> [AXUIElement] {
		var sheets = axElementArray(window, attribute: "AXSheets" as CFString)
		for child in axElementArray(window, attribute: kAXChildrenAttribute as CFString) {
			guard (stringAttribute(child, attribute: kAXRoleAttribute as CFString) ?? "") == "AXSheet" else { continue }
			if !sheets.contains(where: { CFEqual($0, child) }) { sheets.append(child) }
		}
		return sheets
	}

	private func axElementArray(_ element: AXUIElement, attribute: CFString) -> [AXUIElement] {
		guard let value = copyAttribute(element, attribute: attribute) else { return [] }
		if let array = value as? [AXUIElement] {
			return array
		}
		if let anyArray = value as? [AnyObject] {
			return anyArray.compactMap(asAXElement)
		}
		return []
	}

	private func axElementArrayIfPresent(_ element: AXUIElement, attribute: CFString) -> [AXUIElement]? {
		var value: CFTypeRef?
		let status = AXUIElementCopyAttributeValue(element, attribute, &value)
		guard status == .success, let value else { return nil }
		if let array = value as? [AXUIElement] {
			return array
		}
		if let anyArray = value as? [AnyObject] {
			return anyArray.compactMap(asAXElement)
		}
		return []
	}

	private func asAXElement(_ value: AnyObject) -> AXUIElement? {
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXUIElementGetTypeID() else { return nil }
		return unsafeBitCast(cfValue, to: AXUIElement.self)
	}

	private func pointAttribute(_ element: AXUIElement, attribute: CFString) -> CGPoint? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
		let axValue = unsafeBitCast(cfValue, to: AXValue.self)
		guard AXValueGetType(axValue) == .cgPoint else { return nil }
		var point = CGPoint.zero
		guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
		return point
	}

	private func sizeAttribute(_ element: AXUIElement, attribute: CFString) -> CGSize? {
		guard let value = copyAttribute(element, attribute: attribute) else { return nil }
		let cfValue = value as CFTypeRef
		guard CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
		let axValue = unsafeBitCast(cfValue, to: AXValue.self)
		guard AXValueGetType(axValue) == .cgSize else { return nil }
		var size = CGSize.zero
		guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
		return size
	}

	private func frameForWindow(_ window: AXUIElement) -> CGRect {
		let origin = pointAttribute(window, attribute: kAXPositionAttribute as CFString) ?? .zero
		let size = sizeAttribute(window, attribute: kAXSizeAttribute as CFString) ?? .zero
		return CGRect(origin: origin, size: size)
	}

	private func allCGWindowEntries() -> [[String: Any]] {
		(CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
	}

	private func cgWindowOwners(entries suppliedEntries: [[String: Any]]? = nil) -> [CGWindowOwnerSummary] {
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

	private func pidForWindowId(_ windowId: UInt32) -> Int32? {
		windowInfo(windowId: windowId)?.pid
	}

	private func cgWindowCandidates(pid: Int32, entries suppliedEntries: [[String: Any]]? = nil) -> [CGWindowCandidate] {
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

	private func cgBroadRootOwners(entries: [[String: Any]]) -> [CGWindowOwnerSummary] {
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

	private func cgPopupMenuCandidates(pid: Int32?, entries: [[String: Any]]) -> [CGWindowCandidate] {
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

	private func openMenuElements(pid: Int32, messagingTimeout: Float = 1.0) -> [AXUIElement] {
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

	private func bestCandidate(for element: AXUIElement, candidates: [CGWindowCandidate]) -> CGWindowCandidate? {
		let title = stringAttribute(element, attribute: kAXTitleAttribute as CFString) ?? ""
		let frame = frameForWindow(element)
		return candidates.max { left, right in
			windowPairScore(frame: frame, title: title, candidate: left) < windowPairScore(frame: frame, title: title, candidate: right)
		}
	}

	private func pairingForWindow(_ window: AXUIElement, pid: Int32) -> WindowPairing {
		windowPairings(windows: [window], candidates: cgWindowCandidates(pid: pid))[ObjectIdentifier(window)] ?? WindowPairing(candidate: nil, score: -Double.greatestFiniteMagnitude, confidence: "low")
	}

	private func windowPairings(windows: [AXUIElement], candidates: [CGWindowCandidate]) -> [ObjectIdentifier: WindowPairing] {
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

	private func displayScaleFactor(for frame: CGRect) -> Double {
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

	private func agentCursorState(_ request: [String: Any]) throws -> [String: Any] {
		guard supportsAgentCursor else { return ["supported": false] }
		guard !Thread.isMainThread else {
			throw BridgeFailure(message: "agentCursorState must not run on the main thread", code: "invalid_state")
		}
		let semaphore = DispatchSemaphore(value: 0)
		let state = Box<(snapshot: AgentCursorSnapshot, displays: [[String: Any]])?>(nil)
		Task { @MainActor in
			defer { semaphore.signal() }
			let displays = NSScreen.screens.compactMap { screen -> [String: Any]? in
				guard let id = DisplayGeometry.displayID(of: screen) else { return nil }
				return [
					"id": Int(id),
					"bounds": rectPayload(CGDisplayBounds(id)),
					"frame": rectPayload(screen.frame),
					"scale": Double(screen.backingScaleFactor),
					"keyScreen": screen == NSScreen.main,
				]
			}
			state.value = (AgentCursor.shared.snapshot(), displays)
		}
		guard semaphore.wait(timeout: .now() + .seconds(3)) == .success, let current = state.value else {
			throw BridgeFailure(message: "The agent cursor state did not arrive from the main thread", code: "timeout")
		}
		let snapshot = current.snapshot
		var output: [String: Any] = ["supported": true, "displays": current.displays]
		if let number = snapshot.windowNumber, let display = snapshot.display {
			var overlay: [String: Any] = [
				"windowNumber": number,
				"visible": snapshot.visible,
				"displayId": Int(display.id),
				"displayBounds": rectPayload(display.bounds),
			]
			if let frame = snapshot.windowFrame { overlay["frame"] = rectPayload(frame) }
			if let entry = windowServerEntry(windowNumber: number) {
				overlay["windowServerBounds"] = rectPayload(entry.bounds)
				overlay["windowServerOnscreen"] = entry.onscreen
			}
			output["overlay"] = overlay
			if request["capture"] as? Bool == true {
				output["capture"] = captureOverlayPointer(windowNumber: number, pointsWide: display.bounds.width)
			}
		} else {
			output["overlay"] = NSNull()
		}
		var pointer: [String: Any] = ["animating": snapshot.animating]
		if let target = snapshot.target { pointer["target"] = ["x": target.x, "y": target.y] }
		if let local = snapshot.localTarget { pointer["local"] = ["x": local.x, "y": local.y] }
		if let position = snapshot.position { pointer["position"] = ["x": position.x, "y": position.y] }
		output["pointer"] = pointer
		if let unplaced = snapshot.unplacedPoint { output["unplacedPoint"] = ["x": unplaced.x, "y": unplaced.y] }
		return output
	}

	private func windowServerEntry(windowNumber: Int) -> (bounds: CGRect, onscreen: Bool)? {
		guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowNumber)) as? [[String: Any]],
			let info = list.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == windowNumber }),
			let raw = info[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary)
		else { return nil }
		return (bounds, (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
	}

	private func captureOverlayPointer(windowNumber: Int, pointsWide: CGFloat) -> [String: Any] {
		let semaphore = DispatchSemaphore(value: 0)
		let captured = Box<CGImage?>(nil)
		let failure = Box<String?>(nil)
		let task = Task {
			defer { semaphore.signal() }
			do {
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
				guard let window = shareable.windows.first(where: { Int($0.windowID) == windowNumber }) else {
					failure.value = "the overlay window is not capturable"
					return
				}
				let config = SCStreamConfiguration()
				config.width = max(1, Int(window.frame.width.rounded()))
				config.height = max(1, Int(window.frame.height.rounded()))
				config.showsCursor = false
				config.ignoreShadowsSingleWindow = true
				captured.value = try await SCScreenshotManager.captureImage(
					contentFilter: SCContentFilter(desktopIndependentWindow: window),
					configuration: config
				)
			} catch {
				failure.value = error.localizedDescription
			}
		}
		if semaphore.wait(timeout: .now() + .seconds(5)) == .timedOut {
			task.cancel()
			return ["error": "capture timed out"]
		}
		if let message = failure.value { return ["error": message] }
		guard let image = captured.value else { return ["error": "capture returned no image"] }
		return pointerPixels(in: image, pointsWide: pointsWide)
	}

	private func pointerPixels(in image: CGImage, pointsWide: CGFloat) -> [String: Any] {
		let width = image.width
		let height = image.height
		var bytes = [UInt8](repeating: 0, count: width * height * 4)
		let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
			guard let context = CGContext(
				data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
				space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
			) else { return false }
			context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
			return true
		}
		guard drawn, pointsWide > 0 else { return ["error": "could not read the captured pixels"] }
		var count = 0
		var minX = width, minY = height, maxX = -1, maxY = -1
		for row in 0..<height {
			for column in 0..<width {
				let offset = (row * width + column) * 4
				guard bytes[offset + 3] >= 153, bytes[offset] >= 180 else { continue }
				count += 1
				minX = min(minX, column)
				maxX = max(maxX, column)
				minY = min(minY, row)
				maxY = max(maxY, row)
			}
		}
		let pixelsPerPoint = Double(width) / Double(pointsWide)
		var output: [String: Any] = ["width": width, "height": height, "pixelsPerPoint": pixelsPerPoint, "opaquePixels": count]
		if count > 0 {
			output["bounds"] = [
				"x": Double(minX) / pixelsPerPoint,
				"y": Double(minY) / pixelsPerPoint,
				"w": Double(maxX - minX + 1) / pixelsPerPoint,
				"h": Double(maxY - minY + 1) / pixelsPerPoint,
			]
		} else {
			output["bounds"] = NSNull()
		}
		return output
	}

	private func captureWindow(windowId: UInt32) throws -> CapturedWindowImage {
		if #available(macOS 14.0, *) {
			let semaphore = DispatchSemaphore(value: 0)
			let capturedImage = Box<CGImage?>(nil)
			let capturedError = Box<Error?>(nil)

			let task = Task {
				defer { semaphore.signal() }
				do {
					if Task.isCancelled {
						return
					}
					let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
					guard let window = shareable.windows.first(where: { $0.windowID == windowId }) else {
						throw BridgeFailure(message: "Window \(windowId) is not available for capture", code: "window_not_found")
					}

					let filter = SCContentFilter(desktopIndependentWindow: window)
					let config = SCStreamConfiguration()
					let scale = displayScaleFactor(for: window.frame)
					config.width = max(1, Int((window.frame.width * scale).rounded()))
					config.height = max(1, Int((window.frame.height * scale).rounded()))
					config.showsCursor = false
					config.ignoreShadowsSingleWindow = true

					let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
					capturedImage.value = image
				} catch {
					capturedError.value = error
				}
			}

			if semaphore.wait(timeout: .now() + .seconds(8)) == .timedOut {
				task.cancel()
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				throw BridgeFailure(message: "Capture timed out while capturing window \(windowId)", code: "capture_timeout")
			}

			if let error = capturedError.value {
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				if let failure = error as? BridgeFailure {
					throw failure
				}
				throw BridgeFailure(message: "Capture failed: \(error.localizedDescription)", code: "capture_failed")
			}

			guard let image = capturedImage.value else {
				if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
					return payload
				}
				throw BridgeFailure(message: "Capture failed", code: "capture_failed")
			}

			return CapturedWindowImage(image: image, windowId: windowId, frame: currentWindowBounds(windowId: windowId) ?? CGRect(x: 0, y: 0, width: image.width, height: image.height))
		}
		if let payload = try cgWindowScreenshotFallback(windowId: windowId) {
			return payload
		}
		throw BridgeFailure(message: "Capture failed", code: "capture_failed")
	}

	private func jpegData(image: CGImage, quality: Double) -> Data? {
		let data = NSMutableData()
		guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
		CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
		guard CGImageDestinationFinalize(destination) else { return nil }
		return data as Data
	}

	private func downscaledImage(_ image: CGImage, maxDimension: Int?) -> CGImage? {
		guard let maxDimension, max(image.width, image.height) > maxDimension else { return nil }
		let scale = Double(maxDimension) / Double(max(image.width, image.height))
		let width = max(1, Int(Double(image.width) * scale))
		let height = max(1, Int(Double(image.height) * scale))
		guard let context = CGContext(
			data: nil,
			width: width,
			height: height,
			bitsPerComponent: image.bitsPerComponent,
			bytesPerRow: 0,
			space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: image.bitmapInfo.rawValue
		) else { return nil }
		context.interpolationQuality = .medium
		context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
		return context.makeImage()
	}

	private func cgWindowScreenshotFallback(windowId: UInt32) throws -> CapturedWindowImage? {
		if let payload = try systemScreenshotWindow(windowId: windowId) {
			return payload
		}
		return nil
	}

	private func systemScreenshotWindow(windowId: UInt32) throws -> CapturedWindowImage? {
		let tempUrl = FileManager.default.temporaryDirectory.appendingPathComponent("pi-cu-\(UUID().uuidString).png")
		defer { try? FileManager.default.removeItem(at: tempUrl) }
		FileManager.default.createFile(atPath: tempUrl.path, contents: nil, attributes: [.posixPermissions: 0o600])

		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
		process.arguments = ["-x", "-l", String(windowId), tempUrl.path]
		try process.run()
		let deadline = Date().addingTimeInterval(5)
		while process.isRunning && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.05)
		}
		if process.isRunning {
			process.terminate()
			Thread.sleep(forTimeInterval: 0.1)
			if process.isRunning { process.interrupt() }
			return nil
		}
		guard process.terminationStatus == 0 else { return nil }
		guard let data = try? Data(contentsOf: tempUrl), !data.isEmpty else { return nil }
		guard let imageRep = NSBitmapImageRep(data: data), let cgImage = imageRep.cgImage else { return nil }
		return CapturedWindowImage(image: cgImage, windowId: windowId, frame: currentWindowBounds(windowId: windowId) ?? CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
	}

	private func currentWindowBounds(windowId: UInt32) -> CGRect? {
		if #available(macOS 14.0, *), let scBounds = currentWindowBoundsViaScreenCaptureKit(windowId: windowId) {
			return scBounds
		}
		return windowInfo(windowId: windowId)?.bounds
	}

	private func windowInfo(windowId: UInt32) -> (pid: Int32, bounds: CGRect)? {
		func matchingEntry(_ entries: [[String: Any]]?) -> [String: Any]? {
			entries?.first {
				($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId
			}
		}

		let requestedIds = [NSNumber(value: windowId)] as CFArray
		let targetedEntries = CGWindowListCreateDescriptionFromArray(requestedIds) as? [[String: Any]]
		let entry = matchingEntry(targetedEntries) ?? matchingEntry(
			CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]
		)
		guard let entry,
			let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
			let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
			let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
		else {
			return nil
		}
		return (pid, bounds)
	}

	@available(macOS 14.0, *)
	private func currentWindowBoundsViaScreenCaptureKit(windowId: UInt32) -> CGRect? {
		let semaphore = DispatchSemaphore(value: 0)
		let output = Box<CGRect?>(nil)

		let task = Task {
			defer { semaphore.signal() }
			do {
				if Task.isCancelled {
					return
				}
				let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				if let window = shareable.windows.first(where: { $0.windowID == windowId }) {
					output.value = window.frame
				}
			} catch {
				output.value = nil
			}
		}

		if semaphore.wait(timeout: .now() + .seconds(2)) == .timedOut {
			task.cancel()
			return nil
		}
		return output.value
	}

	private struct ExtendedDeliveryPlan {
		let status: String?
		let reason: String?
		let target: ExtendedDeliveryTarget?
		static let notRequested = ExtendedDeliveryPlan(status: nil, reason: nil, target: nil)
	}

	private static let menuRoles: Set<String> = ["AXPopUpButton", "AXMenuButton", "AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem"]
	private static let extendedTextRoles: Set<String> = ["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox", "AXEditableText", "AXSecureTextField"]

	private func extendedDeliveryPlan(request: [String: Any], record: LookRecord, pid: Int32, action: String, target: [String: Any], policy: String, delivery: String) -> ExtendedDeliveryPlan {
		guard optionalStringArg(request, "backgroundDelivery") == "extended" else { return .notRequested }
		func notApplicable(_ reason: String) -> ExtendedDeliveryPlan { ExtendedDeliveryPlan(status: "not_applicable", reason: reason, target: nil) }
		let support = ExtendedDeliverySupport.shared
		if let reason = support.unavailableReason { return ExtendedDeliveryPlan(status: "unavailable", reason: reason, target: nil) }
		guard policy == "background", delivery == "pid" else { return notApplicable("policy_\(policy)") }
		if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return notApplicable("target_frontmost") }
		guard record.windowId != 0, record.windowFrame.width > 0, record.windowFrame.height > 0 else { return notApplicable("no_window_id") }
		if let reason = extendedElementExclusion(request: request, record: record, pid: pid, action: action, target: target) { return notApplicable(reason) }
		return ExtendedDeliveryPlan(status: "used", reason: nil, target: ExtendedDeliveryTarget(pid: pid, windowId: record.windowId, windowFrame: record.windowFrame))
	}

	private func extendedElementExclusion(request: [String: Any], record: LookRecord, pid: Int32, action: String, target: [String: Any]) -> String? {
		let element: AXUIElement
		if optionalStringArg(request, "focusResolution") == "ax_focused_element" {
			guard let focused = appFocusedElement(pid: pid), pidForElement(focused) == pid else { return "element_unidentified" }
			element = focused
		} else if let ref = target["ref"] as? String {
			let cached = refStore.element(for: ref).flatMap { stringAttribute($0, attribute: kAXRoleAttribute as CFString) != nil && frameForElement($0) != nil ? $0 : nil }
			guard let resolved = cached ?? refindElement(ref: ref, pid: pid, windowId: record.windowId) else { return "stale_ref" }
			element = resolved
		} else if let pointX = (target["x"] as? NSNumber)?.doubleValue, let pointY = (target["y"] as? NSNumber)?.doubleValue {
			guard record.hasImage, let hit = targetElement(at: lookPoint(record: record, x: pointX, y: pointY), pid: pid, record: record) else { return "element_unidentified" }
			element = hit
		} else {
			return "element_unidentified"
		}
		if opensMenu(element) { return "menu_element" }
		let role = stringAttribute(element, attribute: kAXRoleAttribute as CFString) ?? ""
		let subrole = stringAttribute(element, attribute: kAXSubroleAttribute as CFString) ?? ""
		if isSecureTextElement(role: role, subrole: subrole) { return "secure_text" }
		guard target["ref"] is String else { return nil }
		switch ancestorRole(element, role: "AXWebArea") {
		case .found:
			return nil
		case .inconclusive:
			return "web_ancestry_inconclusive"
		case .notFound:
			break
		}
		switch action {
		case "press", "click":
			if Self.extendedTextRoles.contains(role) { return "ax_focus" }
			if supportsAction(element, action: kAXPressAction as CFString) { return "ax_action" }
			return nil
		case "setText":
			return "ax_text"
		default:
			return nil
		}
	}

	private func opensMenu(_ element: AXUIElement) -> Bool {
		var current: AXUIElement? = element
		for _ in 0..<6 {
			guard let node = current else { return false }
			if let role = stringAttribute(node, attribute: kAXRoleAttribute as CFString), Self.menuRoles.contains(role) { return true }
			current = parentElement(node)
		}
		return false
	}

	private func targetElement(at point: CGPoint, pid: Int32, record: LookRecord) -> AXUIElement? {
		let app = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(app, 1.0)
		var hit: AXUIElement?
		guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success, let hit, pidForElement(hit) == pid,
			let window = lookWindowElement(record, pid: pid) ?? windowElement(pid: pid, windowId: record.windowId)
		else { return nil }
		if let hitWindow = copyAttribute(hit, attribute: kAXWindowAttribute as CFString).flatMap(asAXElement), windowsRelated(hitWindow, window) { return hit }
		var current: AXUIElement? = hit
		for _ in 0..<64 {
			guard let node = current else { return nil }
			if sameElement(node, window) { return hit }
			current = parentElement(node)
		}
		return nil
	}

	private func withExtendedDeliveryStatus(_ response: [String: Any], plan: ExtendedDeliveryPlan) -> [String: Any] {
		guard let status = plan.status else { return response }
		var output = response
		var performed = output["performed"] as? [String: Any] ?? [:]
		performed["extendedDelivery"] = status
		if let reason = plan.reason { performed["extendedDeliveryReason"] = reason }
		output["performed"] = performed
		guard status == "used" else { return output }
		var evidence = output["evidence"] as? [String: Any] ?? [:]
		evidence["extendedDelivery"] = "used"
		if (output["outcome"] as? String) == "didnt" {
			output["outcome"] = "unknown"
			evidence["observableChange"] = false
		}
		output["evidence"] = evidence
		return output
	}

	private func beginExtendedDelivery(_ target: ExtendedDeliveryTarget) throws {
		extendedActivationLock.lock()
		if extendedShuttingDown {
			extendedActivationLock.unlock()
			throw BridgeFailure(message: "The helper is shutting down; extended background delivery was not started and nothing was sent", code: "helper_shutting_down", effectPossible: false)
		}
		let count = (extendedActivations[target.pid]?.count ?? 0) + 1
		extendedActivations[target.pid] = (count, target)
		postAppKitActivation(target, activated: true)
		postKeyWindowRecords(target)
		extendedActivationLock.unlock()
		usleep(30_000)
	}

	private func requireExtendedKeyWindow(_ target: ExtendedDeliveryTarget, window: AXUIElement?) throws {
		guard let window else {
			throw BridgeFailure(
				message: "Extended background delivery could not resolve the observed window, so it could not confirm that window is the target's key window; no key input was sent, only the activation",
				code: "foreground_required",
				effectPossible: false,
				details: ["keyWindowAcquired": false, "observedWindowResolved": false]
			)
		}
		for attempt in 0..<8 {
			if isKeyWindow(window, pid: target.pid) { return }
			try checkpoint()
			if attempt == 2 {
				extendedActivationLock.lock()
				if !extendedShuttingDown { postKeyWindowRecords(target) }
				extendedActivationLock.unlock()
			}
			usleep(25_000)
		}
		if isKeyWindow(window, pid: target.pid) { return }
		throw BridgeFailure(
			message: "Extended background delivery could not make the observed window the target's key window; no key input was sent",
			code: "foreground_required",
			effectPossible: false,
			details: ["keyWindowAcquired": false, "observedWindowResolved": true]
		)
	}

	private func settleExtendedKeyWindow(_ target: ExtendedDeliveryTarget, window: AXUIElement?) throws {
		guard let window else { return }
		for _ in 0..<8 {
			if isKeyWindow(window, pid: target.pid) { return }
			try checkpoint()
			usleep(25_000)
		}
	}

	private func endExtendedDelivery(_ target: ExtendedDeliveryTarget) {
		extendedActivationLock.lock()
		defer { extendedActivationLock.unlock() }
		guard let entry = extendedActivations[target.pid] else { return }
		if entry.count > 1 {
			extendedActivations[target.pid] = (entry.count - 1, entry.target)
			return
		}
		extendedActivations.removeValue(forKey: target.pid)
		postAppKitActivation(target, activated: false)
	}

	private func deactivateExtendedTargets() {
		extendedActivationLock.lock()
		defer { extendedActivationLock.unlock() }
		extendedShuttingDown = true
		for entry in extendedActivations.values { postAppKitActivation(entry.target, activated: false) }
		extendedActivations.removeAll()
	}

	private func installTerminationHandlers() {
		for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
			_ = signal(signalNumber, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: DispatchQueue.global())
			source.setEventHandler { [self] in
				deactivateExtendedTargets()
				exit(0)
			}
			source.resume()
			terminationSources.append(source)
		}
	}

	private func postAppKitActivation(_ target: ExtendedDeliveryTarget, activated: Bool) {
		let subtype = activated ? NSEvent.EventSubtype.applicationActivated.rawValue : NSEvent.EventSubtype.applicationDeactivated.rawValue
		let centre = CGPoint(x: target.windowFrame.width / 2, y: target.windowFrame.height / 2)
		guard let event = NSEvent.otherEvent(
			with: .appKitDefined, location: centre, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
			windowNumber: Int(target.windowId), context: nil, subtype: subtype, data1: 0, data2: 0
		),
			let cgEvent = event.cgEvent
		else { return }
		cgEvent.postToPid(target.pid)
	}

	private func postKeyWindowRecords(_ target: ExtendedDeliveryTarget) {
		let support = ExtendedDeliverySupport.shared
		guard let post = support.postRecord, let getPSN = support.getPSN else { return }
		var psn = ProcessSerialNumber()
		let found = withUnsafeMutablePointer(to: &psn) { getPSN(target.pid, UnsafeMutableRawPointer($0)) }
		guard found == 0 else { return }
		let windowBytes = withUnsafeBytes(of: target.windowId.littleEndian) { Array($0) }
		for phase: UInt8 in [0x01, 0x02] {
			var bytes = [UInt8](repeating: 0, count: 0xf8)
			bytes[0x04] = 0xf8
			bytes[0x08] = phase
			bytes[0x3a] = 0x10
			for index in 0x20..<0x30 { bytes[index] = 0xff }
			for (index, byte) in windowBytes.enumerated() { bytes[0x3c + index] = byte }
			_ = withUnsafeMutablePointer(to: &psn) { psnPointer in
				bytes.withUnsafeMutableBufferPointer { buffer -> Int32 in
					guard let base = buffer.baseAddress else { return -1 }
					return post(UnsafeMutableRawPointer(psnPointer), base)
				}
			}
		}
	}

	private static let extendedPointerTypes: Set<CGEventType> = [
		.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
		.otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel,
	]

	private func addressPointerEvent(_ event: CGEvent, pid: Int32, context: RequestContext?) {
		let scrollTarget = event.type == .scrollWheel ? context?.pidScrollWindow : nil
		guard let target = context?.extendedDelivery ?? scrollTarget, target.pid == pid, Self.extendedPointerTypes.contains(event.type),
			let windowField = CGEventField(rawValue: 51)
		else { return }
		event.setIntegerValueField(windowField, value: Int64(target.windowId))
		let point = event.location
		ExtendedDeliverySupport.shared.setWindowLocation?(event, CGPoint(x: point.x - target.windowFrame.origin.x, y: point.y - target.windowFrame.origin.y))
	}

	private func eventDelivery(_ request: [String: Any]) -> String {
		optionalStringArg(request, "delivery") == "pid" ? "pid" : "hid"
	}

	private func postEvent(_ event: CGEvent, pid: Int32, delivery: String = "hid") throws {
		let context = activeRequestContext()
		if delivery == "pid" {
			context?.markEffect()
			context?.markInputEvent()
			addressPointerEvent(event, pid: pid, context: context)
			event.postToPid(pid)
			return
		}
		guard let context, context.foregroundGrant else {
			throw foregroundRequired("HID event delivery requires a host foreground grant")
		}
		try requireFrontmostForHIDPost(pid: pid, context: context)
		context.markEffect()
		context.markInputEvent()
		event.post(tap: .cghidEventTap)
	}

	private func postReleaseEvent(_ event: CGEvent, pid: Int32, delivery: String) throws {
		let context = activeRequestContext()
		if delivery == "pid" {
			context?.markEffect()
			context?.markInputEvent()
			addressPointerEvent(event, pid: pid, context: context)
			event.postToPid(pid)
			return
		}
		guard let context, context.foregroundGrant else {
			throw foregroundRequired("HID event delivery requires a host foreground grant")
		}
		context.markEffect()
		context.markInputEvent()
		event.post(tap: .cghidEventTap)
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
			throw destinationFailure(pid: pid, context: context, reason: "process_not_found", frontmostPid: currentFrontmostPid())
		}
		let front = currentFrontmostPid()
		if front != pid {
			throw destinationFailure(pid: pid, context: context, reason: "app_not_frontmost", frontmostPid: front)
		}
	}

	private static let foregroundAcquireBudget: TimeInterval = 0.4
	private static let foregroundPollMicros: useconds_t = 20_000
	private static let foregroundRecheckInterval: TimeInterval = 0.1

	private enum HIDGesture {
		case keyboard
		case pointer(CGPoint)
	}

	private enum DestinationProbe {
		case confirmed(windowVerified: Bool)
		case mismatch(reason: String, frontmostPid: pid_t?)
		case gone
	}

	private func currentFrontmostPid() -> pid_t? {
		let systemWide = AXUIElementCreateSystemWide()
		AXUIElementSetMessagingTimeout(systemWide, 0.25)
		if let focusedApp = copyAttribute(systemWide, attribute: kAXFocusedApplicationAttribute as CFString).flatMap(asAXElement),
			let focusedPid = pidForElement(focusedApp)
		{
			return focusedPid
		}
		return NSWorkspace.shared.frontmostApplication?.processIdentifier
	}

	private func lookWindowElement(_ record: LookRecord, pid: Int32) -> AXUIElement? {
		guard let root = record.rootElement, pidForElement(root) == pid else { return nil }
		let role = stringAttribute(root, attribute: kAXRoleAttribute as CFString) ?? ""
		return role == "AXWindow" || role == "AXSheet" ? root : nil
	}

	private func destinationWindow(_ destination: HIDDestination, context: RequestContext) -> AXUIElement? {
		if !context.destinationWindowResolved {
			context.destinationWindowResolved = true
			let observed = destination.window.flatMap { window in
				stringAttribute(window, attribute: kAXRoleAttribute as CFString) == nil ? nil : window
			}
			context.destinationWindowElement = observed
				?? (destination.windowId == 0 ? nil : windowElement(pid: destination.pid, windowId: destination.windowId))
		}
		return context.destinationWindowElement
	}

	private func windowsRelated(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
		sameElement(lhs, rhs) || isElement(lhs, descendantOf: rhs) || isElement(rhs, descendantOf: lhs)
	}

	private func probeDestination(_ gesture: HIDGesture, destination: HIDDestination, context: RequestContext) -> DestinationProbe {
		guard let app = NSRunningApplication(processIdentifier: destination.pid), !app.isTerminated else { return .gone }
		let front = currentFrontmostPid()
		guard front == destination.pid else { return .mismatch(reason: "app_not_frontmost", frontmostPid: front) }
		if case .pointer(let point) = gesture, let hit = hitTestElement(at: point), let hitPid = pidForElement(hit),
			hitPid != destination.pid, hitPid != getpid()
		{
			return .mismatch(reason: "point_covered_by_other_process", frontmostPid: front)
		}
		let appElement = AXUIElementCreateApplication(destination.pid)
		AXUIElementSetMessagingTimeout(appElement, 0.25)
		let keyWindow = copyAttribute(appElement, attribute: kAXFocusedWindowAttribute as CFString).flatMap(asAXElement)
			?? copyAttribute(appElement, attribute: kAXMainWindowAttribute as CFString).flatMap(asAXElement)
		guard let keyWindow, let lookWindow = destinationWindow(destination, context: context) else {
			return .confirmed(windowVerified: false)
		}
		if windowsRelated(keyWindow, lookWindow) { return .confirmed(windowVerified: true) }
		return .mismatch(reason: "window_not_focused", frontmostPid: front)
	}

	private func appLabel(_ pid: Int32) -> String {
		let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? processName(pid: pid) ?? "pid \(pid)"
		return "\(name) (pid \(pid))"
	}

	private func destinationFailure(pid: Int32, context: RequestContext, reason: String, frontmostPid: pid_t?) -> BridgeFailure {
		let destination = context.hidDestination
		let sent = context.inputEventCount > (destination?.inputBaseline ?? 0)
		let target = appLabel(pid)
		let cause: String
		switch reason {
		case "process_not_found":
			cause = "the target process \(target) is no longer running"
		case "no_destination":
			cause = "no foreground destination was recorded for \(target)"
		case "window_not_focused":
			cause = "\(target) is frontmost, but its focused window is not this look's window"
		case "point_covered_by_other_process":
			cause = "the point is covered by another process's window"
		default:
			cause = "\(target) is not the frontmost app" + (frontmostPid.map { "; \(appLabel($0)) is" } ?? "")
		}
		var details: [String: Any] = [
			"inputSent": sent,
			"activationAttempted": context.activationAttempted,
			"destinationReason": reason,
			"targetPid": Int(pid),
		]
		if let frontmostPid { details["frontmostPid"] = Int(frontmostPid) }
		if let before = destination?.frontmostBefore { details["frontmostBefore"] = Int(before) }
		if let after = NSWorkspace.shared.frontmostApplication?.processIdentifier { details["frontmostAfter"] = Int(after) }
		let activation = context.activationAttempted
			? " The helper asked the target to activate or raise its window; that side effect may still bring it to the front."
			: ""
		if sent {
			let characters = context.charactersSent
			if let characters { details["charactersSent"] = characters }
			var result: [String: Any] = ["outcome": "partial", "stoppedAt": context.currentStep]
			if let characters { result["charactersSent"] = characters }
			let typed = characters.map { " \($0) character(s) of the text were sent first." } ?? ""
			return BridgeFailure(
				message: "Foreground input stopped after some input was sent: \(cause). Nothing more was sent.\(typed)\(activation)",
				code: "foreground_lost",
				effectPossible: true,
				result: result,
				details: details
			)
		}
		let waited = reason == "process_not_found" || reason == "no_destination" ? "" : " within \(Int(Self.foregroundAcquireBudget * 1000)) ms"
		return BridgeFailure(
			message: "No input was sent; the target did not come to the front\(waited): \(cause).\(activation)",
			code: "foreground_not_acquired",
			effectPossible: context.effectPossible,
			details: details
		)
	}

	private func confirmHIDDestination(_ gesture: HIDGesture, pid: Int32) throws {
		guard let context = activeRequestContext(), context.foregroundGrant else {
			throw foregroundRequired("HID event delivery requires a host foreground grant")
		}
		guard let destination = context.hidDestination, destination.pid == pid else {
			throw destinationFailure(pid: pid, context: context, reason: "no_destination", frontmostPid: currentFrontmostPid())
		}
		let sent = context.inputEventCount > destination.inputBaseline
		let deadline = Date().addingTimeInterval(sent ? 0 : Self.foregroundAcquireBudget)
		var activationRequested = false
		while true {
			try checkpoint()
			switch probeDestination(gesture, destination: destination, context: context) {
			case .confirmed(let windowVerified):
				if !windowVerified {
					context.destinationWindowStatus = "unverified"
				} else if context.destinationWindowStatus == nil {
					context.destinationWindowStatus = "verified"
				}
				context.lastDestinationCheck = Date()
				return
			case .gone:
				throw destinationFailure(pid: pid, context: context, reason: "process_not_found", frontmostPid: currentFrontmostPid())
			case .mismatch(let reason, let front):
				if Date() >= deadline { throw destinationFailure(pid: pid, context: context, reason: reason, frontmostPid: front) }
				if !activationRequested, reason == "app_not_frontmost", let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
					activationRequested = true
					context.markEffect()
					context.activationAttempted = true
					if #available(macOS 14.0, *) {
						_ = app.activate()
					} else {
						_ = app.activate(options: [.activateIgnoringOtherApps])
					}
				}
			}
			usleep(Self.foregroundPollMicros)
		}
	}

	private func hidGesture(_ gesture: HIDGesture, pid: Int32, delivery: String, _ body: () throws -> Void) throws {
		guard delivery == "hid", let context = activeRequestContext() else { return try body() }
		if context.hidGestureActive { return try body() }
		try confirmHIDDestination(gesture, pid: pid)
		context.hidGestureActive = true
		defer { context.hidGestureActive = false }
		try body()
	}

	private func requireFrontmostForHIDPost(pid: Int32, context: RequestContext) throws {
		guard let destination = context.hidDestination, destination.pid == pid else {
			throw destinationFailure(pid: pid, context: context, reason: "no_destination", frontmostPid: currentFrontmostPid())
		}
		guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
			throw destinationFailure(pid: pid, context: context, reason: "process_not_found", frontmostPid: currentFrontmostPid())
		}
		let front = currentFrontmostPid()
		guard front == pid else {
			throw destinationFailure(pid: pid, context: context, reason: "app_not_frontmost", frontmostPid: front)
		}
	}

	private func recheckHIDDestinationIfDue(pid: Int32, delivery: String) throws {
		guard delivery == "hid", let context = activeRequestContext() else { return }
		if let last = context.lastDestinationCheck, Date().timeIntervalSince(last) < Self.foregroundRecheckInterval { return }
		try confirmHIDDestination(.keyboard, pid: pid)
	}

	private func postMouseMove(to point: CGPoint, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try hidGesture(.pointer(point), pid: pid, delivery: delivery) {
			try checkpoint()
			guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
				throw BridgeFailure(message: "Failed to create mouse move event", code: "input_failed")
			}
			try postEvent(move, pid: pid, delivery: delivery)
		}
	}

	private func mouseButton(_ name: String) -> CGMouseButton {
		switch name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "right":
			return .right
		case "middle", "center":
			return .center
		default:
			return .left
		}
	}

	private func mouseDownType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDown
		case .center:
			return .otherMouseDown
		default:
			return .leftMouseDown
		}
	}

	private func mouseUpType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseUp
		case .center:
			return .otherMouseUp
		default:
			return .leftMouseUp
		}
	}

	private func mouseDraggedType(for button: CGMouseButton) -> CGEventType {
		switch button {
		case .right:
			return .rightMouseDragged
		case .center:
			return .otherMouseDragged
		default:
			return .leftMouseDragged
		}
	}

	private func postMouseClick(at point: CGPoint, pid: Int32, button: CGMouseButton = .left, clickCount: Int = 1, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try hidGesture(.pointer(point), pid: pid, delivery: delivery) {
			try postMouseMove(to: point, pid: pid, delivery: delivery)
			for index in 1...max(1, clickCount) {
				guard let down = CGEvent(mouseEventSource: nil, mouseType: mouseDownType(for: button), mouseCursorPosition: point, mouseButton: button),
					let up = CGEvent(mouseEventSource: nil, mouseType: mouseUpType(for: button), mouseCursorPosition: point, mouseButton: button)
				else {
					throw BridgeFailure(message: "Failed to create mouse click event", code: "input_failed")
				}
				down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
				up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
				try checkpoint()
				try postEvent(down, pid: pid, delivery: delivery)
				usleep(12_000)
				try postReleaseEvent(up, pid: pid, delivery: delivery)
				if index < clickCount {
					usleep(70_000)
				}
			}
		}
	}

	private func postMouseDrag(points: [CGPoint], pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard points.count >= 2, let first = points.first else {
			throw BridgeFailure(message: "Drag requires at least two points", code: "invalid_args")
		}
		try hidGesture(.pointer(first), pid: pid, delivery: delivery) {
			try postMouseDragGesture(points: points, first: first, pid: pid, delivery: delivery)
		}
	}

	private func postMouseDragGesture(points: [CGPoint], first: CGPoint, pid: Int32, delivery: String) throws {
		try postMouseMove(to: first, pid: pid, delivery: delivery)
		guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: first, mouseButton: .left),
			let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: first, mouseButton: .left)
		else {
			throw BridgeFailure(message: "Failed to create mouse button event", code: "input_failed")
		}
		let moves = try points.dropFirst().map { point -> (point: CGPoint, event: CGEvent) in
			guard let drag = CGEvent(mouseEventSource: nil, mouseType: mouseDraggedType(for: .left), mouseCursorPosition: point, mouseButton: .left) else {
				throw BridgeFailure(message: "Failed to create mouse drag event", code: "input_failed")
			}
			return (point, drag)
		}
		try checkpoint()
		try postEvent(down, pid: pid, delivery: delivery)

		let context = activeRequestContext()
		var current = first
		var interrupted = false
		func releaseButton() throws {
			up.location = current
			try postReleaseEvent(up, pid: pid, delivery: delivery)
		}
		usleep(12_000)
		for move in moves {
			if context?.stopRequested == true { interrupted = true; break }
			do {
				try postEvent(move.event, pid: pid, delivery: delivery)
			} catch {
				try releaseButton()
				throw error
			}
			current = move.point
			usleep(8_000)
		}
		try releaseButton()
		if interrupted { try checkpoint() }
	}

	private func postScrollWheel(at point: CGPoint, deltaX: Int, deltaY: Int, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		try hidGesture(.pointer(point), pid: pid, delivery: delivery) {
			try postMouseMove(to: point, pid: pid, delivery: delivery)
			guard let event = CGEvent(
				scrollWheelEvent2Source: nil,
				units: .pixel,
				wheelCount: 2,
				wheel1: Int32(-deltaY),
				wheel2: Int32(deltaX),
				wheel3: 0
			) else {
				throw BridgeFailure(message: "Failed to create scroll event", code: "input_failed")
			}
			event.location = point
			try checkpoint()
			try postEvent(event, pid: pid, delivery: delivery)
		}
	}

	private func modifierFlag(_ key: String) -> CGEventFlags? {
		switch key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
		case "cmd", "command", "meta":
			return .maskCommand
		case "ctrl", "control":
			return .maskControl
		case "shift":
			return .maskShift
		case "option", "alt":
			return .maskAlternate
		default:
			return nil
		}
	}

	private func keyCode(_ key: String) -> CGKeyCode? {
		let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let table: [String: CGKeyCode] = [
			"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
			"q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
			"6": 22, "5": 23, "=": 24, "+": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
			"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36,
			"l": 37, "j": 38, "'": 39, "\"": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
			"n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, " ": 49, "`": 50, "~": 50,
			"backspace": 51, "delete": 51, "del": 51, "esc": 53, "escape": 53,
			"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
			"f9": 101, "f10": 109, "f11": 103, "f12": 111,
			"home": 115, "pageup": 116, "page_up": 116, "page down": 121, "pagedown": 121, "page_down": 121,
			"forwarddelete": 117, "forward_delete": 117, "end": 119,
			"left": 123, "arrowleft": 123, "arrow_left": 123,
			"right": 124, "arrowright": 124, "arrow_right": 124,
			"down": 125, "arrowdown": 125, "arrow_down": 125,
			"up": 126, "arrowup": 126, "arrow_up": 126,
		]
		return table[normalized]
	}

	private func keyChord(_ keys: [String]) -> (flags: CGEventFlags, key: String)? {
		guard keys.count >= 2 else { return nil }
		var flags = CGEventFlags()
		for key in keys.dropLast() {
			guard let flag = modifierFlag(key) else {
				return nil
			}
			flags.insert(flag)
		}
		return (flags, keys.last ?? "")
	}

	private func postKeyPress(keys: [String], pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		if let chord = keyChord(keys) {
			try postKey(chord.key, flags: chord.flags, pid: pid, delivery: delivery)
			return
		}

		for key in keys {
			let parts = key
				.split(separator: "+")
				.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
				.filter { !$0.isEmpty }
			if let chord = keyChord(parts) {
				try postKey(chord.key, flags: chord.flags, pid: pid, delivery: delivery)
			} else {
				try postKey(key, flags: [], pid: pid, delivery: delivery)
			}
		}
	}

	private func keyCharacters(_ key: String, flags: CGEventFlags) -> String? {
		if flags.contains(.maskControl) || flags.contains(.maskAlternate) { return nil }
		let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if normalized == "space" || key == " " { return " " }
		guard normalized.count == 1, let scalar = normalized.unicodeScalars.first, scalar.isASCII, scalar.value >= 0x21, scalar.value < 0x7f else { return nil }
		if flags.contains(.maskShift), let shifted = Self.shiftedCharacters[normalized] { return shifted }
		return normalized
	}

	private static let shiftedCharacters: [String: String] = {
		var table: [String: String] = [
			"1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
			"-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
		]
		for scalar in UnicodeScalar("a").value...UnicodeScalar("z").value {
			if let letter = UnicodeScalar(scalar) { table[String(letter)] = String(letter).uppercased() }
		}
		return table
	}()

	private func postKey(_ key: String, flags: CGEventFlags, pid: Int32, delivery: String = "hid", characters: String? = nil) throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let code = keyCode(key) else {
			if key.count == 1 {
				try postUnicodeText(key, pid: pid, delivery: delivery)
				return
			}
			throw BridgeFailure(message: "Unsupported key '\(key)'", code: "invalid_args")
		}
		guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
			let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
		else {
			throw BridgeFailure(message: "Failed to create key event", code: "input_failed")
		}
		down.flags = flags
		up.flags = flags
		if let text = characters ?? keyCharacters(key, flags: flags) {
			setUnicodeString(event: down, text: text)
			setUnicodeString(event: up, text: text)
		}
		try hidGesture(.keyboard, pid: pid, delivery: delivery) {
			try checkpoint()
			try postEvent(down, pid: pid, delivery: delivery)
			try postReleaseEvent(up, pid: pid, delivery: delivery)
			usleep(8_000)
		}
	}

	private func postUnicodeText(_ text: String, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		let context = activeRequestContext()
		let tracksCharacters = delivery == "hid" && context?.hidGestureActive != true && context?.charactersSent != nil
		try hidGesture(.keyboard, pid: pid, delivery: delivery) {
			var sentUnits = 0
			for scalar in text.unicodeScalars {
				try checkpoint()
				try recheckHIDDestinationIfDue(pid: pid, delivery: delivery)
				let char = String(scalar)
				if let stroke = physicalKeyStroke(for: char) {
					try postKey(stroke.key, flags: stroke.flags, pid: pid, delivery: delivery, characters: char)
				} else {
					guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
						let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
					else {
						throw BridgeFailure(message: "Failed to create unicode key event", code: "input_failed")
					}
					setUnicodeString(event: down, text: char)
					setUnicodeString(event: up, text: char)
					down.flags = []
					up.flags = []
					try postEvent(down, pid: pid, delivery: delivery)
					try postReleaseEvent(up, pid: pid, delivery: delivery)
					usleep(8_000)
				}
				sentUnits += char.utf16.count
				if tracksCharacters { context?.charactersSent = sentUnits }
			}
		}
	}

	private func postAtomicUnicodeText(_ text: String, pid: Int32, delivery: String = "hid") throws {
		if delivery == "hid" { physicalInputLock.lock() }
		defer { if delivery == "hid" { physicalInputLock.unlock() } }
		guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
			let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
		else { throw BridgeFailure(message: "Failed to create unicode text event", code: "input_failed") }
		setUnicodeString(event: down, text: text)
		setUnicodeString(event: up, text: text)
		down.flags = []
		up.flags = []
		try hidGesture(.keyboard, pid: pid, delivery: delivery) {
			try checkpoint()
			try postEvent(down, pid: pid, delivery: delivery)
			usleep(8_000)
			try postReleaseEvent(up, pid: pid, delivery: delivery)
		}
	}

	private func physicalKeyStroke(for character: String) -> (key: String, flags: CGEventFlags)? {
		guard character.count == 1 else { return nil }
		if character >= "a" && character <= "z" { return (character, []) }
		if character >= "A" && character <= "Z" { return (character.lowercased(), [.maskShift]) }
		if character >= "0" && character <= "9" { return (character, []) }
		switch character {
		case " ": return ("space", [])
		case ".", ",", "/", "-", "=", ";", "'", "[", "]", "\\", "`": return (character, [])
		case "_": return ("-", [.maskShift])
		case "+": return ("=", [.maskShift])
		case ":": return (";", [.maskShift])
		case "\"": return ("'", [.maskShift])
		case "?": return ("/", [.maskShift])
		case "<": return (",", [.maskShift])
		case ">": return (".", [.maskShift])
		default: return nil
		}
	}

	private func setUnicodeString(event: CGEvent, text: String) {
		var utf16 = Array(text.utf16)
		utf16.withUnsafeMutableBufferPointer { buffer in
			guard let base = buffer.baseAddress else { return }
			event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
		}
	}

}

@main
struct PiComputerUseHelper {
	static func main() {
		_ = NSApplication.shared
		NSApp.setActivationPolicy(CommandLine.arguments.contains("serve") ? .accessory : .prohibited)
		Bridge().run()
	}
}

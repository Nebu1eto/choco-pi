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

final class Box<T> {
	var value: T
	init(_ value: T) {
		self.value = value
	}
}

func rectPayload(_ rect: CGRect) -> [String: Any] {
	["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height]
}

final class Bridge {
	let protocolVersion = 8
	let startedAt = Date().timeIntervalSince1970
	let refStore = AXRefStore()
	let inputSuppressionGuard = InputSuppressionGuard()
	let physicalInputLock = NSRecursiveLock()
	let supportsAgentCursor = CommandLine.arguments.contains("serve")
	let browserBundleIds: Set<String> = [
		"com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "net.imput.helium", "org.mozilla.firefox",
	]
	var enhancedAccessibilityPids = Set<Int32>()
	let enhancedAccessibilityLock = NSLock()
	private var stdinBuffer = Data()
	private var output = FileHandle.standardOutput
	var nextLookId: UInt64 = 0
	var lookRecords: [String: LookRecord] = [:]
	var lookRecordOrder: [String] = []
	let lookRecordLock = NSLock()
	struct LookRetention {
		var generation: Int
		var lastUsed: Double
		var clientPid: Int32?
	}
	var lookRetention: [String: LookRetention] = [:]
	var lastLookRetentionSweep: Double = 0
	let looksPerSession = 8
	let maxLookSessions = 64
	let lookRetentionWithoutClient: TimeInterval = 3600
	let lookRetentionSweepInterval: TimeInterval = 5
	var caretMemory: [(element: AXUIElement, range: CFRange)] = []
	let caretLock = NSLock()
	let rootObserverLock = NSLock()
	var rootObservers: [Int32: RootAXObserverState] = [:]
	let maxRootObservers = 4
	let permissionCacheLock = NSLock()
	var grantedPermissionStatus: [String: Any]?
	let completedRequestLock = NSLock()
	var recentCompletedRequestIds: [String] = []
	let requestRegistryLock = NSLock()
	var activeRequests: [String: RequestContext] = [:]
	var completedSemanticRequests: [(id: String, sessionId: String?)] = []
	var cancelTombstones: [CancelTombstone] = []
	let tombstoneTTL: TimeInterval = 60
	let tombstoneLimit = 256
	static let requestContextKey = "pi.computer-use.request-context"
	let ownerLock = NSLock()
	var sessions: [String: (generation: Int, lastSeen: Double, active: Int)] = [:]
	var sessionlessActiveRequests = 0
	let ownerTTL: TimeInterval = 30
	let ownerGatedCommands: Set<String> = ["act", "actBatch", "focusWindow", "setWindowFrame", "beginInputSuppression", "endInputSuppression", "restoreUserFocus", "foregroundSection"]
	let coordination = NSCondition()
	var targetHolders: [Int32: String] = [:]
	var foregroundSection: ForegroundSectionState?
	let coordinationWaitLimit: TimeInterval = 10
	let foregroundSectionIdleTTL: TimeInterval = 10
	let sectionRestoreHoldWait: TimeInterval = 2
	let sectionRestoreVerifyBound: TimeInterval = 1.5
	var sectionExpiryGeneration: UInt64 = 0
	var sessionExpiryGeneration: UInt64 = 0
	var pendingSectionAcquires: Set<String> = []
	var cancelledSectionAcquires: [String: Double] = [:]
	let extendedActivationLock = NSLock()
	var extendedActivations: [Int32: (count: Int, target: ExtendedDeliveryTarget)] = [:]
	var extendedShuttingDown = false
	var terminationSources: [DispatchSourceSignal] = []
	let offSpaceLock = NSLock()
	var offSpaceWindows: [UInt32: (pid: Int32, element: AXUIElement)] = [:]

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
		Thread.current.threadDictionary[requestClientSocketKey] = client
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

	let axScrollDownAction = "AXScrollDown" as CFString
	let axScrollUpAction = "AXScrollUp" as CFString
	let axScrollLeftAction = "AXScrollLeft" as CFString
	let axScrollRightAction = "AXScrollRight" as CFString
}

@main
struct PiComputerUseHelper {
	static func main() {
		_ = NSApplication.shared
		NSApp.setActivationPolicy(CommandLine.arguments.contains("serve") ? .accessory : .prohibited)
		Bridge().run()
	}
}

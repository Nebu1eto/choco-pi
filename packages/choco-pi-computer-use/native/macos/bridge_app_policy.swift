import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

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

extension Bridge {
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

	func enforceAppPolicy(owner pid: Int32, request: [String: Any], act: Bool = false) throws {
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

	func enforceWindowOwners(pid: Int32?, windowId: UInt32?, windowRef: String?, request: [String: Any], act: Bool = false) throws {
		var owners: [Int32] = []
		if let pid { owners.append(pid) }
		if let windowId, windowId != 0, let owner = pidForWindowId(windowId) { owners.append(owner) }
		if let windowRef, let stored = refStore.window(for: windowRef), let owner = pidForElement(stored) { owners.append(owner) }
		var seen = Set<Int32>()
		for owner in owners where seen.insert(owner).inserted {
			try enforceAppPolicy(owner: owner, request: request, act: act)
		}
	}

	func requireForegroundGrant(_ request: [String: Any], _ operation: String) throws {
		guard (request["foregroundGrant"] as? Bool) == true else {
			throw BridgeFailure(message: "\(operation) activates or raises a window and requires a host foreground grant", code: "foreground_required", effectPossible: false)
		}
	}

}

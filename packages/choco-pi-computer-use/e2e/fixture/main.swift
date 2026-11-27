import AppKit
import Foundation
import SwiftUI
import WebKit

let targetBundleId = "com.choco-pi.FocusFixture"
let holderBundleId = "com.choco-pi.FocusHolder"
let bundleId = Bundle.main.bundleIdentifier ?? ""
let isHolder = bundleId == holderBundleId
let role = isHolder ? "holder" : "target"
let windowTitle = isHolder ? "CU Focus Holder" : "CU Fixture Target"

// Opt-in options (safety harness). Unset variables keep the tier-B behavior unchanged.
let env = ProcessInfo.processInfo.environment
func flag(_ name: String) -> Bool { env[name] == "1" }
func numbers(_ name: String) -> [Double]? {
	guard let raw = env[name], !raw.isEmpty else { return nil }
	let parts = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
	return parts.isEmpty ? nil : parts
}
let instance: String? = env["CU_FIXTURE_INSTANCE"].flatMap { $0.isEmpty ? nil : $0 }
let triggerName = instance ?? role
let windowCount = max(1, min(2, Int(env["CU_FIXTURE_WINDOWS"] ?? "") ?? 1))
let keyWindowIndex = max(1, min(windowCount, Int(env["CU_FIXTURE_KEY_WINDOW"] ?? "") ?? 1))
let sameTitle = flag("CU_FIXTURE_SAME_TITLE")
let sticky = isHolder && flag("CU_FIXTURE_STICKY")
let noise = !isHolder && flag("CU_FIXTURE_NOISE")
let deadViewEnabled = !isHolder && flag("CU_FIXTURE_DEAD_VIEW")
let webEnabled = !isHolder && flag("CU_FIXTURE_WEB")
let activateAtLaunch = !isHolder && flag("CU_FIXTURE_ACTIVATE")
// Matrix mode (safety/matrix.ts): extra AppKit and SwiftUI windows, the web page loaded from
let matrixEnabled = !isHolder && flag("CU_FIXTURE_MATRIX")
// Parallel mode (safety/parallel.ts): a scroll view and a drag view in the main window and, with
let parallelEnabled = !isHolder && flag("CU_FIXTURE_PARALLEL")
// Cursor check (safety/cursors.ts): CU_FIXTURE_INPUT_LOG=1 logs every pointer event the target receives
let inputLogEnabled = !isHolder && flag("CU_FIXTURE_INPUT_LOG")
let pointerSamplerEnabled = flag("CU_FIXTURE_POINTER_SAMPLER")
let unpairedWindowEnabled = !isHolder && flag("CU_FIXTURE_UNPAIRED_WINDOW")
// A chain of nested shells of this depth under the target (safety ancestry check), or nil.
let chainDepth: Int? = isHolder ? nil : env["CU_FIXTURE_SPAWN_CHAIN"].flatMap { Int($0) }.map { max(1, min(200, $0)) }
let webPagePath: String? = env["CU_FIXTURE_WEB_PAGE"].flatMap { $0.isEmpty ? nil : $0 }
let windowOffset: NSPoint = {
	guard let parts = numbers("CU_FIXTURE_OFFSET"), parts.count == 2 else { return .zero }
	return NSPoint(x: parts[0], y: parts[1])
}()
// Display placement (safety/displays.ts): CU_FIXTURE_ORIGIN=x,y in global top-left points translates every
let layoutOrigin: NSPoint? = {
	guard let parts = numbers("CU_FIXTURE_ORIGIN"), parts.count == 2 else { return nil }
	return NSPoint(x: parts[0], y: parts[1])
}()
let layoutEnabled = layoutOrigin != nil
let screensOnly = flag("CU_FIXTURE_SCREENS_ONLY")
let windowShift = NSPoint(x: windowOffset.x + (layoutOrigin?.x ?? 0), y: windowOffset.y - (layoutOrigin?.y ?? 0))

// Off-Space placement (safety/offspace.ts): CU_FIXTURE_SPACE=auto|<space id> puts this fixture's own
let spaceRequest: String? = isHolder ? nil : env["CU_FIXTURE_SPACE"].flatMap { $0.isEmpty ? nil : $0 }
// where they open (safety/coordination.ts: the web window visible, the main window never shown). Default: all.
let spaceWindowLabels: Set<String>? = env["CU_FIXTURE_SPACE_WINDOWS"].flatMap { raw in
	let labels = Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
	return labels.isEmpty ? nil : labels
}
typealias CGSConnectionFn = @convention(c) () -> Int32
typealias CGSCopyDisplaySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?
typealias CGSMoveWindowsFn = @convention(c) (Int32, CFArray, Int) -> Void
typealias CGSSpacesForWindowsFn = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
func cgsSymbol(_ name: String) -> UnsafeMutableRawPointer? { dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) }
func cgsConnection() -> Int32? {
	guard let symbol = cgsSymbol("CGSMainConnectionID") else { return nil }
	return unsafeBitCast(symbol, to: CGSConnectionFn.self)()
}
func managedDisplaySpaces() -> [[String: Any]] {
	guard let cid = cgsConnection(), let symbol = cgsSymbol("CGSCopyManagedDisplaySpaces") else { return [] }
	return (unsafeBitCast(symbol, to: CGSCopyDisplaySpacesFn.self)(cid)?.takeRetainedValue() as? [[String: Any]]) ?? []
}
func spacesOf(windowNumber: Int) -> [Int] {
	guard let cid = cgsConnection(), let symbol = cgsSymbol("CGSCopySpacesForWindows") else { return [] }
	return (unsafeBitCast(symbol, to: CGSSpacesForWindowsFn.self)(cid, 7, [NSNumber(value: windowNumber)] as CFArray)?.takeRetainedValue() as? [Int]) ?? []
}
func displayIdentifier(of window: NSWindow) -> String? {
	let screen = window.screen ?? NSScreen.screens.first { $0.frame.intersects(window.frame) }
	guard let number = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value,
		let uuid = CGDisplayCreateUUIDFromDisplayID(number)?.takeRetainedValue()
	else { return nil }
	return CFUUIDCreateString(nil, uuid) as String?
}
func displaySpacesPayload() -> [[String: Any]] {
	managedDisplaySpaces().map { display in
		let spaces = (display["Spaces"] as? [[String: Any]]) ?? []
		return [
			"display": display["Display Identifier"] as? String ?? "",
			"current": (display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int ?? -1,
			"desktopSpaces": spaces.compactMap { ($0["type"] as? Int) == 0 ? $0["ManagedSpaceID"] as? Int : nil },
		]
	}
}
func offSpaceTarget(_ request: String, window: NSWindow) -> Int? {
	if let id = Int(request) { return id }
	guard request == "auto" else { return nil }
	let identifier = displayIdentifier(of: window)
	for display in managedDisplaySpaces() {
		let name = display["Display Identifier"] as? String ?? ""
		guard name == "Main" || identifier == nil || name.caseInsensitiveCompare(identifier ?? "") == .orderedSame else { continue }
		let current = (display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int
		for space in (display["Spaces"] as? [[String: Any]]) ?? [] {
			if let id = space["ManagedSpaceID"] as? Int, (space["type"] as? Int) == 0, id != current { return id }
		}
	}
	return nil
}
func moveWindows(_ numbers: [Int], to space: Int) -> Bool {
	guard let cid = cgsConnection(), let symbol = cgsSymbol("CGSMoveWindowsToManagedSpace") else { return false }
	unsafeBitCast(symbol, to: CGSMoveWindowsFn.self)(cid, numbers as CFArray, space)
	return true
}

final class EventLog {
	private let handle: FileHandle?
	let directory: URL?

	init(path: String?) {
		guard let path, !path.isEmpty else {
			handle = nil
			directory = nil
			return
		}
		let url = URL(fileURLWithPath: path)
		directory = url.deletingLastPathComponent()
		if !FileManager.default.fileExists(atPath: path) {
			FileManager.default.createFile(atPath: path, contents: nil)
		}
		handle = FileHandle(forWritingAtPath: path)
		handle?.seekToEndOfFile()
	}

	func write(_ event: String, _ fields: [String: Any] = [:]) {
		var row = fields
		row["ts"] = (Date().timeIntervalSince1970 * 1000).rounded()
		row["app"] = role
		row["pid"] = Int(ProcessInfo.processInfo.processIdentifier)
		row["event"] = event
		if let instance { row["instance"] = instance }
		guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
		handle?.write(data)
		handle?.write(Data("\n".utf8))
	}
}

let log = EventLog(path: ProcessInfo.processInfo.environment["CU_FIXTURE_LOG"])

func describe(_ value: String) -> [String: Any] {
	var out: [String: Any] = ["length": value.count]
	if value.count <= 64 { out["value"] = value } else { out["tail"] = String(value.suffix(16)) }
	return out
}

func frameFields(_ frame: NSRect) -> [String: Any] {
	["x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height]
}

func cocoaRect(fromTopLeft rect: NSRect) -> NSRect {
	let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
	return NSRect(x: rect.origin.x, y: primaryHeight - rect.origin.y - rect.size.height, width: rect.size.width, height: rect.size.height)
}

func topLeftRect(fromCocoa rect: NSRect) -> NSRect {
	let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
	return NSRect(x: rect.origin.x, y: primaryHeight - rect.origin.y - rect.size.height, width: rect.size.width, height: rect.size.height)
}

func globalPoint(_ event: NSEvent) -> [String: Any]? {
	guard layoutEnabled, let window = event.window else { return nil }
	let screen = window.convertPoint(toScreen: event.locationInWindow)
	let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
	return ["x": screen.x, "y": primaryHeight - screen.y]
}

func screensPayload() -> [[String: Any]] {
	NSScreen.screens.enumerated().map { index, screen in
		let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
		return [
			"id": Int(id),
			"name": screen.localizedName,
			"primary": index == 0,
			"main": screen == NSScreen.main,
			"frame": frameFields(screen.frame),
			"bounds": frameFields(CGDisplayBounds(id)),
			"topLeftFrame": frameFields(topLeftRect(fromCocoa: screen.frame)),
			"backingScale": Double(screen.backingScaleFactor),
		]
	}
}

func ownerWindows(pid: Int32) -> [[String: Any]] {
	guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
	return list.compactMap { info in
		guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { return nil }
		var bounds = CGRect.zero
		if let raw = info[kCGWindowBounds as String] as? NSDictionary, let parsed = CGRect(dictionaryRepresentation: raw) { bounds = parsed }
		return [
			"number": (info[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0,
			"bounds": frameFields(bounds),
			"layer": (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
			"onscreen": (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
			"alpha": (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
		]
	}
}

func matrixOrigin(left: Double, top: Double, width: Double, height: Double) -> NSPoint {
	cocoaRect(fromTopLeft: NSRect(x: left, y: top, width: width, height: height)).origin
}

let webPage = """
<!doctype html><html><head><title>CU Fixture Web</title></head><body style="font: 15px -apple-system; margin: 24px">
<label for="web-field">Web Field</label><br>
<input id="web-field" type="text" aria-label="Web Field" style="width: 320px; font-size: 16px">
<script>
const field = document.getElementById("web-field");
field.addEventListener("input", () => window.webkit.messageHandlers.cu.postMessage(field.value));
</script></body></html>
"""

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
app.delegate = fixture
app.run()

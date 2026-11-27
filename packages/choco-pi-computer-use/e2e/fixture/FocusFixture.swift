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

final class CustomView: NSView {
	var hits = 0
	var onHit: ((Int, [String: Any]?) -> Void)?

	override var acceptsFirstResponder: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	override func isAccessibilityElement() -> Bool { true }
	override func accessibilityRole() -> NSAccessibility.Role? { .group }
	override func accessibilityLabel() -> String? { "Custom View" }
	override func accessibilityIdentifier() -> String { "cu-custom-view" }
	override func isAccessibilityEnabled() -> Bool { true }

	override func draw(_ dirtyRect: NSRect) {
		NSColor.systemTeal.withAlphaComponent(0.35).setFill()
		bounds.fill()
		let text = "Custom View (\(hits))" as NSString
		text.draw(at: NSPoint(x: 12, y: bounds.midY - 8), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
	}

	override func mouseDown(with event: NSEvent) {
		hits += 1
		needsDisplay = true
		onHit?(hits, globalPoint(event))
	}
}

final class DeadView: NSView {
	override var acceptsFirstResponder: Bool { false }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	override func isAccessibilityElement() -> Bool { true }
	override func accessibilityRole() -> NSAccessibility.Role? { .group }
	override func accessibilityLabel() -> String? { "Dead View" }
	override func accessibilityIdentifier() -> String { "cu-dead-view" }
	override func isAccessibilityEnabled() -> Bool { true }

	override func draw(_ dirtyRect: NSRect) {
		NSColor.systemGray.withAlphaComponent(0.35).setFill()
		bounds.fill()
		("Dead View" as NSString).draw(at: NSPoint(x: 12, y: bounds.midY - 8), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
	}

	override func mouseDown(with event: NSEvent) {}
	override func mouseUp(with event: NSEvent) {}
	override func rightMouseDown(with event: NSEvent) {}
}

final class DragView: NSView {
	var start: NSPoint?
	var moves = 0

	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	override func isAccessibilityElement() -> Bool { true }
	override func accessibilityRole() -> NSAccessibility.Role? { .group }
	override func accessibilityLabel() -> String? { "Drag View" }
	override func accessibilityIdentifier() -> String { "cu-drag" }
	override func isAccessibilityEnabled() -> Bool { true }

	func region(_ point: NSPoint) -> String {
		if point.x < bounds.width / 3 { return "A" }
		if point.x > bounds.width * 2 / 3 { return "B" }
		return "mid"
	}

	override func draw(_ dirtyRect: NSRect) {
		NSColor.systemPurple.withAlphaComponent(0.25).setFill()
		bounds.fill()
		let font: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 14)]
		("A" as NSString).draw(at: NSPoint(x: 12, y: bounds.midY - 8), withAttributes: font)
		("B" as NSString).draw(at: NSPoint(x: bounds.width - 24, y: bounds.midY - 8), withAttributes: font)
	}

	override func mouseDown(with event: NSEvent) {
		let point = convert(event.locationInWindow, from: nil)
		start = point
		moves = 0
		var fields: [String: Any] = ["region": region(point)]
		if let at = globalPoint(event) { fields["at"] = at }
		log.write("dragDown", fields)
	}

	override func mouseDragged(with event: NSEvent) { moves += 1 }

	override func mouseUp(with event: NSEvent) {
		let point = convert(event.locationInWindow, from: nil)
		var fields: [String: Any] = ["startRegion": start.map(region) ?? "none", "endRegion": region(point), "moves": moves]
		if let at = globalPoint(event) { fields["at"] = at }
		log.write("dragUp", fields)
		start = nil
	}
}

final class StripeView: NSView {
	override var isFlipped: Bool { true }

	override func draw(_ dirtyRect: NSRect) {
		for index in 0..<30 {
			let rect = NSRect(x: 0, y: CGFloat(index) * 40, width: bounds.width, height: 40)
			(index % 2 == 0 ? NSColor.systemYellow.withAlphaComponent(0.3) : NSColor.white).setFill()
			rect.fill()
			("Row \(index)" as NSString).draw(at: NSPoint(x: 8, y: rect.minY + 12), withAttributes: [.font: NSFont.systemFont(ofSize: 12)])
		}
	}
}

final class SwiftUIModel: ObservableObject {
	@Published var text = ""
	@Published var toggle = false
}

struct MatrixSwiftUIView: View {
	@ObservedObject var model: SwiftUIModel

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			Button("SwiftUI Button") { log.write("swiftuiButton") }
				.accessibilityIdentifier("cu-sw-button")
			TextField("SwiftUI Field", text: $model.text)
				.frame(width: 300)
				.accessibilityIdentifier("cu-sw-field")
			Toggle("SwiftUI Toggle", isOn: $model.toggle)
				.accessibilityIdentifier("cu-sw-toggle")
			ZStack {
				Rectangle().fill(Color.orange.opacity(0.35))
				Text("Tap Area")
			}
			.frame(width: 300, height: 90)
			.contentShape(Rectangle())
			.onTapGesture { log.write("swiftuiTap") }
			.accessibilityElement(children: .ignore)
			.accessibilityLabel("SwiftUI Tap Area")
			.accessibilityIdentifier("cu-sw-tap")
		}
		.padding(20)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.onChange(of: model.text) { value in log.write("swiftuiText", describe(value)) }
		.onChange(of: model.toggle) { value in log.write("swiftuiToggle", ["isOn": value]) }
	}
}

final class UnpairedWindow: NSWindow {
	override func accessibilityRole() -> NSAccessibility.Role? { .group }
	override func accessibilityTitle() -> String? { "AX Alias" }
	override func accessibilityFrame() -> NSRect { frame.offsetBy(dx: 6000, dy: 6000) }
}

final class WebLogger: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		if let fields = message.body as? [String: Any], let event = fields["event"] as? String {
			var row = fields
			row.removeValue(forKey: "event")
			if let value = fields["value"] as? String {
				row.removeValue(forKey: "value")
				row.merge(describe(value)) { _, new in new }
			}
			log.write(event, row)
			return
		}
		log.write("webValue", describe(message.body as? String ?? ""))
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		log.write("webReady")
	}
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

final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate, NSMenuDelegate {
	var window: NSWindow!
	var windows: [NSWindow] = []
	var labels: [ObjectIdentifier: String] = [:]
	var requestedFrames: [ObjectIdentifier: NSRect] = [:]
	let field = NSTextField(string: "")
	let counterLabel = NSTextField(labelWithString: "Count: 0")
	let customView = CustomView(frame: NSRect(x: 20, y: 40, width: 280, height: 120))
	let deadView = DeadView(frame: NSRect(x: 330, y: 40, width: 280, height: 120))
	let noiseView = NSView(frame: NSRect(x: 460, y: 380, width: 160, height: 60))
	let webLogger = WebLogger()
	var webView: WKWebView?
	var increments = 0
	var lastValue = ""
	var quitting = false
	var signalSources: [DispatchSourceSignal] = []
	var pollTimer: Timer?
	var noiseTimer: Timer?
	var pointerTimer: Timer?
	var lastPointer: CGPoint?
	var warpOnUp: CGPoint?
	var incrementButton: NSButton?
	var noiseTicks = 0
	var stickyStreak = false
	let scrollView = NSScrollView(frame: NSRect(x: 20, y: 140, width: 220, height: 180))
	let dragView = DragView(frame: NSRect(x: 260, y: 140, width: 240, height: 180))
	let popup = NSPopUpButton(frame: NSRect(x: 20, y: 90, width: 180, height: 28), pullsDown: false)
	var checkbox: NSButton?
	let swiftModel = SwiftUIModel()
	var lastScrollY: Double?
	let field2 = NSTextField(string: "")
	var lastValue2 = ""
	var lastResponder: [String: String] = [:]
	var lastSelection: [String: String] = [:]
	var unpairedWindow: NSWindow?
	var chainProcess: Process?

	func label(_ window: NSWindow?) -> String {
		guard let window else { return "" }
		return labels[ObjectIdentifier(window)] ?? "unknown"
	}

	func windowFields(_ window: NSWindow?) -> [String: Any] {
		guard let window else { return ["window": ""] }
		return ["window": label(window), "windowNumber": window.windowNumber, "title": window.title]
	}

	func place(_ window: NSWindow, contentRect: NSRect) {
		let frame = window.frameRect(forContentRect: contentRect)
		window.setFrame(frame, display: false)
		requestedFrames[ObjectIdentifier(window)] = frame
	}

	func makeWindow(_ title: String, _ label: String, origin: NSPoint, size: NSSize) -> NSWindow {
		let contentRect = NSRect(origin: NSPoint(x: origin.x + windowShift.x, y: origin.y + windowShift.y), size: size)
		let made = NSWindow(contentRect: contentRect, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
		place(made, contentRect: contentRect)
		made.title = title
		made.isReleasedWhenClosed = false
		made.isRestorable = false
		made.delegate = self
		made.contentView = NSView(frame: NSRect(origin: .zero, size: size))
		labels[ObjectIdentifier(made)] = label
		windows.append(made)
		return made
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		if screensOnly {
			log.write("screens", ["screens": screensPayload()])
			log.write("launched", ["bundleId": bundleId, "screensOnly": true])
			exit(0)
		}
		let origin = isHolder ? NSPoint(x: 60, y: 520) : NSPoint(x: 560, y: 160)
		let size = isHolder ? NSSize(width: 420, height: 160) : NSSize(width: 640, height: 480)
		window = makeWindow(windowTitle, "main", origin: origin, size: size)
		guard let content = window.contentView else { return }
		buildControls(content, size: size)
		buildExtraWindows()
		buildOptionalExtras()
		installObservers()
		finishLaunch()
	}

	func buildOptionalExtras() {
		if unpairedWindowEnabled {
			let contentRect = NSRect(x: 560 + windowShift.x, y: 40 + windowShift.y, width: 200, height: 80)
			let hidden = UnpairedWindow(contentRect: contentRect, styleMask: [.titled], backing: .buffered, defer: false)
			place(hidden, contentRect: contentRect)
			hidden.title = "CU Unpaired Window"
			hidden.isReleasedWhenClosed = false
			hidden.isRestorable = false
			hidden.orderFrontRegardless()
			unpairedWindow = hidden
			log.write("unpairedWindow", ["windowNumber": hidden.windowNumber, "frame": frameFields(hidden.frame)])
		}
		if let chainDepth, let directory = log.directory {
			let script = directory.appendingPathComponent("chain.sh")
			let leaf = directory.appendingPathComponent("chain-leaf.pid")
			let body = "#!/bin/sh\nif [ \"$1\" -gt 0 ]; then /bin/sh \"$0\" $(($1 - 1)) \"$2\"; status=$?; exit $status; fi\necho $$ > \"$2.tmp\" && mv \"$2.tmp\" \"$2\"\nexec /bin/sleep 120\n"
			do {
				try body.write(to: script, atomically: true, encoding: .utf8)
				let process = Process()
				process.executableURL = URL(fileURLWithPath: "/bin/sh")
				process.arguments = [script.path, String(chainDepth), leaf.path]
				try process.run()
				chainProcess = process
				log.write("chainSpawned", ["depth": chainDepth, "rootPid": Int(process.processIdentifier)])
			} catch {
				log.write("chainFailed", ["message": error.localizedDescription])
			}
		}
	}

	func buildControls(_ content: NSView, size: NSSize) {
		field.frame = NSRect(x: 20, y: size.height - 60, width: min(360, size.width - 40), height: 24)
		field.setAccessibilityLabel("Field")
		field.setAccessibilityIdentifier("cu-field")
		field.placeholderString = "Field"
		field.delegate = self
		content.addSubview(field)

		if !isHolder {
			let button = NSButton(title: "Increment", target: self, action: #selector(increment))
			button.frame = NSRect(x: 20, y: size.height - 110, width: 120, height: 30)
			button.setAccessibilityIdentifier("cu-increment")
			incrementButton = button
			content.addSubview(button)
			counterLabel.frame = NSRect(x: 160, y: size.height - 105, width: 200, height: 20)
			counterLabel.setAccessibilityIdentifier("cu-count")
			content.addSubview(counterLabel)
			customView.onHit = { hits, at in
				var fields: [String: Any] = ["count": hits]
				if let at { fields["at"] = at }
				log.write("customHit", fields)
			}
			content.addSubview(customView)
			if deadViewEnabled { content.addSubview(deadView) }
			if parallelEnabled && !matrixEnabled { buildParallelControls(content) }
			if noise {
				noiseView.wantsLayer = true
				noiseView.layer?.backgroundColor = NSColor.systemRed.cgColor
				content.addSubview(noiseView)
			}
		}
	}

	func buildExtraWindows() {
		if windowCount >= 2 {
			let secondTitle = sameTitle ? windowTitle : "\(windowTitle) 2"
			let secondOrigin = isHolder ? NSPoint(x: 60, y: 320) : NSPoint(x: 1220, y: 160)
			let second = makeWindow(secondTitle, "second", origin: secondOrigin, size: NSSize(width: 420, height: 160))
			let note = NSTextField(labelWithString: "Second window")
			note.frame = NSRect(x: 20, y: 100, width: 300, height: 20)
			second.contentView?.addSubview(note)
			if parallelEnabled {
				field2.frame = NSRect(x: 20, y: 40, width: 360, height: 24)
				field2.setAccessibilityLabel("Field 2")
				field2.setAccessibilityIdentifier("cu-field-2")
				field2.placeholderString = "Field 2"
				field2.delegate = self
				second.contentView?.addSubview(field2)
			}
		}

		if webEnabled {
			let webSize = matrixEnabled ? NSSize(width: 640, height: 340) : NSSize(width: 420, height: 200)
			let webOrigin = matrixEnabled ? matrixOrigin(left: 560, top: 80, width: 640, height: 340) : NSPoint(x: 560, y: 660)
			let web = makeWindow("CU Fixture Web", "web", origin: webOrigin, size: webSize)
			let config = WKWebViewConfiguration()
			config.userContentController.add(webLogger, name: "cu")
			let view = WKWebView(frame: NSRect(origin: .zero, size: webSize), configuration: config)
			view.navigationDelegate = webLogger
			web.contentView?.addSubview(view)
			let page = webPagePath.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? webPage
			view.loadHTMLString(page, baseURL: nil)
			webView = view
		}
		if matrixEnabled { buildMatrixWindows() }
	}

	func buildMatrixWindows() {
		let size = NSSize(width: 520, height: 340)
		let appkit = makeWindow("CU Matrix AppKit", "appkit", origin: matrixOrigin(left: 20, top: 80, width: 520, height: 340), size: size)
		if let content = appkit.contentView {
			scrollView.hasVerticalScroller = true
			scrollView.documentView = StripeView(frame: NSRect(x: 0, y: 0, width: 200, height: 1200))
			scrollView.setAccessibilityIdentifier("cu-scroll")
			scrollView.contentView.postsBoundsChangedNotifications = true
			NotificationCenter.default.addObserver(
				forName: NSView.boundsDidChangeNotification, object: scrollView.contentView, queue: .main
			) { [weak self] _ in self?.logScroll() }
			content.addSubview(scrollView)
			content.addSubview(dragView)
			popup.addItems(withTitles: ["One", "Two", "Three"])
			popup.target = self
			popup.action = #selector(popupChanged)
			popup.setAccessibilityIdentifier("cu-popup")
			popup.menu?.delegate = self
			content.addSubview(popup)
			let box = NSButton(checkboxWithTitle: "Check Me", target: self, action: #selector(checkboxChanged))
			box.frame = NSRect(x: 220, y: 92, width: 160, height: 24)
			box.setAccessibilityIdentifier("cu-checkbox")
			content.addSubview(box)
			checkbox = box
			scrollToMiddle()
		}
		let swiftLeft = flag("CU_FIXTURE_MATRIX_OVERLAP") ? 100.0 : 1220.0
		let swiftui = makeWindow("CU Matrix SwiftUI", "swiftui", origin: matrixOrigin(left: swiftLeft, top: 80, width: 480, height: 340), size: NSSize(width: 480, height: 340))
		let hosting = NSHostingView(rootView: MatrixSwiftUIView(model: swiftModel))
		hosting.frame = NSRect(x: 0, y: 0, width: 480, height: 340)
		hosting.autoresizingMask = [.width, .height]
		swiftui.contentView?.addSubview(hosting)
	}

	func scrollToMiddle() {
		scrollView.contentView.scroll(to: NSPoint(x: 0, y: 500))
		scrollView.reflectScrolledClipView(scrollView.contentView)
	}

	func buildParallelControls(_ content: NSView) {
		scrollView.frame = NSRect(x: 20, y: 180, width: 220, height: 170)
		scrollView.hasVerticalScroller = true
		scrollView.documentView = StripeView(frame: NSRect(x: 0, y: 0, width: 200, height: 1200))
		scrollView.setAccessibilityIdentifier("cu-scroll")
		scrollView.contentView.postsBoundsChangedNotifications = true
		NotificationCenter.default.addObserver(
			forName: NSView.boundsDidChangeNotification, object: scrollView.contentView, queue: .main
		) { [weak self] _ in self?.logScroll() }
		content.addSubview(scrollView)
		dragView.frame = NSRect(x: 260, y: 180, width: 360, height: 170)
		content.addSubview(dragView)
		scrollToMiddle()
	}

	func logScroll() {
		let position = Double(scrollView.contentView.bounds.origin.y).rounded()
		if position == lastScrollY { return }
		lastScrollY = position
		log.write("scrollPosition", ["y": position])
	}

	@objc func popupChanged() {
		log.write("popupSelected", ["index": popup.indexOfSelectedItem, "title": popup.titleOfSelectedItem ?? ""])
	}

	@objc func checkboxChanged() {
		log.write("checkbox", ["state": checkbox?.state.rawValue ?? -1])
	}

	func menuWillOpen(_ menu: NSMenu) {
		log.write("menuOpened", ["active": NSApp.isActive])
		let timer = Timer(timeInterval: 0.4, repeats: false) { _ in menu.cancelTracking() }
		RunLoop.main.add(timer, forMode: .common)
	}

	func menuDidClose(_ menu: NSMenu) { log.write("menuClosed") }

	func reset(_ body: String) {
		var seq = 0
		var text = ""
		if let data = body.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			seq = (parsed["seq"] as? NSNumber)?.intValue ?? 0
			text = parsed["text"] as? String ?? ""
		}
		popup.menu?.cancelTracking()
		for each in windows { _ = each.makeFirstResponder(nil) }
		field.stringValue = text
		checkbox?.state = .off
		popup.selectItem(at: 0)
		scrollToMiddle()
		swiftModel.text = text
		swiftModel.toggle = false
		let finish = { [weak self] in
			DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
				self?.poll()
				log.write("resetDone", ["seq": seq])
			}
		}
		guard let webView else { return finish() }
		let literal = (try? JSONSerialization.data(withJSONObject: [text])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
		webView.evaluateJavaScript("if (window.cuReset) window.cuReset(\(seq), \(literal)[0]); true") { _, error in
			if let error { log.write("resetWebError", ["message": error.localizedDescription]) }
			finish()
		}
	}

	func pollResponders() {
		for each in windows {
			let key = label(each)
			var kind = "none"
			var owner = ""
			var selection: NSRange?
			var textLength = 0
			if let editor = each.firstResponder as? NSTextView {
				kind = editor.isFieldEditor ? "fieldEditor" : "textView"
				if let control = editor.delegate as? NSView { owner = control.accessibilityIdentifier() }
				selection = editor.selectedRange()
				textLength = (editor.string as NSString).length
			} else if let responder = each.firstResponder, responder !== each {
				kind = String(describing: type(of: responder))
			}
			let signature = "\(kind)|\(owner)"
			if lastResponder[key] != signature {
				lastResponder[key] = signature
				log.write("responder", ["window": key, "kind": kind, "owner": owner])
			}
			guard let selection else {
				lastSelection[key] = nil
				continue
			}
			let selected = "\(selection.location),\(selection.length),\(textLength)"
			if lastSelection[key] != selected {
				lastSelection[key] = selected
				log.write("editorSelection", ["window": key, "owner": owner, "location": selection.location, "length": selection.length, "textLength": textLength])
			}
		}
	}

	func installObservers() {
		let center = NotificationCenter.default
		center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
			log.write("appActive", self?.windowFields(NSApp.keyWindow) ?? [:])
			self?.stickyStreak = false
		}
		center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
			log.write("appInactive")
			if sticky { self?.reactivate("resign") }
		}
		NSWorkspace.shared.notificationCenter.addObserver(
			forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
		) { note in
			let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
			log.write("frontmost", ["bundleId": app?.bundleIdentifier ?? "", "frontPid": Int(app?.processIdentifier ?? 0)])
		}
		if isHolder {
			NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
				var fields = self?.windowFields(event.window ?? NSApp.keyWindow) ?? [:]
				fields["keyCode"] = Int(event.keyCode)
				log.write("keyDown", fields)
				return event
			}
			NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
				var fields = self?.windowFields(event.window) ?? [:]
				fields["button"] = Int(event.buttonNumber)
				let screen = NSEvent.mouseLocation
				fields["screenX"] = screen.x
				fields["screenY"] = screen.y
				log.write("mouseDown", fields)
				return event
			}
		}
		if inputLogEnabled {
			for each in windows { each.acceptsMouseMovedEvents = true }
			NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
				var fields = self?.windowFields(event.window) ?? [:]
				fields["type"] = event.type == .mouseMoved ? "moved" : event.type == .leftMouseDragged ? "dragged" : "up"
				if let at = globalPoint(event) { fields["at"] = at }
				log.write("targetPointer", fields)
				return event
			}
		}
		if matrixEnabled || inputLogEnabled {
			NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
				var fields = self?.windowFields(event.window) ?? [:]
				fields["keyCode"] = Int(event.keyCode)
				fields["flags"] = Int(event.modifierFlags.intersection(.deviceIndependentFlagsMask).rawValue)
				log.write("targetKeyDown", fields)
				return event
			}
			NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
				var fields = self?.windowFields(event.window) ?? [:]
				fields["button"] = Int(event.buttonNumber)
				if let at = globalPoint(event) { fields["at"] = at }
				log.write("targetMouseDown", fields)
				return event
			}
			NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
				var fields = self?.windowFields(event.window) ?? [:]
				fields["deltaY"] = Double(event.scrollingDeltaY)
				if let at = globalPoint(event) { fields["at"] = at }
				log.write("targetScrollWheel", fields)
				return event
			}
		}

		for number in [SIGTERM, SIGUSR1] {
			signal(number, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
			source.setEventHandler { [weak self] in
				if number == SIGTERM { self?.quit("SIGTERM") } else { self?.resize("SIGUSR1") }
			}
			source.resume()
			signalSources.append(source)
		}
	}

	func finishLaunch() {
		pollTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in self?.poll() }
		if pointerSamplerEnabled {
			pointerTimer = Timer.scheduledTimer(withTimeInterval: 0.005, repeats: true) { [weak self] _ in self?.samplePointer() }
			NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] event in
				if let point = self?.warpOnUp {
					self?.warpOnUp = nil
					CGWarpMouseCursorPosition(point)
					CGAssociateMouseAndMouseCursorPosition(1)
					log.write("warped", ["x": point.x, "y": point.y])
				}
				return event
			}
		}
		if noise {
			noiseTimer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in self?.tickNoise() }
			log.write("noiseStarted", ["intervalMs": 30, "periodMs": 1000])
		}
		if let cover = numbers("CU_FIXTURE_COVER"), cover.count == 4 { coverRect(cover, reason: "env") }

		let keyWindow = windows[keyWindowIndex - 1]
		if isHolder || activateAtLaunch {
			for other in windows where other !== keyWindow { other.orderFront(nil) }
			keyWindow.makeKeyAndOrderFront(nil)
			NSApp.activate(ignoringOtherApps: true)
		} else {
			if let spaceRequest {
				for made in windows { made.alphaValue = 0 }
				if let space = offSpaceTarget(spaceRequest, window: keyWindow) { _ = moveWindows(windows.map { $0.windowNumber }, to: space) }
			}
			for other in windows where other !== keyWindow { other.orderFrontRegardless() }
			keyWindow.orderFrontRegardless()
			if let spaceRequest {
				let space = offSpaceTarget(spaceRequest, window: keyWindow)
				let moved = space.map { moveWindows(windows.map { $0.windowNumber }, to: $0) } ?? false
				for made in windows { made.alphaValue = 1 }
				logSpaceMove(request: spaceRequest, space: space, moved: moved)
			}
		}
		for made in windows + [unpairedWindow].compactMap({ $0 }) {
			if let requested = requestedFrames[ObjectIdentifier(made)], made.frame != requested { made.setFrame(requested, display: true) }
		}
		var launched: [String: Any] = ["bundleId": bundleId, "title": windowTitle, "frame": frameFields(window.frame), "active": NSApp.isActive]
		launched["windows"] = windows.map { made -> [String: Any] in
			var row: [String: Any] = ["window": label(made), "windowNumber": made.windowNumber, "title": made.title, "frame": frameFields(made.frame)]
			if let requested = requestedFrames[ObjectIdentifier(made)] { row["requestedFrame"] = frameFields(requested) }
			return row
		}
		if let unpairedWindow, let requested = requestedFrames[ObjectIdentifier(unpairedWindow)] {
			launched["unpairedWindow"] = ["frame": frameFields(unpairedWindow.frame), "requestedFrame": frameFields(requested)]
		}
		launched["screens"] = screensPayload()
		launched["options"] = ["sticky": sticky, "noise": noise, "deadView": deadViewEnabled, "web": webEnabled, "windowCount": windowCount, "keyWindow": keyWindowIndex, "sameTitle": sameTitle]
		if matrixEnabled { launched["matrix"] = true }
		log.write("launched", launched)
		if layoutEnabled { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.logLayout() } }
	}

	func reactivate(_ reason: String) {
		if quitting { return }
		if !stickyStreak { log.write("stickyReactivate", ["reason": reason]) }
		stickyStreak = true
		let key = windows[keyWindowIndex - 1]
		NSApp.activate(ignoringOtherApps: true)
		key.makeKeyAndOrderFront(nil)
	}

	func tickNoise() {
		noiseTicks += 1
		let phase = Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1)
		noiseView.layer?.backgroundColor = NSColor(hue: phase, saturation: 1, brightness: 1, alpha: 1).cgColor
	}

	func coverRect(_ parts: [Double], reason: String) {
		guard isHolder, parts.count == 4, let window else { return }
		let margin = 30.0
		let rect = NSRect(x: parts[0] - margin, y: parts[1] - margin, width: parts[2] + 2 * margin, height: parts[3] + 2 * margin)
		let frame = cocoaRect(fromTopLeft: rect)
		window.setFrame(frame, display: true)
		if NSApp.isActive { window.makeKeyAndOrderFront(nil) } else { window.orderFrontRegardless() }
		log.write("covered", ["reason": reason, "topLeftRect": frameFields(rect), "frame": frameFields(window.frame), "window": label(window)])
	}

	@objc func increment() {
		increments += 1
		counterLabel.stringValue = "Count: \(increments)"
		log.write("increment", ["count": increments])
	}

	func currentValue() -> String {
		(field.currentEditor() as? NSTextView)?.string ?? field.stringValue
	}

	func controlTextDidChange(_ obj: Notification) { poll() }

	func trigger(_ name: String) -> String? {
		guard let directory = log.directory else { return nil }
		let path = directory.appendingPathComponent(name).path
		guard FileManager.default.fileExists(atPath: path) else { return nil }
		let body = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
		try? FileManager.default.removeItem(atPath: path)
		return body
	}

	func poll() {
		let value = currentValue()
		if value != lastValue {
			lastValue = value
			log.write("fieldValue", describe(value))
		}
		if parallelEnabled && windowCount >= 2 {
			let second = (field2.currentEditor() as? NSTextView)?.string ?? field2.stringValue
			if second != lastValue2 {
				lastValue2 = second
				log.write("field2Value", describe(second))
			}
		}
		if sticky && !quitting && !NSApp.isActive { reactivate("poll") }
		guard let directory = log.directory else { return }
		if matrixEnabled {
			pollResponders()
			if let body = trigger(".cu-reset-\(triggerName)") { reset(body) }
		}
		let quitFile = directory.appendingPathComponent(".cu-quit").path
		if FileManager.default.fileExists(atPath: quitFile) { quit(".cu-quit") }
		if !isHolder, let body = trigger(".cu-space-\(triggerName)") {
			let request = body.trimmingCharacters(in: .whitespacesAndNewlines)
			let space = offSpaceTarget(request, window: windows[keyWindowIndex - 1])
			let moved = space.map { moveWindows(windows.map { $0.windowNumber }, to: $0) } ?? false
			logSpaceMove(request: request, space: space, moved: moved)
		}
		if let body = trigger(".cu-spaces-\(triggerName)") {
			let seq = Int(body.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
			log.write("spaces", [
				"seq": seq,
				"windows": windows.map { ["window": label($0), "windowNumber": $0.windowNumber, "spaces": spacesOf(windowNumber: $0.windowNumber)] as [String: Any] },
				"displays": displaySpacesPayload(),
				"frontPid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0),
			])
		}
		let resizeFile = directory.appendingPathComponent(".cu-resize").path
		if !isHolder, FileManager.default.fileExists(atPath: resizeFile) {
			try? FileManager.default.removeItem(atPath: resizeFile)
			resize(".cu-resize")
		}
		if trigger(".cu-activate-\(triggerName)") != nil {
			let key = windows[keyWindowIndex - 1]
			if #available(macOS 14.0, *) { NSApp.activate() }
			NSApp.activate(ignoringOtherApps: true)
			key.makeKeyAndOrderFront(nil)
			log.write("selfActivate", ["activeNow": NSApp.isActive])
		}
		if let body = trigger(".cu-yield-\(triggerName)") {
			let parts = body.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
			if parts.count == 2, let pid = Int32(parts[0]), let app = NSRunningApplication(processIdentifier: pid) {
				let requested: Bool
				if #available(macOS 14.0, *) {
					NSApp.yieldActivation(to: app)
					requested = app.activate(from: NSRunningApplication.current, options: [])
				} else {
					requested = app.activate(options: [])
				}
				log.write("yieldActivation", ["toPid": Int(pid), "to": parts[1], "requested": requested, "activeNow": NSApp.isActive])
				if let directory = log.directory {
					try? "1\n".write(to: directory.appendingPathComponent(".cu-activate-\(parts[1])"), atomically: true, encoding: .utf8)
				}
			} else {
				log.write("yieldActivation", ["invalid": body])
			}
		}
		if let body = trigger(".cu-cover-\(triggerName)") {
			let parts = body.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
			coverRect(parts, reason: "trigger")
		}
		if layoutEnabled { pollLayoutTriggers() }
	}

	func resize(_ reason: String) {
		guard !isHolder, let window else { return }
		let before = window.frame
		let after = NSRect(x: before.origin.x - 40, y: before.origin.y + 30, width: before.size.width - 80, height: before.size.height - 60)
		window.setFrame(after, display: true)
		log.write("resized", ["reason": reason, "from": frameFields(before), "to": frameFields(window.frame)])
	}

	func windowDidBecomeKey(_ notification: Notification) { log.write("windowKey", windowFields(notification.object as? NSWindow)) }
	func windowDidResignKey(_ notification: Notification) { log.write("windowResignKey", windowFields(notification.object as? NSWindow)) }

	func logSpaceMove(request: String, space: Int?, moved: Bool) {
		log.write("spaceMove", [
			"request": request,
			"space": space ?? -1,
			"moved": moved,
			"windows": windows.map { ["window": label($0), "windowNumber": $0.windowNumber, "spaces": spacesOf(windowNumber: $0.windowNumber)] as [String: Any] },
			"displays": displaySpacesPayload(),
		])
	}

	func quit(_ reason: String) {
		if quitting { return }
		quitting = true
		pollTimer?.invalidate()
		noiseTimer?.invalidate()
		var state = describe(currentValue())
		state["reason"] = reason
		state["increments"] = increments
		state["customHits"] = customView.hits
		if parallelEnabled && windowCount >= 2 { state["field2"] = (field2.currentEditor() as? NSTextView)?.string ?? field2.stringValue }
		if noise { state["noiseTicks"] = noiseTicks }
		state["keyWindow"] = label(NSApp.keyWindow)
		state["active"] = NSApp.isActive
		log.write("quitting", state)
		exit(0)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
	func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { false }
}

extension Fixture {
	func globalFrame(_ view: NSView) -> [String: Any] {
		guard let window = view.window else { return [:] }
		return frameFields(topLeftRect(fromCocoa: window.convertToScreen(view.convert(view.bounds, to: nil))))
	}

	func screenId(_ screen: NSScreen?) -> Int {
		Int((screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0)
	}

	func samplePointer() {
		if let body = trigger(".cu-warp-on-up-\(triggerName)") {
			let parts = body.split(separator: " ").compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
			if parts.count == 2 { warpOnUp = CGPoint(x: parts[0], y: parts[1]) }
			log.write("warpArmed", ["body": body])
		}
		guard let location = CGEvent(source: nil)?.location, location != lastPointer else { return }
		lastPointer = location
		log.write("pointer", ["x": location.x, "y": location.y])
	}

	func logLayout() {
		var views: [String: Any] = ["customView": globalFrame(customView), "field": globalFrame(field)]
		if matrixEnabled || (parallelEnabled && inputLogEnabled) {
			views["scrollView"] = globalFrame(scrollView)
			views["dragView"] = globalFrame(dragView)
		}
		if let increment = incrementButton { views["increment"] = globalFrame(increment) }
		let rows = windows.map { each -> [String: Any] in
			[
				"window": label(each),
				"windowNumber": each.windowNumber,
				"title": each.title,
				"frame": frameFields(topLeftRect(fromCocoa: each.frame)),
				"onActiveSpace": each.isOnActiveSpace,
				"visible": each.isVisible,
				"screen": screenId(each.screen),
			]
		}
		let origin: [String: Any] = ["x": layoutOrigin?.x ?? 0, "y": layoutOrigin?.y ?? 0]
		log.write("layout", ["origin": origin, "screens": screensPayload(), "windows": rows, "views": views])
	}

	func pollLayoutTriggers() {
		if trigger(".cu-layout-\(triggerName)") != nil { logLayout() }
		if let body = trigger(".cu-front-\(triggerName)") {
			let name = body.trimmingCharacters(in: .whitespacesAndNewlines)
			if let window = windows.first(where: { label($0) == name }) {
				window.orderFrontRegardless()
				log.write("orderedFront", ["window": name, "active": NSApp.isActive])
			} else {
				log.write("orderedFront", ["invalid": name])
			}
		}
		guard let body = trigger(".cu-owner-windows-\(triggerName)") else { return }
		let parts = body.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
		guard parts.count == 2, let pid = Int32(parts[0]), let seq = Int(parts[1]) else {
			log.write("ownerWindows", ["invalid": body])
			return
		}
		log.write("ownerWindows", ["pid": Int(pid), "seq": seq, "windows": ownerWindows(pid: pid)])
	}
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
app.delegate = fixture
app.run()

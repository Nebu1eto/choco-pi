import AppKit
import Foundation
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
let windowOffset: NSPoint = {
	guard let parts = numbers("CU_FIXTURE_OFFSET"), parts.count == 2 else { return .zero }
	return NSPoint(x: parts[0], y: parts[1])
}()

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

final class CustomView: NSView {
	var hits = 0
	var onHit: ((Int) -> Void)?

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
		onHit?(hits)
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

final class WebLogger: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
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

final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate {
	var window: NSWindow!
	var windows: [NSWindow] = []
	var labels: [ObjectIdentifier: String] = [:]
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
	var noiseTicks = 0
	var stickyStreak = false

	func label(_ window: NSWindow?) -> String {
		guard let window else { return "" }
		return labels[ObjectIdentifier(window)] ?? "unknown"
	}

	func windowFields(_ window: NSWindow?) -> [String: Any] {
		guard let window else { return ["window": ""] }
		return ["window": label(window), "windowNumber": window.windowNumber, "title": window.title]
	}

	func makeWindow(_ title: String, _ label: String, origin: NSPoint, size: NSSize) -> NSWindow {
		let made = NSWindow(
			contentRect: NSRect(origin: NSPoint(x: origin.x + windowOffset.x, y: origin.y + windowOffset.y), size: size),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
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
		let origin = isHolder ? NSPoint(x: 60, y: 520) : NSPoint(x: 560, y: 160)
		let size = isHolder ? NSSize(width: 420, height: 160) : NSSize(width: 640, height: 480)
		window = makeWindow(windowTitle, "main", origin: origin, size: size)
		guard let content = window.contentView else { return }
		buildControls(content, size: size)
		buildExtraWindows()
		installObservers()
		finishLaunch()
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
			content.addSubview(button)
			counterLabel.frame = NSRect(x: 160, y: size.height - 105, width: 200, height: 20)
			counterLabel.setAccessibilityIdentifier("cu-count")
			content.addSubview(counterLabel)
			customView.onHit = { hits in log.write("customHit", ["count": hits]) }
			content.addSubview(customView)
			if deadViewEnabled { content.addSubview(deadView) }
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
		}

		if webEnabled {
			let web = makeWindow("CU Fixture Web", "web", origin: NSPoint(x: 560, y: 660), size: NSSize(width: 420, height: 200))
			let config = WKWebViewConfiguration()
			config.userContentController.add(webLogger, name: "cu")
			let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 200), configuration: config)
			view.navigationDelegate = webLogger
			web.contentView?.addSubview(view)
			view.loadHTMLString(webPage, baseURL: nil)
			webView = view
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
			for other in windows where other !== keyWindow { other.orderFrontRegardless() }
			keyWindow.orderFrontRegardless()
		}
		var launched: [String: Any] = ["bundleId": bundleId, "title": windowTitle, "frame": frameFields(window.frame), "active": NSApp.isActive]
		launched["windows"] = windows.map { ["window": label($0), "windowNumber": $0.windowNumber, "title": $0.title, "frame": frameFields($0.frame)] as [String: Any] }
		launched["options"] = ["sticky": sticky, "noise": noise, "deadView": deadViewEnabled, "web": webEnabled, "windowCount": windowCount, "keyWindow": keyWindowIndex, "sameTitle": sameTitle]
		log.write("launched", launched)
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
		if sticky && !quitting && !NSApp.isActive { reactivate("poll") }
		guard let directory = log.directory else { return }
		let quitFile = directory.appendingPathComponent(".cu-quit").path
		if FileManager.default.fileExists(atPath: quitFile) { quit(".cu-quit") }
		let resizeFile = directory.appendingPathComponent(".cu-resize").path
		if !isHolder, FileManager.default.fileExists(atPath: resizeFile) {
			try? FileManager.default.removeItem(atPath: resizeFile)
			resize(".cu-resize")
		}
		if trigger(".cu-activate-\(triggerName)") != nil {
			let key = windows[keyWindowIndex - 1]
			NSApp.activate(ignoringOtherApps: true)
			key.makeKeyAndOrderFront(nil)
			log.write("selfActivate", ["activeNow": NSApp.isActive])
		}
		if let body = trigger(".cu-cover-\(triggerName)") {
			let parts = body.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
			coverRect(parts, reason: "trigger")
		}
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

	func quit(_ reason: String) {
		if quitting { return }
		quitting = true
		pollTimer?.invalidate()
		noiseTimer?.invalidate()
		var state = describe(currentValue())
		state["reason"] = reason
		state["increments"] = increments
		state["customHits"] = customView.hits
		if noise { state["noiseTicks"] = noiseTicks }
		state["keyWindow"] = label(NSApp.keyWindow)
		state["active"] = NSApp.isActive
		log.write("quitting", state)
		exit(0)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
	func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { false }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
app.delegate = fixture
app.run()

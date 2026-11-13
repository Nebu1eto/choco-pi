// Disposable tier-B E2E fixture: one AppKit binary, two bundles.
//
// - com.choco-pi.FocusFixture ("CU Fixture Target"): text field "Field", button "Increment" with a
//   visible counter, and "Custom View" (AX group, mouseDown counter, no AXPress).
// - com.choco-pi.FocusHolder ("CU Focus Holder"): one text field; the stand-in for the user's app.
//   It activates itself once at launch. The target never activates itself.
//
// Both append JSON lines to $CU_FIXTURE_LOG. Quit on SIGTERM or when `.cu-quit` appears next to
// the log. The target resizes and moves its window when `.cu-resize` appears there (or on SIGUSR1).
// No network, no documents, no autosave, no user defaults are written.

import AppKit
import Foundation

let targetBundleId = "com.choco-pi.FocusFixture"
let holderBundleId = "com.choco-pi.FocusHolder"
let bundleId = Bundle.main.bundleIdentifier ?? ""
let isHolder = bundleId == holderBundleId
let role = isHolder ? "holder" : "target"
let windowTitle = isHolder ? "CU Focus Holder" : "CU Fixture Target"

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

/// Mouse target without an accessibility press action: only a real mouseDown increments it.
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

final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate {
	var window: NSWindow!
	let field = NSTextField(string: "")
	let counterLabel = NSTextField(labelWithString: "Count: 0")
	let customView = CustomView(frame: NSRect(x: 20, y: 40, width: 280, height: 120))
	var increments = 0
	var lastValue = ""
	var quitting = false
	var signalSources: [DispatchSourceSignal] = []
	var pollTimer: Timer?

	func applicationDidFinishLaunching(_ notification: Notification) {
		let origin = isHolder ? NSPoint(x: 60, y: 520) : NSPoint(x: 560, y: 160)
		let size = isHolder ? NSSize(width: 420, height: 160) : NSSize(width: 640, height: 480)
		window = NSWindow(
			contentRect: NSRect(origin: origin, size: size),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		window.title = windowTitle
		window.isReleasedWhenClosed = false
		window.isRestorable = false
		window.delegate = self
		let content = NSView(frame: NSRect(origin: .zero, size: size))
		window.contentView = content

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
		}

		let center = NotificationCenter.default
		center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
			log.write("appActive")
		}
		center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
			log.write("appInactive")
		}
		NSWorkspace.shared.notificationCenter.addObserver(
			forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
		) { note in
			let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
			log.write("frontmost", ["bundleId": app?.bundleIdentifier ?? "", "frontPid": Int(app?.processIdentifier ?? 0)])
		}
		// Only the holder logs keystrokes: it must never receive any. Target typing is
		// recorded as fieldValue changes.
		if isHolder {
			NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { event in
				log.write("keyDown", ["keyCode": Int(event.keyCode)])
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

		pollTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in self?.poll() }

		if isHolder {
			window.makeKeyAndOrderFront(nil)
			// The only activation either app performs: the holder stands in for the user's
			// frontmost app. The target never activates itself.
			NSApp.activate(ignoringOtherApps: true)
		} else {
			window.orderFrontRegardless()
		}
		log.write("launched", ["bundleId": bundleId, "title": windowTitle, "frame": frameFields(window.frame), "active": NSApp.isActive])
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

	func poll() {
		let value = currentValue()
		if value != lastValue {
			lastValue = value
			log.write("fieldValue", describe(value))
		}
		guard let directory = log.directory else { return }
		let quitFile = directory.appendingPathComponent(".cu-quit").path
		if FileManager.default.fileExists(atPath: quitFile) { quit(".cu-quit") }
		let resizeFile = directory.appendingPathComponent(".cu-resize").path
		if !isHolder, FileManager.default.fileExists(atPath: resizeFile) {
			try? FileManager.default.removeItem(atPath: resizeFile)
			resize(".cu-resize")
		}
	}

	func resize(_ reason: String) {
		guard !isHolder, let window else { return }
		let before = window.frame
		let after = NSRect(x: before.origin.x - 40, y: before.origin.y + 30, width: before.size.width - 80, height: before.size.height - 60)
		window.setFrame(after, display: true)
		log.write("resized", ["reason": reason, "from": frameFields(before), "to": frameFields(window.frame)])
	}

	func windowDidBecomeKey(_ notification: Notification) { log.write("windowKey") }
	func windowDidResignKey(_ notification: Notification) { log.write("windowResignKey") }

	func quit(_ reason: String) {
		if quitting { return }
		quitting = true
		pollTimer?.invalidate()
		var state = describe(currentValue())
		state["reason"] = reason
		state["increments"] = increments
		state["customHits"] = customView.hits
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

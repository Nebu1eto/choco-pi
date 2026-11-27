import AppKit
import Foundation
import SwiftUI
import WebKit

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

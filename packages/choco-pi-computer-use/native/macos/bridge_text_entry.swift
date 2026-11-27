import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

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

extension Bridge {
	private static let windowLevelFocusRoles: Set<String> = ["AXWindow", "AXSheet", "AXDrawer", "AXApplication", "AXSystemWide"]

	func axFocusRefusal(_ element: AXUIElement, foregroundGranted: Bool) -> BridgeFailure? {
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

	func setAXFocus(_ element: AXUIElement, foregroundGranted: Bool) throws -> AXError {
		if let refusal = axFocusRefusal(element, foregroundGranted: foregroundGranted) { throw refusal }
		try checkpoint()
		activeRequestContext()?.markEffect()
		return AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	}

	func replaceTextThroughEditor(_ element: AXUIElement, text: String, foregroundGranted: Bool) throws -> (value: String?, stage: String) {
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

	func rememberCaret(_ element: AXUIElement) {
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

	func focusKeepingCaret(_ element: AXUIElement, foregroundGranted: Bool) throws -> AXError {
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

	func textBaseline(_ element: AXUIElement) -> TextBaseline? {
		guard let value = stringAttribute(element, attribute: kAXValueAttribute as CFString) else { return nil }
		var selection: CFRange?
		if let raw = copyAttribute(element, attribute: kAXSelectedTextRangeAttribute as CFString), CFGetTypeID(raw as CFTypeRef) == AXValueGetTypeID() {
			let axValue = unsafeBitCast(raw as CFTypeRef, to: AXValue.self)
			var range = CFRange()
			if AXValueGetType(axValue) == .cfRange, AXValueGetValue(axValue, .cfRange, &range) { selection = range }
		}
		return TextBaseline(value: value, selection: selection)
	}

	func expectedTypedValue(_ baseline: TextBaseline, text: String) -> String {
		let current = baseline.value as NSString
		guard let range = baseline.selection, range.location >= 0, range.length >= 0, range.location + range.length <= current.length else {
			return baseline.value + text
		}
		return current.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
	}

	func insertTextThroughEditor(_ element: AXUIElement, text: String, foregroundGranted: Bool) throws -> (value: String?, expected: String)? {
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

	func requirePidKeyDestination(pid: Int32, record: LookRecord, element: AXUIElement?) throws -> String {
		let appElement = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appElement, 0.5)
		let observed = lookWindowElement(record, pid: pid) ?? windowElement(pid: pid, windowId: record.windowId)
		let effect = activeRequestContext()?.effectPossible ?? false
		func conflict(_ window: AXUIElement) -> BridgeFailure {
			let title = stringAttribute(window, attribute: kAXTitleAttribute as CFString) ?? ""
			return BridgeFailure(
				message: "key_window_conflict: keyboard input of \(appLabel(pid)) goes to another of its windows (\"\(title)\"), not the observed one; no key was sent. "
					+ "Another session or the user may be using that window: retry later, or observe and act on the window that has the keyboard focus",
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
				throw BridgeFailure(message: "The app's keyboard focus is not on the target element; no key was sent. "
					+ "Pointer input or a foreground grant is needed to focus it", code: "foreground_required", effectPossible: effect, details: ["inputSent": false])
			}
			if focusedWindow != nil && observed != nil { return "verified" }
		}
		let windows = axElementArray(appElement, attribute: kAXWindowsAttribute as CFString)
		if windows.count == 1, let observed, windowsRelated(windows[0], observed) { return "single_window" }
		throw BridgeFailure(message: "The helper could not verify which window of the app receives keys; no key was sent", code: "foreground_required", effectPossible: effect, details: ["inputSent": false])
	}

	func requireKeyTextSource(delivery: String) throws {
		guard delivery == "hid" else { return }
		let source = InputSourceInfo.current()
		guard source.composes else { return }
		throw BridgeFailure(
			message: "input_source_composes: the current input source (\(source.id)) composes typed keys, so this text would not arrive as requested; no key was sent. "
				+ "Use set_text on a native field, or switch to a keyboard layout input source",
			code: "input_source_composes",
			effectPossible: activeRequestContext()?.effectPossible ?? false,
			details: ["inputSent": false, "inputSource": source.diagnostics()]
		)
	}

}

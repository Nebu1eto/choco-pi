import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin
import Vision
import ImageIO
import ScreenCaptureKit

extension Bridge {
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

	func keyChord(_ keys: [String]) -> (flags: CGEventFlags, key: String)? {
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

	func postKeyPress(keys: [String], pid: Int32, delivery: String = "hid") throws {
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

	func keyCharacters(_ key: String, flags: CGEventFlags) -> String? {
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

	func postUnicodeText(_ text: String, pid: Int32, delivery: String = "hid") throws {
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

	func postAtomicUnicodeText(_ text: String, pid: Int32, delivery: String = "hid") throws {
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

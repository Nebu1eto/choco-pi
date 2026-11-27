import Foundation
import AppKit
import ApplicationServices

extension Bridge {
	func deliverAct(_ request: [String: Any]) throws -> [String: Any] {
		let cursorClock = AgentCursorActClock()
		defer { cursorClock.finish() }
		activeRequestContext()?.extendedDeliveryStatus = nil
		activeRequestContext()?.extendedDeliveryReason = nil
		activeRequestContext()?.extendedDeliveryActivated = false
		let lookId = try stringArg(request, "lookId")
		guard let record = try lookRecord(for: lookId) else {
			throw BridgeFailure(message: "Look id '\(lookId)' is no longer available", code: "stale_look", effectPossible: false)
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
		let offSpaceTarget = OffSpaceSupport.shared.isOffSpace(record.windowId)
		if offSpaceTarget && policy == "foreground" {
			throw BridgeFailure(
				message: "off_space_foreground: the target window is on a Space no display shows; foreground delivery would bring it to the front and switch the user's Space, so nothing was activated or sent. "
					+ "Act on it in the background (accessibility actions, or background_delivery: \"extended\" for pointer and key input), or ask the user to show the window first",
				code: "off_space_foreground",
				effectPossible: false,
				details: ["inputSent": false, "activationAttempted": false, "offSpace": true]
			)
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
			var response = withExtendedDeliveryStatus(withDestinationStatus(response, context: context), plan: extendedPlan)
			if offSpaceTarget {
				var performed = response["performed"] as? [String: Any] ?? [:]
				performed["offSpace"] = true
				response["performed"] = performed
			}
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
			animateCursor(along: [point])
		}
		func animateCursor(along points: [CGPoint]) {
			guard supportsAgentCursor,
				(request["cursorOverlay"] as? Bool ?? true),
				policy != "ax_only",
				!offSpaceTarget,
				!points.isEmpty,
				["press", "click", "moveMouse", "scroll", "drag"].contains(action)
			else { return }
			AgentCursorQueue.post(AgentCursorRequest(
				key: AgentCursorKey(session: currentRequestSessionId() ?? "", windowId: record.windowId),
				pid: pid,
				points: points,
				issuedAt: monotonicSeconds(),
				act: cursorClock,
				delivery: delivery
			))
		}
		func animateBeforeGesture(_ points: [CGPoint]) {
			if delivery == "pid" { animateCursor(along: points) }
		}
		func animateAfterGesture(_ points: [CGPoint]) {
			if delivery == "hid" { animateCursor(along: points) }
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
				animateBeforeGesture([point])
				try postMouseClick(at: point, pid: pid, button: mouseButton(params["button"] as? String ?? "left"), clickCount: max(1, min(3, (params["clickCount"] as? NSNumber)?.intValue ?? 1)), delivery: delivery)
				animateAfterGesture([point])
				if delivery == "pid" { pidPointerPosted = true }
			case "moveMouse":
				animateBeforeGesture([point])
				try postMouseMove(to: point, pid: pid, delivery: delivery)
				animateAfterGesture([point])
			case "scroll":
				animateBeforeGesture([point])
				if delivery == "pid", context?.extendedDelivery == nil, record.windowId != 0 {
					context?.pidScrollWindow = ExtendedDeliveryTarget(pid: pid, windowId: record.windowId, windowFrame: record.windowFrame)
				}
				defer { context?.pidScrollWindow = nil }
				try postScrollWheel(at: point, deltaX: (params["scrollX"] as? NSNumber)?.intValue ?? 0, deltaY: (params["scrollY"] as? NSNumber)?.intValue ?? 0, pid: pid, delivery: delivery)
				animateAfterGesture([point])
			case "drag":
				let points = try dragPoints()
				animateBeforeGesture(points)
				try postMouseDrag(points: points, pid: pid, delivery: delivery)
				animateAfterGesture(points)
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

}

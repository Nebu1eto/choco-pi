import AppKit

struct AgentCursorDisplay: Equatable {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let frame: CGRect
}

struct AgentCursorPlacement: Equatable {
    let display: AgentCursorDisplay
    let localPoint: CGPoint
}

enum DisplayGeometry {
    static func placement(of point: CGPoint, among displays: [AgentCursorDisplay]) -> AgentCursorPlacement? {
        guard point.x.isFinite, point.y.isFinite else { return nil }
        let usable = displays.filter { !$0.bounds.isEmpty }
        let halfOpen = usable.first { display in
            let bounds = display.bounds
            return point.x >= bounds.minX && point.x < bounds.maxX && point.y >= bounds.minY && point.y < bounds.maxY
        }
        let closed = halfOpen ?? usable.first { display in
            let bounds = display.bounds
            return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY
        }
        guard let display = closed else { return nil }
        return AgentCursorPlacement(
            display: display,
            localPoint: CGPoint(x: point.x - display.bounds.minX, y: point.y - display.bounds.minY)
        )
    }

    static func initialCursorPosition(near local: CGPoint, displaySize size: CGSize) -> CGPoint {
        CGPoint(
            x: min(max(local.x + 56, 2), max(2, size.width - 2)),
            y: min(max(local.y + 56, 2), max(2, size.height - 2))
        )
    }

    static func cursorWindowFrame(tip local: CGPoint, display: AgentCursorDisplay, size: CGFloat) -> (frame: CGRect, origin: CGPoint) {
        let width = display.bounds.width
        let height = display.bounds.height
        let offsetX = min(max(floor(local.x) - size / 2, 0), max(0, width - size))
        let offsetY = min(max(floor(local.y) - size / 2, 0), max(0, height - size))
        return (CGRect(x: display.frame.minX + offsetX, y: display.frame.maxY - offsetY - size, width: size, height: size), CGPoint(x: offsetX, y: offsetY))
    }

    static func bestDisplayIndex(for frame: CGRect, among bounds: [CGRect]) -> Int? {
        guard !bounds.isEmpty else { return nil }
        var best: Int?
        var bestArea: CGFloat = 0
        for (index, display) in bounds.enumerated() {
            let overlap = display.intersection(frame)
            let area = overlap.isNull ? 0 : overlap.width * overlap.height
            if area > bestArea {
                bestArea = area
                best = index
            }
        }
        if let best { return best }
        let centre = CGPoint(x: frame.midX, y: frame.midY)
        var nearest = 0
        var nearestDistance = CGFloat.infinity
        for (index, display) in bounds.enumerated() {
            let dx = max(display.minX - centre.x, 0, centre.x - display.maxX)
            let dy = max(display.minY - centre.y, 0, centre.y - display.maxY)
            let distance = hypot(dx, dy)
            if distance < nearestDistance {
                nearestDistance = distance
                nearest = index
            }
        }
        return nearest
    }

    @MainActor
    static func liveDisplays() -> [AgentCursorDisplay] {
        NSScreen.screens.compactMap { screen in
            guard let id = displayID(of: screen) else { return nil }
            return AgentCursorDisplay(id: id, bounds: CGDisplayBounds(id), frame: screen.frame)
        }
    }

    @MainActor
    static func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}

enum AgentCursorClock {
    static func now() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
    }
}

struct AgentCursorKey: Hashable {
    let session: String
    let windowId: UInt32
}

final class AgentCursorActClock: @unchecked Sendable {
    private let lock = NSLock()
    private var ended: Double?

    func finish(at time: Double = AgentCursorClock.now()) {
        lock.lock()
        if ended == nil { ended = time }
        lock.unlock()
    }

    var endedAt: Double? {
        lock.lock()
        defer { lock.unlock() }
        return ended
    }
}

struct AgentCursorRequest {
    let key: AgentCursorKey
    let pid: Int32
    let points: [CGPoint]
    let issuedAt: Double
    let act: AgentCursorActClock?
    let delivery: String
}

final class AgentCursorMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [AgentCursorKey: AgentCursorRequest] = [:]
    private var order: [AgentCursorKey] = []
    private var releases: [(session: String, at: Double)] = []
    private var coalesced = 0
    private var scheduled = false

    func post(_ request: AgentCursorRequest) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if pending[request.key] != nil { coalesced += 1 } else { order.append(request.key) }
        pending[request.key] = request
        return claimSchedule()
    }

    func release(session: String, at time: Double) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        releases.append((session, time))
        order.removeAll { key in
            guard key.session == session, let request = pending[key], request.issuedAt <= time else { return false }
            pending.removeValue(forKey: key)
            return true
        }
        return claimSchedule()
    }

    func take() -> (requests: [AgentCursorRequest], releases: [(session: String, at: Double)], coalesced: Int) {
        lock.lock()
        defer { lock.unlock() }
        let taken = (order.compactMap { pending[$0] }, releases, coalesced)
        pending = [:]
        order = []
        releases = []
        coalesced = 0
        scheduled = false
        return taken
    }

    private func claimSchedule() -> Bool {
        if scheduled { return false }
        scheduled = true
        return true
    }
}

enum AgentCursorQueue {
    static let mailbox = AgentCursorMailbox()

    static func post(_ request: AgentCursorRequest) {
        if mailbox.post(request) { wakeMain() }
    }

    static func release(session: String) {
        if mailbox.release(session: session, at: AgentCursorClock.now()) { wakeMain() }
    }

    private static func wakeMain() {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { AgentCursor.shared.drain(mailbox) }
        }
    }
}

struct AgentCursorPalette: Equatable {
    static let hueShifts: [Double] = [0, -24, 24, -48, 48, 160, 200, -90]

    let index: Int
    var hueShift: Double { Self.hueShifts[index % Self.hueShifts.count] }

    static let light = (r: 1.0, g: 0xD0 / 255.0, b: 0x76 / 255.0)
    static let mid = (r: 1.0, g: 0x78 / 255.0, b: 0x18 / 255.0)
    static let dark = (r: 0xE8 / 255.0, g: 0x4A / 255.0, b: 0x0C / 255.0)

    func color(_ rgb: (r: Double, g: Double, b: Double), alpha: Double = 1) -> CGColor {
        let turned = Self.rotateHue(rgb, by: hueShift)
        return CGColor(srgbRed: CGFloat(turned.r), green: CGFloat(turned.g), blue: CGFloat(turned.b), alpha: CGFloat(alpha))
    }

    static func rotateHue(_ rgb: (r: Double, g: Double, b: Double), by degrees: Double) -> (r: Double, g: Double, b: Double) {
        guard degrees != 0 else { return rgb }
        let maximum = max(rgb.r, rgb.g, rgb.b)
        let minimum = min(rgb.r, rgb.g, rgb.b)
        let delta = maximum - minimum
        guard delta > 0 else { return rgb }
        var hue: Double
        if maximum == rgb.r {
            hue = 60 * ((rgb.g - rgb.b) / delta).truncatingRemainder(dividingBy: 6)
        } else if maximum == rgb.g {
            hue = 60 * ((rgb.b - rgb.r) / delta + 2)
        } else {
            hue = 60 * ((rgb.r - rgb.g) / delta + 4)
        }
        hue = (hue + degrees).truncatingRemainder(dividingBy: 360)
        if hue < 0 { hue += 360 }
        let chroma = delta
        let secondary = chroma * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1))
        let (red, green, blue): (Double, Double, Double)
        switch hue {
        case ..<60: (red, green, blue) = (chroma, secondary, 0)
        case ..<120: (red, green, blue) = (secondary, chroma, 0)
        case ..<180: (red, green, blue) = (0, chroma, secondary)
        case ..<240: (red, green, blue) = (0, secondary, chroma)
        case ..<300: (red, green, blue) = (secondary, 0, chroma)
        default: (red, green, blue) = (chroma, 0, secondary)
        }
        return (red + minimum, green + minimum, blue + minimum)
    }
}

enum AgentCursorArt {
    static let restHeading = Double.pi / 4
    static let strokeWidth: CGFloat = 2
    static let cornerFraction: CGFloat = 0.16
    static let bloomRadius: CGFloat = 22
    static let outline = [
        CGPoint(x: 14, y: 0),
        CGPoint(x: -8, y: -9),
        CGPoint(x: -3, y: 0),
        CGPoint(x: -8, y: 9),
    ]

    static var tipExtent: CGFloat {
        let tip = outline[0]
        let previous = outline[outline.count - 1]
        let next = outline[1]
        let entry = tip.x + (previous.x - tip.x) * cornerFraction
        let exit = tip.x + (next.x - tip.x) * cornerFraction
        return 0.25 * entry + 0.5 * tip.x + 0.25 * exit + strokeWidth / 2
    }

    static func tipDirection(heading: Double) -> CGVector {
        CGVector(dx: cos(heading + .pi), dy: sin(heading + .pi))
    }

    static func bodyPath() -> CGPath {
        let path = CGMutablePath()
        for index in outline.indices {
            let previous = outline[(index + outline.count - 1) % outline.count]
            let current = outline[index]
            let next = outline[(index + 1) % outline.count]
            let entry = CGPoint(x: current.x + (previous.x - current.x) * cornerFraction, y: current.y + (previous.y - current.y) * cornerFraction)
            let exit = CGPoint(x: current.x + (next.x - current.x) * cornerFraction, y: current.y + (next.y - current.y) * cornerFraction)
            if index == outline.startIndex { path.move(to: entry) } else { path.addLine(to: entry) }
            path.addQuadCurve(to: exit, control: current)
        }
        path.closeSubpath()
        return path
    }

    static func draw(in context: CGContext, tip: CGPoint, heading: Double, palette: AgentCursorPalette) {
        var toBody = CGAffineTransform(translationX: tip.x, y: tip.y)
            .rotated(by: CGFloat(heading + .pi))
            .translatedBy(x: -tipExtent, y: 0)
        let origin = CGPoint.zero.applying(toBody)
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        if let bloom = CGGradient(
            colorsSpace: space,
            colors: [palette.color(AgentCursorPalette.mid, alpha: 0.55), palette.color(AgentCursorPalette.mid, alpha: 0.15), palette.color(AgentCursorPalette.mid, alpha: 0)] as CFArray,
            locations: [0, 0.5, 1]
        ) {
            context.drawRadialGradient(bloom, startCenter: origin, startRadius: 0, endCenter: origin, endRadius: bloomRadius, options: [])
        }
        guard let shape = bodyPath().copy(using: &toBody) else { return }
        if let fill = CGGradient(
            colorsSpace: space,
            colors: [palette.color(AgentCursorPalette.light), palette.color(AgentCursorPalette.mid), palette.color(AgentCursorPalette.dark)] as CFArray,
            locations: [0, 0.5, 1]
        ) {
            context.saveGState()
            context.addPath(shape)
            context.clip()
            context.drawLinearGradient(
                fill,
                start: CGPoint(x: origin.x + 14, y: origin.y - 9),
                end: CGPoint(x: origin.x - 8, y: origin.y + 9),
                options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
            )
            context.restoreGState()
        }
        context.addPath(shape)
        context.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        context.setLineWidth(strokeWidth)
        context.strokePath()
    }
}

struct AgentCursorPixelTip {
    let tip: CGPoint
    let bounds: CGRect?
    let strokePixels: Int
    let opaquePixels: Int
}

enum AgentCursorPixels {
    static let edgeBias = 0.35

    static func locateTip(rgba bytes: [UInt8], width: Int, height: Int, pixelsPerPoint: Double, heading: Double = AgentCursorArt.restHeading) -> AgentCursorPixelTip? {
        guard width > 0, height > 0, bytes.count >= width * height * 4, pixelsPerPoint > 0 else { return nil }
        let direction = AgentCursorArt.tipDirection(heading: heading)
        let dx = Double(direction.dx)
        let dy = Double(direction.dy)
        var stroke: [(x: Double, y: Double, along: Double)] = []
        var opaque = 0
        var minX = width, minY = height, maxX = -1, maxY = -1
        for row in 0..<height {
            for column in 0..<width {
                let offset = (row * width + column) * 4
                let alpha = bytes[offset + 3]
                if alpha >= 153 {
                    opaque += 1
                    minX = min(minX, column)
                    maxX = max(maxX, column)
                    minY = min(minY, row)
                    maxY = max(maxY, row)
                }
                guard alpha >= 128, min(bytes[offset], bytes[offset + 1], bytes[offset + 2]) >= 128 else { continue }
                let pixelX = Double(column) + 0.5
                let pixelY = Double(row) + 0.5
                stroke.append((pixelX, pixelY, pixelX * dx + pixelY * dy))
            }
        }
        guard let outermost = stroke.map(\.along).max() else { return nil }
        let apex = stroke.filter { $0.along >= outermost - 1 }
        let across = apex.reduce(0) { $0 + ($1.x * -dy + $1.y * dx) } / Double(apex.count)
        let along = outermost + edgeBias
        let tip = CGPoint(x: (along * dx - across * dy) / pixelsPerPoint, y: (along * dy + across * dx) / pixelsPerPoint)
        let bounds = maxX < 0 ? nil : CGRect(
            x: Double(minX) / pixelsPerPoint, y: Double(minY) / pixelsPerPoint,
            width: Double(maxX - minX + 1) / pixelsPerPoint, height: Double(maxY - minY + 1) / pixelsPerPoint
        )
        return AgentCursorPixelTip(tip: tip, bounds: bounds, strokePixels: stroke.count, opaquePixels: opaque)
    }
}

struct AgentCursorSnapshot {
    let key: AgentCursorKey
    let serial: Int
    let pid: Int32
    let palette: AgentCursorPalette
    let windowNumber: Int
    let visible: Bool
    let alpha: Double
    let fading: Bool
    let display: AgentCursorDisplay
    let windowFrame: CGRect
    let windowOrigin: CGPoint
    let points: [CGPoint]
    let target: CGPoint
    let localTarget: CGPoint
    let tip: CGPoint
    let tipLocal: CGPoint
    let heading: Double
    let animating: Bool
    let delivery: String
    let createdAt: Double
    let issuedAt: Double
    let drawnAt: Double
    let arrivedAt: Double?
}

struct AgentCursorEvent {
    let kind: String
    let reason: String?
    let key: AgentCursorKey
    let serial: Int?
    let at: Double
    let issuedAt: Double?
}

struct AgentCursorRegistrySnapshot {
    let now: Double
    let cursors: [AgentCursorSnapshot]
    let lastKey: AgentCursorKey?
    let unplacedPoint: CGPoint?
    let created: Int
    let coalesced: Int
    let evicted: Int
    let reorders: Int
    let dropped: [String: Int]
    let history: [AgentCursorEvent]
}

@MainActor
final class AgentCursorEntry {
    let key: AgentCursorKey
    let serial: Int
    let pid: Int32
    let palette: AgentCursorPalette
    let window: AgentCursorWindow
    let view: AgentCursorView
    let renderer = AgentCursorRenderer()
    let createdAt: Double
    var display: AgentCursorDisplay
    var points: [CGPoint] = []
    var localPoints: [CGPoint] = []
    var delivery = "pid"
    var issuedAt: Double = 0
    var drawnAt: Double = 0
    var arrivedAt: Double?
    var lastActive: Double = 0
    var fadeStartedAt: Double?
    var idleTask: Task<Void, Never>?
    var idleGeneration: UInt = 0
    var windowOrigin = CGPoint.zero

    init(key: AgentCursorKey, serial: Int, pid: Int32, palette: AgentCursorPalette, display: AgentCursorDisplay, createdAt: Double, size: CGFloat) {
        self.key = key
        self.serial = serial
        self.pid = pid
        self.palette = palette
        self.display = display
        self.createdAt = createdAt
        let frame = CGRect(x: display.frame.minX, y: display.frame.maxY - size, width: size, height: size)
        window = AgentCursorWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        view = AgentCursorView(frame: CGRect(x: 0, y: 0, width: size, height: size))
        view.palette = palette
        window.contentView = view
    }
}

@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>
    typealias DisplayProvider = @MainActor () -> [AgentCursorDisplay]
    typealias WindowOrderProvider = @MainActor () -> [UInt32]
    typealias Clock = @MainActor () -> Double

    static let shared = AgentCursor(scheduleIdleHide: scheduleDefaultIdleHide)

    nonisolated static let maxCursors = 8
    nonisolated static let windowSize: CGFloat = 96
    nonisolated static let idleSeconds = 8.0
    nonisolated static let fadeDuration = 0.25
    nonisolated static let staleAfterIssue = 1.0
    nonisolated static let staleAfterActEnd = 0.3
    nonisolated static let livenessInterval = 0.25
    nonisolated static let historyLimit = 128

    private(set) var entries: [AgentCursorKey: AgentCursorEntry] = [:]
    private let scheduleIdleHide: IdleHideScheduler
    private let displays: DisplayProvider
    private let windowOrder: WindowOrderProvider
    private let clock: Clock
    private let drivesFrames: Bool
    private var releasedAt: [String: Double] = [:]
    private var serial = 0
    private var lastLiveness = -Double.infinity
    private var frameTimer: Timer?
    private var frameInterval: Double = 0
    private var lastKey: AgentCursorKey?
    private var unplacedPoint: CGPoint?
    private var created = 0
    private var coalesced = 0
    private var evicted = 0
    private var reorders = 0
    private var dropped: [String: Int] = [:]
    private var history: [AgentCursorEvent] = []

    init(
        scheduleIdleHide: @escaping IdleHideScheduler,
        displays: @escaping DisplayProvider = DisplayGeometry.liveDisplays,
        windowOrder: @escaping WindowOrderProvider = AgentCursor.liveWindowOrder,
        clock: @escaping Clock = { AgentCursorClock.now() },
        drivesFrames: Bool = true
    ) {
        self.scheduleIdleHide = scheduleIdleHide
        self.displays = displays
        self.windowOrder = windowOrder
        self.clock = clock
        self.drivesFrames = drivesFrames
    }

    func drain(_ mailbox: AgentCursorMailbox) {
        let taken = mailbox.take()
        coalesced += taken.coalesced
        for release in taken.releases { releaseSession(release.session, at: release.at) }
        submit(taken.requests)
    }

    func submit(_ requests: [AgentCursorRequest]) {
        guard !requests.isEmpty else { return }
        let now = clock()
        var onscreen: [UInt32]?
        for request in requests {
            if let reason = staleReason(request, now: now) {
                drop(request, reason: reason, now: now)
                continue
            }
            if request.key.windowId != 0 {
                let order = onscreen ?? windowOrder()
                onscreen = order
                if !order.contains(request.key.windowId) {
                    drop(request, reason: "target_not_onscreen", now: now)
                    if let entry = entries[request.key] { remove(entry, reason: "target_not_onscreen", now: now) }
                    continue
                }
            }
            apply(request, now: now)
        }
        updateFrameDriver()
    }

    func releaseSession(_ session: String, at time: Double) {
        let now = clock()
        releasedAt[session] = max(releasedAt[session] ?? time, time)
        releasedAt = releasedAt.filter { now - $0.value < 120 }
        for entry in Array(entries.values) where entry.key.session == session {
            remove(entry, reason: "session_released", now: now)
        }
        updateFrameDriver()
    }

    func tick(now: Double) {
        for entry in Array(entries.values) {
            if entry.renderer.isAnimating {
                if entry.renderer.tick(now: now) { entry.arrivedAt = now }
                layout(entry)
            }
            if let fade = entry.fadeStartedAt {
                let alpha = 1 - (now - fade) / Self.fadeDuration
                if alpha <= 0 {
                    remove(entry, reason: "idle", now: now)
                } else {
                    entry.window.alphaValue = CGFloat(alpha)
                }
            }
        }
        if now - lastLiveness >= Self.livenessInterval {
            lastLiveness = now
            checkLiveness(now: now)
        }
        updateFrameDriver()
    }

    func snapshot() -> AgentCursorRegistrySnapshot {
        let cursors = entries.values.sorted { $0.serial < $1.serial }.map { entry -> AgentCursorSnapshot in
            let bounds = entry.display.bounds
            let tipLocal = entry.renderer.position
            return AgentCursorSnapshot(
                key: entry.key,
                serial: entry.serial,
                pid: entry.pid,
                palette: entry.palette,
                windowNumber: entry.window.windowNumber,
                visible: entry.window.isVisible,
                alpha: Double(entry.window.alphaValue),
                fading: entry.fadeStartedAt != nil,
                display: entry.display,
                windowFrame: entry.window.frame,
                windowOrigin: entry.windowOrigin,
                points: entry.points,
                target: entry.points.last ?? .zero,
                localTarget: entry.localPoints.last ?? .zero,
                tip: CGPoint(x: tipLocal.x + bounds.minX, y: tipLocal.y + bounds.minY),
                tipLocal: tipLocal,
                heading: entry.renderer.heading,
                animating: entry.renderer.isAnimating,
                delivery: entry.delivery,
                createdAt: entry.createdAt,
                issuedAt: entry.issuedAt,
                drawnAt: entry.drawnAt,
                arrivedAt: entry.arrivedAt
            )
        }
        return AgentCursorRegistrySnapshot(
            now: clock(), cursors: cursors, lastKey: lastKey, unplacedPoint: unplacedPoint,
            created: created, coalesced: coalesced, evicted: evicted, reorders: reorders,
            dropped: dropped, history: history
        )
    }

    private func staleReason(_ request: AgentCursorRequest, now: Double) -> String? {
        if let released = releasedAt[request.key.session], request.issuedAt <= released { return "session_released" }
        if now - request.issuedAt > Self.staleAfterIssue { return "stale" }
        if let ended = request.act?.endedAt, now - ended > Self.staleAfterActEnd { return "stale" }
        return nil
    }

    private func apply(_ request: AgentCursorRequest, now: Double) {
        guard let last = request.points.last, let placement = DisplayGeometry.placement(of: last, among: displays()) else {
            unplacedPoint = request.points.last
            drop(request, reason: "unplaced", now: now)
            return
        }
        unplacedPoint = nil
        let display = placement.display
        let local = request.points.map { CGPoint(x: $0.x - display.bounds.minX, y: $0.y - display.bounds.minY) }
        let entry: AgentCursorEntry
        if let existing = entries[request.key] {
            entry = existing
            entry.fadeStartedAt = nil
            entry.window.alphaValue = 1
            if entry.display != display {
                entry.display = display
                place(entry, approaching: local[0])
            }
            record("moved", entry.key, serial: entry.serial, at: now, issuedAt: request.issuedAt)
        } else {
            evictIfFull(now: now)
            serial += 1
            entry = AgentCursorEntry(
                key: request.key, serial: serial, pid: request.pid, palette: AgentCursorPalette(index: paletteIndex(for: request.key.session)),
                display: display, createdAt: now, size: Self.windowSize
            )
            entries[request.key] = entry
            created += 1
            place(entry, approaching: local[0])
            record("created", entry.key, serial: entry.serial, at: now, issuedAt: request.issuedAt)
        }
        entry.points = request.points
        entry.localPoints = local
        entry.delivery = request.delivery
        entry.issuedAt = request.issuedAt
        entry.drawnAt = now
        entry.arrivedAt = nil
        entry.lastActive = now
        entry.renderer.move(along: local, now: now)
        layout(entry)
        if !entry.window.isVisible { entry.window.orderFrontRegardless() }
        if request.key.windowId != 0 { entry.window.order(.above, relativeTo: Int(request.key.windowId)) }
        lastKey = request.key
        scheduleIdle(entry)
    }

    private func place(_ entry: AgentCursorEntry, approaching local: CGPoint) {
        let start = DisplayGeometry.initialCursorPosition(near: local, displaySize: entry.display.bounds.size)
        let toward = atan2(Double(local.y - start.y), Double(local.x - start.x))
        let heading = hypot(Double(local.x - start.x), Double(local.y - start.y)) > 0.5 ? toward - .pi : AgentCursorArt.restHeading
        entry.renderer.setInitialPosition(start, heading: heading)
    }

    private func paletteIndex(for session: String) -> Int {
        if let same = entries.values.first(where: { $0.key.session == session }) { return same.palette.index }
        let used = Set(entries.values.map { $0.palette.index % AgentCursorPalette.hueShifts.count })
        return (0..<AgentCursorPalette.hueShifts.count).first { !used.contains($0) } ?? 0
    }

    private func layout(_ entry: AgentCursorEntry) {
        let tip = entry.renderer.position
        let placed = DisplayGeometry.cursorWindowFrame(tip: tip, display: entry.display, size: Self.windowSize)
        entry.windowOrigin = placed.origin
        if entry.window.frame != placed.frame { entry.window.setFrame(placed.frame, display: false) }
        entry.view.tip = CGPoint(x: tip.x - placed.origin.x, y: tip.y - placed.origin.y)
        entry.view.heading = entry.renderer.heading
        entry.view.needsDisplay = true
    }

    private func scheduleIdle(_ entry: AgentCursorEntry) {
        entry.idleTask?.cancel()
        entry.idleGeneration &+= 1
        let generation = entry.idleGeneration
        let key = entry.key
        entry.idleTask = scheduleIdleHide { [weak self, weak entry] in
            guard let self, let entry, entry.idleGeneration == generation, self.entries[key] === entry else { return }
            entry.idleTask = nil
            entry.fadeStartedAt = self.clock()
            self.updateFrameDriver()
        }
    }

    private func evictIfFull(now: Double) {
        while entries.count >= Self.maxCursors, let oldest = entries.values.min(by: { $0.lastActive < $1.lastActive }) {
            evicted += 1
            remove(oldest, reason: "evicted", now: now)
        }
    }

    private func checkLiveness(now: Double) {
        guard !entries.isEmpty else { return }
        let order = windowOrder()
        let own = Set(entries.values.map { UInt32(truncatingIfNeeded: $0.window.windowNumber) })
        for entry in Array(entries.values) where entry.key.windowId != 0 {
            guard order.contains(entry.key.windowId) else {
                remove(entry, reason: "target_not_onscreen", now: now)
                continue
            }
            let mine = UInt32(truncatingIfNeeded: entry.window.windowNumber)
            guard let index = order.firstIndex(of: mine) else { continue }
            let below = order[(index + 1)...].first { !own.contains($0) }
            if below != entry.key.windowId {
                entry.window.order(.above, relativeTo: Int(entry.key.windowId))
                reorders += 1
            }
        }
    }

    private func remove(_ entry: AgentCursorEntry, reason: String, now: Double) {
        guard entries[entry.key] === entry else { return }
        entries.removeValue(forKey: entry.key)
        entry.idleTask?.cancel()
        entry.idleTask = nil
        entry.renderer.cancelAnimation()
        entry.window.orderOut(nil)
        entry.window.contentView = nil
        entry.window.close()
        record("removed", entry.key, reason: reason, serial: entry.serial, at: now, issuedAt: entry.issuedAt)
    }

    private func drop(_ request: AgentCursorRequest, reason: String, now: Double) {
        dropped[reason, default: 0] += 1
        record("dropped", request.key, reason: reason, serial: nil, at: now, issuedAt: request.issuedAt)
    }

    private func record(_ kind: String, _ key: AgentCursorKey, reason: String? = nil, serial: Int?, at: Double, issuedAt: Double?) {
        history.append(AgentCursorEvent(kind: kind, reason: reason, key: key, serial: serial, at: at, issuedAt: issuedAt))
        if history.count > Self.historyLimit { history.removeFirst(history.count - Self.historyLimit) }
    }

    private func updateFrameDriver() {
        guard drivesFrames else { return }
        let busy = entries.values.contains { $0.renderer.isAnimating || $0.fadeStartedAt != nil }
        let interval = busy ? 1.0 / 120.0 : (entries.isEmpty ? 0 : Self.livenessInterval)
        guard interval != frameInterval else { return }
        frameTimer?.invalidate()
        frameTimer = nil
        frameInterval = interval
        guard interval > 0 else { return }
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.tick(now: self.clock())
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        frameTimer = timer
    }

    private static func scheduleDefaultIdleHide(_ hide: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(idleSeconds))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    static func liveWindowOrder() -> [UInt32] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
    }
}

final class AgentCursorWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.stationary, .ignoresCycle, .fullScreenAuxiliary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        animationBehavior = .none
    }
}

final class AgentCursorView: NSView {
    var tip = CGPoint.zero
    var heading = AgentCursorArt.restHeading
    var palette = AgentCursorPalette(index: 0)

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.clear(bounds)
        AgentCursorArt.draw(in: context, tip: tip, heading: heading, palette: palette)
    }
}

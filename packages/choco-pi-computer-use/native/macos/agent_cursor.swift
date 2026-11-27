import AppKit

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

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

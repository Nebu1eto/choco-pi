import AppKit
import SwiftUI

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
            x: min(max(local.x - 140, 2), max(2, size.width - 2)),
            y: min(max(local.y - 140, 2), max(2, size.height - 2))
        )
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

struct AgentCursorSnapshot {
    let windowNumber: Int?
    let visible: Bool
    let display: AgentCursorDisplay?
    let windowFrame: CGRect?
    let target: CGPoint?
    let localTarget: CGPoint?
    let position: CGPoint?
    let animating: Bool
    let unplacedPoint: CGPoint?
}

@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>
    typealias DisplayProvider = @MainActor () -> [AgentCursorDisplay]

    static let shared = AgentCursor(scheduleIdleHide: scheduleDefaultIdleHide)

    private var overlay: AgentCursorOverlayWindow?
    private var idleHideTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private let scheduleIdleHide: IdleHideScheduler
    private let displays: DisplayProvider
    private var currentDisplay: AgentCursorDisplay?
    private var lastTarget: CGPoint?
    private var lastPlacement: AgentCursorPlacement?
    private var unplacedPoint: CGPoint?

    init(scheduleIdleHide: @escaping IdleHideScheduler, displays: @escaping DisplayProvider = DisplayGeometry.liveDisplays) {
        self.scheduleIdleHide = scheduleIdleHide
        self.displays = displays
    }

    func animate(to point: CGPoint, above windowId: UInt32) {
        guard let placement = DisplayGeometry.placement(of: point, among: displays()) else {
            unplacedPoint = point
            return
        }
        unplacedPoint = nil
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        let renderer = AgentCursorRenderer.shared
        let window = ensureWindow(frame: placement.display.frame)
        if window.frame != placement.display.frame { window.setFrame(placement.display.frame, display: false) }
        let displayChanged = currentDisplay != placement.display
        currentDisplay = placement.display
        if !window.isVisible { window.orderFrontRegardless() }
        window.order(.above, relativeTo: Int(windowId))

        if displayChanged || !renderer.isPlaced {
            renderer.setInitialPosition(DisplayGeometry.initialCursorPosition(near: placement.localPoint, displaySize: placement.display.bounds.size))
        }
        renderer.moveTo(point: placement.localPoint)
        lastTarget = point
        lastPlacement = placement

        let generation = idleGeneration
        idleHideTask = scheduleIdleHide { [weak self, weak window] in
            guard let self, let window else { return }
            guard generation == idleGeneration, self.overlay === window else { return }

            renderer.cancelAnimation()
            window.orderOut(nil)
            window.contentView = nil
            window.close()
            overlay = nil
            idleHideTask = nil
        }
    }

    func snapshot() -> AgentCursorSnapshot {
        let renderer = AgentCursorRenderer.shared
        return AgentCursorSnapshot(
            windowNumber: overlay?.windowNumber,
            visible: overlay?.isVisible ?? false,
            display: overlay == nil ? nil : currentDisplay,
            windowFrame: overlay?.frame,
            target: lastTarget,
            localTarget: lastPlacement?.localPoint,
            position: renderer.isPlaced ? renderer.position : nil,
            animating: renderer.isAnimating,
            unplacedPoint: unplacedPoint
        )
    }

    private static func scheduleDefaultIdleHide(_ hide: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    private func ensureWindow(frame: CGRect) -> AgentCursorOverlayWindow {
        if let overlay { return overlay }
        let window = AgentCursorOverlayWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView())
        overlay = window
        return window
    }
}

private final class AgentCursorOverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}

@MainActor
private struct AgentCursorView: View {
    @Bindable private var renderer = AgentCursorRenderer.shared

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 120.0, paused: !renderer.isAnimating)) { context in
            Canvas { graphics, _ in
                renderer.tick(now: context.date.timeIntervalSinceReferenceDate)
                drawCursor(in: graphics)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
        .ignoresSafeArea()
    }

    private func drawCursor(in graphics: GraphicsContext) {
        guard renderer.isPlaced else { return }
        let point = renderer.position

        let bloom = Color(nsColor: NSColor(red: 1, green: 0x78 / 255, blue: 0x18 / 255, alpha: 1))
        let radius: CGFloat = 22
        graphics.fill(
            Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)),
            with: .radialGradient(
                Gradient(colors: [bloom.opacity(0.55), bloom.opacity(0.15), bloom.opacity(0)]),
                center: point,
                startRadius: 0,
                endRadius: radius
            )
        )

        let points = [
            CGPoint(x: 14, y: 0),
            CGPoint(x: -8, y: -9),
            CGPoint(x: -3, y: 0),
            CGPoint(x: -8, y: 9),
        ]
        var shape = Path()
        for index in points.indices {
            let previous = points[(index + points.count - 1) % points.count]
            let current = points[index]
            let next = points[(index + 1) % points.count]
            let entry = CGPoint(x: current.x + (previous.x - current.x) * 0.16, y: current.y + (previous.y - current.y) * 0.16)
            let exit = CGPoint(x: current.x + (next.x - current.x) * 0.16, y: current.y + (next.y - current.y) * 0.16)
            if index == points.startIndex { shape.move(to: entry) } else { shape.addLine(to: entry) }
            shape.addQuadCurve(to: exit, control: current)
        }
        shape.closeSubpath()

        let transformed = shape.applying(
            CGAffineTransform(translationX: point.x, y: point.y)
                .rotated(by: CGFloat(renderer.heading + .pi))
        )
        graphics.fill(
            transformed,
            with: .linearGradient(
                Gradient(colors: [
                    Color(red: 1, green: 0xD0 / 255, blue: 0x76 / 255),
                    Color(red: 1, green: 0x78 / 255, blue: 0x18 / 255),
                    Color(red: 0xE8 / 255, green: 0x4A / 255, blue: 0x0C / 255),
                ]),
                startPoint: CGPoint(x: point.x + 14, y: point.y - 9),
                endPoint: CGPoint(x: point.x - 8, y: point.y + 9)
            )
        )
        graphics.stroke(transformed, with: .color(.white), lineWidth: 2)
    }
}

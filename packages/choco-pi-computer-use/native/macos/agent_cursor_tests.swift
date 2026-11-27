import AppKit
import CoreGraphics
import Foundation

@main
struct AgentCursorTests {
    @MainActor
    static func main() {
        testMotionLifecycle()
        testOverlayLifecycle()
        testPlacement()
        testBestDisplay()
        testPlacedIsNotSignBased()
        testOverlayFollowsDisplay()
        FileHandle.standardOutput.write(Data("agent cursor tests passed\n".utf8))
    }

    @MainActor
    private static func testMotionLifecycle() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 100, y: 100))

        expect(!renderer.isAnimating, "renderer should start idle")

        renderer.moveTo(point: CGPoint(x: 500, y: 400))
        expect(renderer.isAnimating, "renderer should become active when motion starts")

        var now: CFTimeInterval = 0
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        expect(!renderer.isAnimating, "renderer should become idle after motion settles")

        renderer.moveTo(point: CGPoint(x: 800, y: 600))
        renderer.tick(now: now + 1.0 / 120.0)
        let stoppedPosition = renderer.position

        renderer.cancelAnimation()
        expect(!renderer.isAnimating, "cancelled motion should become idle")

        renderer.tick(now: now + 1)
        expect(renderer.position == stoppedPosition, "idle ticks should not change the cancelled position")

        renderer.setInitialPosition(CGPoint(x: 100, y: 100))
        renderer.moveTo(point: CGPoint(x: 300, y: 300))
        for _ in 0..<12 {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        let latestTarget = CGPoint(x: 900, y: 700)
        renderer.moveTo(point: latestTarget)
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        let endpointOffset = CGFloat(cos(Double.pi / 4) * 16)
        let expectedPosition = CGPoint(
            x: latestTarget.x + endpointOffset,
            y: latestTarget.y + endpointOffset
        )
        expect(distance(renderer.position, expectedPosition) < 0.001, "latest target should supersede in-flight motion")
    }

    @MainActor
    private static func testOverlayLifecycle() {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(ObjectIdentifier.init))
        let scheduler = ManualIdleHideScheduler()
        let cursor = AgentCursor(scheduleIdleHide: scheduler.schedule)

        cursor.animate(to: CGPoint(x: 300, y: 300), above: 0)
        guard let firstWindow = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0.isVisible
        }) else {
            fail("first action should create a visible overlay")
        }

        cursor.animate(to: CGPoint(x: 500, y: 500), above: 0)
        expect(scheduler.count == 2, "each action should replace the idle timeout")

        scheduler.fire(0)
        expect(firstWindow.isVisible, "a stale timeout should not hide the current overlay")
        expect(firstWindow.contentView != nil, "a stale timeout should not release the current view")

        scheduler.fire(1)
        expect(!AgentCursorRenderer.shared.isAnimating, "the current timeout should stop rendering")
        expect(!firstWindow.isVisible, "the current timeout should hide the overlay")
        expect(firstWindow.contentView == nil, "the current timeout should release the view tree")

        cursor.animate(to: CGPoint(x: 700, y: 700), above: 0)
        guard let recreatedWindow = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0 !== firstWindow && $0.isVisible
        }) else {
            fail("a later action should recreate the overlay")
        }

        scheduler.fire(2)
        expect(!recreatedWindow.isVisible, "the recreated overlay should retain the idle lifecycle")
        expect(recreatedWindow.contentView == nil, "the recreated overlay should release its view tree")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fail(message) }
    }

    static let builtIn = AgentCursorDisplay(id: 1, bounds: CGRect(x: 0, y: 0, width: 2056, height: 1329), frame: CGRect(x: 0, y: 0, width: 2056, height: 1329))
    static let dell = AgentCursorDisplay(id: 3, bounds: CGRect(x: -485, y: -1692, width: 3008, height: 1692), frame: CGRect(x: -485, y: 1329, width: 3008, height: 1692))
    static let sidecar = AgentCursorDisplay(id: 4, bounds: CGRect(x: -1579, y: 620, width: 1579, height: 1088), frame: CGRect(x: -1579, y: -379, width: 1579, height: 1088))
    static let threeDisplays = [builtIn, dell, sidecar]

    private static func expectPlacement(
        _ point: CGPoint, _ displays: [AgentCursorDisplay], display: AgentCursorDisplay, local: CGPoint, _ message: String
    ) {
        let placement = DisplayGeometry.placement(of: point, among: displays)
        expect(placement?.display == display, "\(message): display \(String(describing: placement?.display.id)) instead of \(display.id)")
        expect(placement?.localPoint == local, "\(message): local \(String(describing: placement?.localPoint)) instead of \(local)")
    }

    private static func testPlacement() {
        let all = threeDisplays
        expectPlacement(CGPoint(x: 800, y: 400), all, display: builtIn, local: CGPoint(x: 800, y: 400), "point on the primary display")
        expectPlacement(CGPoint(x: 100, y: -1000), all, display: dell, local: CGPoint(x: 585, y: 692), "point on the display above (negative y)")
        expectPlacement(CGPoint(x: -800, y: 900), all, display: sidecar, local: CGPoint(x: 779, y: 280), "point on the display to the left (negative x)")
        expectPlacement(CGPoint(x: -485, y: -1692), all, display: dell, local: .zero, "top-left corner of a non-primary display")
        expectPlacement(CGPoint(x: 0, y: 700), all, display: builtIn, local: CGPoint(x: 0, y: 700), "shared vertical edge belongs to the display starting there")
        expectPlacement(CGPoint(x: 100, y: 0), all, display: builtIn, local: CGPoint(x: 100, y: 0), "shared horizontal edge belongs to the display starting there")
        expectPlacement(CGPoint(x: -0.5, y: 700), all, display: sidecar, local: CGPoint(x: 1578.5, y: 80), "just left of the shared edge")
        expectPlacement(CGPoint(x: 2056, y: 500), all, display: builtIn, local: CGPoint(x: 2056, y: 500), "outer right edge stays on its display")
        expectPlacement(CGPoint(x: 800, y: 400), all.reversed(), display: builtIn, local: CGPoint(x: 800, y: 400), "display order does not matter")
        expectPlacement(CGPoint(x: 0, y: 700), all.reversed(), display: builtIn, local: CGPoint(x: 0, y: 700), "edge rule does not depend on order")
        expect(DisplayGeometry.placement(of: CGPoint(x: 3000, y: 3000), among: all) == nil, "a point on no display is not placed")
        expect(DisplayGeometry.placement(of: CGPoint(x: -1000, y: 0), among: all) == nil, "a point in the gap between displays is not placed")
        expect(DisplayGeometry.placement(of: CGPoint(x: CGFloat.nan, y: 10), among: all) == nil, "a non-finite point is not placed")
        expect(DisplayGeometry.placement(of: CGPoint(x: 10, y: 10), among: []) == nil, "no displays, no placement")
        let single = [builtIn]
        expectPlacement(CGPoint(x: 10, y: 10), single, display: builtIn, local: CGPoint(x: 10, y: 10), "single display")
        expect(DisplayGeometry.placement(of: CGPoint(x: -1, y: -1), among: single) == nil, "single display: off-screen point")
        let empty = AgentCursorDisplay(id: 9, bounds: CGRect(x: 0, y: 0, width: 0, height: 0), frame: .zero)
        expectPlacement(CGPoint(x: 0, y: 0), [empty, builtIn], display: builtIn, local: .zero, "an empty display is skipped")

        let start = DisplayGeometry.initialCursorPosition(near: CGPoint(x: 10, y: 1500), displaySize: dell.bounds.size)
        expect(start == CGPoint(x: 2, y: 1360), "initial position is clamped inside the display in local points")
    }

    private static func testBestDisplay() {
        let bounds = threeDisplays.map(\.bounds)
        let spanning = CGRect(x: 1800, y: -100, width: 400, height: 600)
        expect(DisplayGeometry.bestDisplayIndex(for: spanning, among: bounds) == 0, "a window spanning two displays belongs to the larger overlap")
        let mostlyAbove = CGRect(x: 100, y: -500, width: 400, height: 600)
        expect(DisplayGeometry.bestDisplayIndex(for: mostlyAbove, among: bounds) == 1, "a window mostly on the display above")
        let farLeft = CGRect(x: -5000, y: 900, width: 100, height: 100)
        expect(DisplayGeometry.bestDisplayIndex(for: farLeft, among: bounds) == 2, "an off-screen window takes the nearest display")
        expect(DisplayGeometry.bestDisplayIndex(for: spanning, among: []) == nil, "no displays, no index")
    }

    @MainActor
    private static func testPlacedIsNotSignBased() {
        let renderer = AgentCursorRenderer()
        expect(!renderer.isPlaced, "a new renderer has no position")
        renderer.setInitialPosition(CGPoint(x: -500, y: -300))
        expect(renderer.isPlaced, "a negative position is a valid position")
        expect(renderer.position == CGPoint(x: -500, y: -300), "the negative position is kept")
    }

    @MainActor
    private static func testOverlayFollowsDisplay() {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(ObjectIdentifier.init))
        let scheduler = ManualIdleHideScheduler()
        let cursor = AgentCursor(scheduleIdleHide: scheduler.schedule, displays: { threeDisplays })
        let renderer = AgentCursorRenderer.shared

        cursor.animate(to: CGPoint(x: 800, y: 400), above: 0)
        guard let window = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0.isVisible
        }) else {
            fail("an action should show the overlay")
        }
        expect(window.frame == builtIn.frame, "the overlay covers the display of the acted point, not the key screen")
        var snapshot = cursor.snapshot()
        expect(snapshot.display == builtIn, "the snapshot names the built-in display")
        expect(snapshot.localTarget == CGPoint(x: 800, y: 400), "the target is drawn at the local point")

        cursor.animate(to: CGPoint(x: 100, y: -1000), above: 0)
        expect(window.frame == dell.frame, "the overlay follows an action on another display")
        snapshot = cursor.snapshot()
        expect(snapshot.display == dell, "the snapshot names the display above")
        expect(snapshot.localTarget == CGPoint(x: 585, y: 692), "the target is local to the display above")
        let position = renderer.position
        expect(position.x >= 0 && position.y >= 0 && position.x <= dell.bounds.width && position.y <= dell.bounds.height,
               "the cursor restarts inside the new display")

        cursor.animate(to: CGPoint(x: -800, y: 900), above: 0)
        expect(window.frame == sidecar.frame, "the overlay follows to the display on the left")
        expect(cursor.snapshot().localTarget == CGPoint(x: 779, y: 280), "local point on the display on the left")

        let scheduled = scheduler.count
        cursor.animate(to: CGPoint(x: 9000, y: 9000), above: 0)
        expect(scheduler.count == scheduled, "a point on no display does not draw or reschedule")
        expect(window.frame == sidecar.frame, "a point on no display leaves the overlay where it was")
        expect(cursor.snapshot().unplacedPoint == CGPoint(x: 9000, y: 9000), "the unplaced point is reported")

        scheduler.fire(scheduler.count - 1)
        expect(!window.isVisible, "the idle timeout hides the overlay")
        cursor.animate(to: CGPoint(x: 120, y: -1600), above: 0)
        guard let recreated = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0 !== window && $0.isVisible
        }) else {
            fail("a later action should recreate the overlay")
        }
        expect(recreated.frame == dell.frame, "a recreated overlay is created on the acted display")
        scheduler.fire(scheduler.count - 1)
        expect(!recreated.isVisible, "the recreated overlay hides again")
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }
}

@MainActor
private final class ManualIdleHideScheduler {
    private var actions: [@MainActor () -> Void] = []

    var count: Int { actions.count }

    func schedule(_ action: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        actions.append(action)
        return Task {}
    }

    func fire(_ index: Int) {
        actions[index]()
    }
}

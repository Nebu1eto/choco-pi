import AppKit
import CoreGraphics
import Foundation

@main
struct AgentCursorTests {
    @MainActor
    static func main() {
        _ = NSApplication.shared
        testMotionSettlesOnTarget()
        testRetargetMidFlight()
        testDragFollowsPath()
        testApproachTiming()
        testTipGeometry()
        testPixelLocator()
        testPlacement()
        testBestDisplay()
        testCursorWindowFrame()
        testPlacedIsNotSignBased()
        testConcurrentCursors()
        testCursorKeys()
        testStaleAndReleased()
        testMailboxCoalesces()
        testBound()
        testIdleFadeAndLiveness()
        FileHandle.standardOutput.write(Data("agent cursor tests passed\n".utf8))
    }

    @MainActor
    private static func run(_ renderer: AgentCursorRenderer, from start: Double, limit: Double = 5) -> Double {
        var now = start
        while renderer.isAnimating && now - start < limit {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        return now
    }

    @MainActor
    private static func testMotionSettlesOnTarget() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 100, y: 100))
        expect(!renderer.isAnimating, "renderer should start idle")
        let target = CGPoint(x: 500.25, y: 400.75)
        renderer.moveTo(point: target, now: 0)
        expect(renderer.isAnimating, "renderer should become active when motion starts")
        _ = run(renderer, from: 0)
        expect(!renderer.isAnimating, "renderer should become idle after motion settles")
        expect(renderer.position == target, "the hot spot settles exactly on the target, not offset: \(renderer.position)")
        expect(abs(renderer.heading - AgentCursorArt.restHeading) < 1e-9, "the pointer rests at its resting heading")

        renderer.moveTo(point: CGPoint(x: 800, y: 600), now: 10)
        renderer.tick(now: 10 + 1.0 / 120.0)
        let stopped = renderer.position
        renderer.cancelAnimation()
        expect(!renderer.isAnimating, "cancelled motion should become idle")
        renderer.tick(now: 11)
        expect(renderer.position == stopped, "idle ticks should not change the cancelled position")
    }

    @MainActor
    private static func testRetargetMidFlight() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 100, y: 100))
        renderer.moveTo(point: CGPoint(x: 300, y: 300), now: 0)
        var now = 0.0
        for _ in 0..<6 {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        let latest = CGPoint(x: 900, y: 700)
        renderer.moveTo(point: latest, now: now)
        _ = run(renderer, from: now)
        expect(renderer.position == latest, "a move requested mid-flight supersedes the first and is not left short")
        renderer.setInitialPosition(CGPoint(x: 50, y: 50))
        now = 20
        for index in 0..<30 {
            renderer.moveTo(point: CGPoint(x: 100 + Double(index) * 13, y: 200 + Double(index % 5) * 17), now: now)
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        let last = CGPoint(x: 100 + 29 * 13, y: 200 + Double(29 % 5) * 17)
        _ = run(renderer, from: now)
        expect(renderer.position == last, "a burst of retargets ends on the last target")
    }

    @MainActor
    private static func testDragFollowsPath() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 40, y: 40))
        let path = [CGPoint(x: 100, y: 300), CGPoint(x: 200, y: 300), CGPoint(x: 300, y: 300), CGPoint(x: 400, y: 320)]
        renderer.move(along: path, now: 0)
        var now = 0.0
        var closest = [CGFloat](repeating: .infinity, count: path.count)
        var offPath: CGFloat = 0
        var reachedStart = false
        while renderer.isAnimating && now < 5 {
            now += 1.0 / 240.0
            renderer.tick(now: now)
            for (index, point) in path.enumerated() { closest[index] = min(closest[index], distance(renderer.position, point)) }
            if distance(renderer.position, path[0]) < 0.001 { reachedStart = true }
            if reachedStart {
                let toSegment = zip(path, path.dropFirst()).map { segmentDistance(renderer.position, $0, $1) }.min() ?? 0
                offPath = max(offPath, toSegment)
            }
        }
        expect(renderer.position == path[path.count - 1], "a drag ends exactly at the drop point")
        for (index, value) in closest.enumerated() { expect(value < 4, "the drag passes waypoint \(index) (closest \(value))") }
        expect(offPath < 0.01, "after its approach the drag follows the path (max off-path \(offPath))")
        expect(now <= AgentCursorRenderer.approachMaximum + AgentCursorRenderer.pathMaximum + 0.02, "a drag ends within its duration bounds (\(now) s)")
    }

    @MainActor
    private static func testApproachTiming() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 10, y: 10))
        renderer.moveTo(point: CGPoint(x: 2500, y: 1500), now: 0)
        let farEnd = run(renderer, from: 0)
        expect(farEnd <= AgentCursorRenderer.approachMaximum + 0.01, "a long approach arrives within the maximum (\(farEnd) s)")
        renderer.moveTo(point: CGPoint(x: 2501, y: 1501), now: 100)
        let nearEnd = run(renderer, from: 100) - 100
        expect(nearEnd >= AgentCursorRenderer.approachMinimum - 0.01 && nearEnd <= AgentCursorRenderer.approachMinimum + 0.02, "a short approach takes the minimum (\(nearEnd) s)")
    }

    private static func render(tip: CGPoint, scale: CGFloat, size: Int = 96, palette: AgentCursorPalette = AgentCursorPalette(index: 0)) -> [UInt8] {
        let pixels = Int(CGFloat(size) * scale)
        var bytes = [UInt8](repeating: 0, count: pixels * pixels * 4)
        bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: pixels * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return }
            context.translateBy(x: 0, y: CGFloat(pixels))
            context.scaleBy(x: scale, y: -scale)
            AgentCursorArt.draw(in: context, tip: tip, heading: AgentCursorArt.restHeading, palette: palette)
        }
        return bytes
    }

    private static func testTipGeometry() {
        expect(abs(AgentCursorArt.tipExtent - 13.24) < 1e-9, "tip extent \(AgentCursorArt.tipExtent)")
        let scale: CGFloat = 4
        let tip = CGPoint(x: 48, y: 48)
        let bytes = render(tip: tip, scale: scale)
        let pixels = Int(96 * scale)
        let direction = AgentCursorArt.tipDirection(heading: AgentCursorArt.restHeading)
        var beyond: CGFloat = -.infinity
        for row in 0..<pixels {
            for column in 0..<pixels where bytes[(row * pixels + column) * 4 + 3] >= 128 {
                let x = (CGFloat(column) + 0.5) / scale - tip.x
                let y = (CGFloat(row) + 0.5) / scale - tip.y
                beyond = max(beyond, x * direction.dx + y * direction.dy)
            }
        }
        expect(beyond <= 0.2 && beyond >= -0.5, "the outermost drawn pixel is at the hot spot (\(beyond) pt beyond it)")
    }

    private static func testPixelLocator() {
        var worst2x: CGFloat = 0
        var worst1x: CGFloat = 0
        for (index, fraction) in [0.0, 0.13, 0.25, 0.5, 0.71, 0.9].enumerated() {
            let tip = CGPoint(x: 41 + fraction, y: 52 + (1 - fraction) * 0.6)
            for palette in 0..<AgentCursorPalette.hueShifts.count where palette == index % AgentCursorPalette.hueShifts.count || palette == 0 {
                for scale in [CGFloat(2), CGFloat(1)] {
                    let bytes = render(tip: tip, scale: scale, palette: AgentCursorPalette(index: palette))
                    let size = Int(96 * scale)
                    guard let located = AgentCursorPixels.locateTip(rgba: bytes, width: size, height: size, pixelsPerPoint: Double(scale)) else {
                        fail("no tip located at \(tip) scale \(scale) palette \(palette)")
                    }
                    let error = distance(located.tip, tip)
                    if scale == 2 { worst2x = max(worst2x, error) } else { worst1x = max(worst1x, error) }
                    if let bounds = located.bounds {
                        expect(bounds.width <= 40 && bounds.height <= 40, "the body spans at most 40 pt (\(bounds))")
                    } else {
                        fail("no body pixels")
                    }
                }
            }
        }
        expect(worst2x <= 0.35, "pixel tip at 2x within 0.35 pt (worst \(worst2x))")
        expect(worst1x <= 0.7, "pixel tip at 1x within 0.7 pt (worst \(worst1x))")
        FileHandle.standardOutput.write(Data("pixel tip locator: worst error \(worst2x) pt at 2x, \(worst1x) pt at 1x\n".utf8))
        expect(AgentCursorPixels.locateTip(rgba: [UInt8](repeating: 0, count: 16 * 16 * 4), width: 16, height: 16, pixelsPerPoint: 1) == nil, "an empty image has no tip")
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
        expect(DisplayGeometry.placement(of: CGPoint(x: 3000, y: 3000), among: all) == nil, "a point on no display is not placed")
        expect(DisplayGeometry.placement(of: CGPoint(x: -1000, y: 0), among: all) == nil, "a point in the gap between displays is not placed")
        expect(DisplayGeometry.placement(of: CGPoint(x: CGFloat.nan, y: 10), among: all) == nil, "a non-finite point is not placed")
        expect(DisplayGeometry.placement(of: CGPoint(x: 10, y: 10), among: []) == nil, "no displays, no placement")
        let empty = AgentCursorDisplay(id: 9, bounds: CGRect(x: 0, y: 0, width: 0, height: 0), frame: .zero)
        expectPlacement(CGPoint(x: 0, y: 0), [empty, builtIn], display: builtIn, local: .zero, "an empty display is skipped")

        let start = DisplayGeometry.initialCursorPosition(near: CGPoint(x: 10, y: 1500), displaySize: dell.bounds.size)
        expect(start == CGPoint(x: 66, y: 1556), "a new cursor starts below and right of its point: \(start)")
        let clamped = DisplayGeometry.initialCursorPosition(near: CGPoint(x: 3000, y: 1690), displaySize: dell.bounds.size)
        expect(clamped == CGPoint(x: 3006, y: 1690), "the start is kept inside the display: \(clamped)")
    }

    private static func testBestDisplay() {
        let bounds = threeDisplays.map(\.bounds)
        expect(DisplayGeometry.bestDisplayIndex(for: CGRect(x: 1800, y: -100, width: 400, height: 600), among: bounds) == 0, "a window spanning two displays belongs to the larger overlap")
        expect(DisplayGeometry.bestDisplayIndex(for: CGRect(x: 100, y: -500, width: 400, height: 600), among: bounds) == 1, "a window mostly on the display above")
        expect(DisplayGeometry.bestDisplayIndex(for: CGRect(x: -5000, y: 900, width: 100, height: 100), among: bounds) == 2, "an off-screen window takes the nearest display")
        expect(DisplayGeometry.bestDisplayIndex(for: .zero, among: []) == nil, "no displays, no index")
    }

    private static func testCursorWindowFrame() {
        let size: CGFloat = 96
        let middle = DisplayGeometry.cursorWindowFrame(tip: CGPoint(x: 585.4, y: 692.7), display: dell, size: size)
        expect(middle.origin == CGPoint(x: 537, y: 644), "the window's top-left is on whole points around the tip: \(middle.origin)")
        expect(middle.frame == CGRect(x: -485 + 537, y: 1329 + 1692 - 644 - 96, width: 96, height: 96), "Cocoa frame on the display above: \(middle.frame)")
        let corner = DisplayGeometry.cursorWindowFrame(tip: CGPoint(x: 3, y: 1690), display: dell, size: size)
        expect(corner.origin == CGPoint(x: 0, y: 1692 - 96), "near a corner the window stays inside its display: \(corner.origin)")
        for display in threeDisplays {
            for tip in [CGPoint(x: -20, y: -20), CGPoint(x: display.bounds.width + 30, y: 10), CGPoint(x: 400, y: display.bounds.height)] {
                let frame = DisplayGeometry.cursorWindowFrame(tip: tip, display: display, size: size).frame
                expect(display.frame.contains(frame), "the window is inside display \(display.id) for tip \(tip): \(frame)")
            }
        }
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
    private final class Harness {
        let scheduler = ManualIdleHideScheduler()
        var now = 1000.0
        var onscreen: [UInt32] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]
        lazy var cursor = AgentCursor(
            scheduleIdleHide: scheduler.schedule,
            displays: { AgentCursorTests.threeDisplays },
            windowOrder: { [unowned self] in self.onscreen },
            clock: { [unowned self] in self.now },
            drivesFrames: false
        )

        func request(_ session: String, _ window: UInt32, _ points: [CGPoint], issued: Double? = nil, act: AgentCursorActClock? = nil) -> AgentCursorRequest {
            AgentCursorRequest(key: AgentCursorKey(session: session, windowId: window), pid: 1, points: points, issuedAt: issued ?? now, act: act, delivery: "pid")
        }

        func settle() {
            for _ in 0..<600 {
                now += 1.0 / 120.0
                cursor.tick(now: now)
                if !cursor.snapshot().cursors.contains(where: \.animating) { return }
            }
        }

        func cursors() -> [AgentCursorSnapshot] { cursor.snapshot().cursors }
    }

    @MainActor
    private static func testConcurrentCursors() {
        let harness = Harness()
        let a = CGPoint(x: 400, y: 300)
        let b = CGPoint(x: 1200, y: 900)
        let c = CGPoint(x: 100, y: -1000)
        harness.cursor.submit([
            harness.request("s1", 101, [a]),
            harness.request("s2", 102, [b]),
            harness.request("s3", 103, [c]),
        ])
        var cursors = harness.cursors()
        expect(cursors.count == 3, "three sessions acting at once have three cursors (\(cursors.count))")
        expect(Set(cursors.map(\.windowNumber)).count == 3, "each cursor has its own window")
        expect(cursors.allSatisfy(\.visible), "all three cursors are shown")
        for _ in 0..<5 {
            harness.now += 1.0 / 120.0
            harness.cursor.tick(now: harness.now)
        }
        for cursor in harness.cursors() {
            let frame = DisplayGeometry.cursorWindowFrame(tip: cursor.tipLocal, display: cursor.display, size: AgentCursor.windowSize).frame
            expect(cursor.windowFrame == frame, "a moving cursor's window follows its tip")
        }
        harness.settle()
        cursors = harness.cursors()
        let expected: [String: (CGPoint, AgentCursorDisplay)] = ["s1": (a, builtIn), "s2": (b, builtIn), "s3": (c, dell)]
        for cursor in cursors {
            guard let (point, display) = expected[cursor.key.session] else { fail("unexpected cursor \(cursor.key)") }
            expect(cursor.tip == point, "\(cursor.key.session) settles exactly on its own point: \(cursor.tip) vs \(point)")
            expect(cursor.display == display, "\(cursor.key.session) is on display \(display.id)")
            expect(cursor.arrivedAt != nil, "\(cursor.key.session) records its arrival")
            for (other, entry) in expected where other != cursor.key.session {
                expect(distance(cursor.tip, entry.0) > 50, "\(cursor.key.session) is not at \(other)'s point")
            }
        }
        expect(Set(cursors.map(\.palette.index)).count == 3, "concurrent sessions get distinct hues")
        expect(cursors.first { $0.key.session == "s1" }?.palette.index == 0, "the first session keeps the plain orange")
        harness.cursor.submit([harness.request("s1", 101, [CGPoint(x: 600, y: 600)]), harness.request("s2", 102, [CGPoint(x: 640, y: 610)])])
        harness.settle()
        let near = harness.cursors()
        expect(near.first { $0.key.session == "s1" }?.tip == CGPoint(x: 600, y: 600), "s1 moves to its next point")
        expect(near.first { $0.key.session == "s2" }?.tip == CGPoint(x: 640, y: 610), "s2 moves to its next point, 40 pt away")
        harness.cursor.submit([harness.request("s1", 101, [CGPoint(x: -800, y: 900)])])
        harness.settle()
        let moved = harness.cursors().first { $0.key.session == "s1" }
        expect(moved?.display == sidecar && moved?.tip == CGPoint(x: -800, y: 900), "a cursor follows its session to another display")
        expect(moved.map { sidecar.frame.contains($0.windowFrame) } ?? false, "its window is on that display")
    }

    @MainActor
    private static func testCursorKeys() {
        let harness = Harness()
        harness.cursor.submit([harness.request("s1", 101, [CGPoint(x: 400, y: 300)])])
        harness.cursor.submit([harness.request("s1", 101, [CGPoint(x: 500, y: 300)])])
        expect(harness.cursors().count == 1, "one session acting on one window again moves its cursor")
        harness.cursor.submit([harness.request("s1", 102, [CGPoint(x: 900, y: 300)])])
        let cursors = harness.cursors()
        expect(cursors.count == 2, "one session acting on a second window has a second cursor")
        expect(Set(cursors.map(\.palette.index)).count == 1, "one session's cursors share a hue")
        harness.cursor.submit([harness.request("", 103, [CGPoint(x: 900, y: 900)])])
        expect(harness.cursors().count == 3, "a request without a session has its own cursor")
        harness.cursor.submit([harness.request("s9", 101, [CGPoint(x: 9000, y: 9000)])])
        expect(harness.cursors().count == 3, "a point on no display draws nothing")
        expect(harness.cursor.snapshot().dropped["unplaced"] == 1, "and is counted as unplaced")
        expect(harness.cursor.snapshot().unplacedPoint == CGPoint(x: 9000, y: 9000), "the unplaced point is reported")
    }

    @MainActor
    private static func testStaleAndReleased() {
        let harness = Harness()
        let point = [CGPoint(x: 400, y: 300)]
        harness.cursor.submit([harness.request("s1", 101, point, issued: harness.now - AgentCursor.staleAfterIssue - 0.01)])
        expect(harness.cursors().isEmpty, "a request older than the stale bound is dropped")
        let ended = AgentCursorActClock()
        ended.finish(at: harness.now - AgentCursor.staleAfterActEnd - 0.01)
        harness.cursor.submit([harness.request("s1", 101, point, issued: harness.now - 0.5, act: ended)])
        expect(harness.cursors().isEmpty, "a request whose act ended long enough ago is dropped")
        let recent = AgentCursorActClock()
        recent.finish(at: harness.now - 0.1)
        harness.cursor.submit([harness.request("s1", 101, point, issued: harness.now - 0.2, act: recent)])
        expect(harness.cursors().count == 1, "a request whose act just ended is drawn")
        expect(harness.cursor.snapshot().dropped["stale"] == 2, "two stale drops counted")

        harness.cursor.submit([harness.request("s2", 102, point)])
        let issuedBefore = harness.now
        harness.now += 0.05
        harness.cursor.releaseSession("s1", at: harness.now)
        var cursors = harness.cursors()
        expect(cursors.count == 1 && cursors[0].key.session == "s2", "releasing a session removes only its cursors")
        harness.cursor.submit([harness.request("s1", 101, point, issued: issuedBefore)])
        expect(harness.cursors().count == 1, "a request made before its session's release is dropped")
        harness.now += 0.05
        harness.cursor.submit([harness.request("s1", 101, point)])
        cursors = harness.cursors()
        expect(cursors.count == 2, "a later request of a released session id draws again")

        harness.onscreen.removeAll { $0 == 102 }
        harness.cursor.submit([harness.request("s2", 102, [CGPoint(x: 700, y: 700)])])
        cursors = harness.cursors()
        expect(cursors.count == 1 && cursors[0].key.session == "s1", "a request for a window not on screen is dropped and its cursor removed")
        let gone = harness.cursor.snapshot().history.filter { $0.kind == "created" && $0.key.windowId == 102 && $0.at > harness.now - 0.001 }
        expect(gone.isEmpty, "no cursor is created for a window that is gone")
    }

    private static func testMailboxCoalesces() {
        let mailbox = AgentCursorMailbox()
        let key = AgentCursorKey(session: "s1", windowId: 7)
        func make(_ x: CGFloat, _ session: String = "s1", issued: Double = 1) -> AgentCursorRequest {
            AgentCursorRequest(key: AgentCursorKey(session: session, windowId: 7), pid: 1, points: [CGPoint(x: x, y: 1)], issuedAt: issued, act: nil, delivery: "pid")
        }
        expect(mailbox.post(make(1)), "the first request schedules a drain")
        expect(!mailbox.post(make(2)), "later requests do not schedule another")
        expect(!mailbox.post(make(3)), "nor does a third")
        expect(!mailbox.post(make(9, "s2")), "nor one of another cursor")
        var taken = mailbox.take()
        expect(taken.requests.count == 2 && taken.coalesced == 2, "queued requests for one cursor coalesce to the latest")
        expect(taken.requests.first { $0.key == key }?.points == [CGPoint(x: 3, y: 1)], "the latest request survives")
        expect(mailbox.post(make(4, issued: 5)), "after a drain a request schedules again")
        _ = mailbox.release(session: "s1", at: 6)
        taken = mailbox.take()
        expect(taken.requests.isEmpty && taken.releases.count == 1, "a release drops its session's queued requests")
    }

    @MainActor
    private static func testBound() {
        let harness = Harness()
        for index in 0..<(AgentCursor.maxCursors + 1) {
            harness.now += 0.01
            harness.cursor.submit([harness.request("s\(index)", UInt32(101 + index), [CGPoint(x: 100 + Double(index) * 150, y: 300)])])
        }
        let cursors = harness.cursors()
        expect(cursors.count == AgentCursor.maxCursors, "at most \(AgentCursor.maxCursors) cursors live (\(cursors.count))")
        expect(!cursors.contains { $0.key.session == "s0" }, "the least recently active cursor is evicted")
        expect(harness.cursor.snapshot().evicted == 1, "the eviction is counted")
    }

    @MainActor
    private static func testIdleFadeAndLiveness() {
        let harness = Harness()
        harness.cursor.submit([harness.request("s1", 101, [CGPoint(x: 400, y: 300)]), harness.request("s2", 102, [CGPoint(x: 900, y: 300)])])
        harness.settle()
        let windows = Dictionary(uniqueKeysWithValues: harness.cursors().map { ($0.key.session, $0.windowNumber) })
        expect(harness.scheduler.count == 2, "each cursor has its own idle timer")
        harness.cursor.submit([harness.request("s1", 101, [CGPoint(x: 420, y: 300)])])
        harness.scheduler.fire(0)
        expect(harness.cursors().allSatisfy { !$0.fading }, "a stale idle timer does not fade the cursor")
        harness.scheduler.fire(1)
        expect(harness.cursors().first { $0.key.session == "s2" }?.fading == true, "s2's own idle timer fades only s2")
        expect(harness.cursors().first { $0.key.session == "s1" }?.fading == false, "s1 keeps showing")
        for _ in 0..<40 {
            harness.now += 1.0 / 120.0
            harness.cursor.tick(now: harness.now)
        }
        var cursors = harness.cursors()
        expect(cursors.count == 1 && cursors[0].key.session == "s1", "a faded cursor is removed")
        let closed = NSApplication.shared.windows.first { $0.windowNumber == windows["s2"] }
        expect(closed.map { !$0.isVisible } ?? true, "the removed cursor's window is not shown")
        harness.onscreen.removeAll { $0 == 101 }
        harness.now += AgentCursor.livenessInterval
        harness.cursor.tick(now: harness.now)
        cursors = harness.cursors()
        expect(cursors.isEmpty, "a cursor whose target window left the screen is removed at the next liveness check")
        let reasons = harness.cursor.snapshot().history.filter { $0.kind == "removed" }.compactMap(\.reason)
        expect(reasons == ["idle", "target_not_onscreen"], "removal reasons: \(reasons)")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String) {
        guard condition() else { fail(message()) }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }

    private static func segmentDistance(_ point: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x
        let dy = b.y - a.y
        let length = dx * dx + dy * dy
        let t = length == 0 ? 0 : max(0, min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
        return distance(point, CGPoint(x: a.x + t * dx, y: a.y + t * dy))
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

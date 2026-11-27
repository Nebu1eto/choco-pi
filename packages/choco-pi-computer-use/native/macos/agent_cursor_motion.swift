import CoreGraphics
import Foundation

@MainActor
final class AgentCursorRenderer {
	static let restHeading = AgentCursorArt.restHeading
	static let approachMinimum = 0.12
	static let approachMaximum = 0.30
	static let approachSpeed = 1500.0
	static let pathMinimum = 0.15
	static let pathMaximum = 0.60
	static let pathSpeed = 900.0

	private(set) var position = CGPoint.zero
	private(set) var isPlaced = false
	private(set) var heading: Double = AgentCursorArt.restHeading
	private(set) var isAnimating = false
	private(set) var target: CGPoint?

	private struct Segment {
		let path: PlannedPath
		let duration: Double
		let approach: Bool
	}

	private var segments: [Segment] = []
	private var segmentStart: Double = 0
	private var lastFrameTime: Double?

	func moveTo(point: CGPoint, now: Double) {
		move(along: [point], now: now)
	}

	func move(along points: [CGPoint], now: Double) {
		guard let first = points.first else { return }
		let endHeading = AgentCursorArt.restHeading
		let curved = planPath(PathRequest(
			x0: Double(position.x), y0: Double(position.y), th0: heading + .pi,
			x1: Double(first.x), y1: Double(first.y), th1: endHeading + .pi,
			radius: 80, endVisualHeading: endHeading, targetPoint: first))
		let straight = hypot(Double(first.x - position.x), Double(first.y - position.y))
		let approachPath = curved.length <= 1.6 * straight + 30 ? curved : PlannedPath(
			kind: .linear, length: max(1, straight), endVisualHeading: endHeading, targetPoint: first,
			x0: Double(position.x), y0: Double(position.y), th0: heading + .pi, radius: 80,
			seg1: 0, seg2: 0, seg3: 0, types: [], x1: Double(first.x), y1: Double(first.y), th1: endHeading + .pi)
		var planned = [Segment(
			path: approachPath,
			duration: min(Self.approachMaximum, max(Self.approachMinimum, approachPath.length / Self.approachSpeed)),
			approach: true
		)]
		var previous = first
		var drag: [PlannedPath] = []
		for point in points.dropFirst() {
			let length = max(0.001, hypot(Double(point.x - previous.x), Double(point.y - previous.y)))
			let direction = atan2(Double(point.y - previous.y), Double(point.x - previous.x))
			drag.append(PlannedPath(kind: .linear, length: length, endVisualHeading: endHeading, targetPoint: point,
				x0: Double(previous.x), y0: Double(previous.y), th0: direction, radius: 80,
				seg1: 0, seg2: 0, seg3: 0, types: [], x1: Double(point.x), y1: Double(point.y), th1: direction))
			previous = point
		}
		let dragLength = drag.reduce(0) { $0 + $1.length }
		if dragLength > 0 {
			let total = min(Self.pathMaximum, max(Self.pathMinimum, dragLength / Self.pathSpeed))
			for path in drag { planned.append(Segment(path: path, duration: total * path.length / dragLength, approach: false)) }
		}
		segments = planned
		segmentStart = now
		lastFrameTime = now
		target = points.last
		isAnimating = true
		isPlaced = true
	}

	func setInitialPosition(_ point: CGPoint, heading initialHeading: Double = AgentCursorArt.restHeading) {
		position = point
		heading = initialHeading
		isPlaced = true
		cancelAnimation()
	}

	func cancelAnimation() {
		segments = []
		lastFrameTime = nil
		isAnimating = false
	}

	@discardableResult
	func tick(now: Double) -> Bool {
		guard isAnimating else { return false }
		let dt = max(0, min(0.05, now - (lastFrameTime ?? now)))
		lastFrameTime = now
		while let segment = segments.first, now - segmentStart >= segment.duration {
			segmentStart += segment.duration
			segments.removeFirst()
			position = segment.path.targetPoint
		}
		guard let segment = segments.first else {
			if let target { position = target }
			heading = Self.restHeading
			segments = []
			lastFrameTime = nil
			isAnimating = false
			return true
		}
		let fraction = max(0, min(1, (now - segmentStart) / max(segment.duration, 0.001)))
		if segment.approach {
			let eased = 1 - pow(1 - fraction, 3)
			let state = segment.path.sample(at: eased * segment.path.length)
			position = CGPoint(x: state.pointX, y: state.pointY)
			heading = rotateToward(current: heading, desired: state.heading + .pi, maxStep: 14 * dt)
		} else {
			let state = segment.path.sample(at: fraction * segment.path.length)
			position = CGPoint(x: state.pointX, y: state.pointY)
			heading = rotateToward(current: heading, desired: Self.restHeading, maxStep: 14 * dt)
		}
		return false
	}

	private func rotateToward(current: Double, desired: Double, maxStep: Double) -> Double {
		var difference = desired - current
		while difference > .pi { difference -= 2 * .pi }
		while difference < -.pi { difference += 2 * .pi }
		return current + max(-maxStep, min(maxStep, difference))
	}
}

struct DubinsPlannedPath {
    enum Kind { case dubins, linear }
    let kind: Kind
    let length: Double
    let endVisualHeading: Double
    let targetPoint: CGPoint
    let x0, y0, th0, radius, seg1, seg2, seg3: Double
    let types: [Character]
    let x1, y1, th1: Double

    struct State { let pointX, pointY, heading: Double }

    func sample(at arcLength: Double) -> State {
        switch kind { case .linear: return sampleLinear(arcLength); case .dubins: return sampleDubins(arcLength) }
    }

    private func sampleLinear(_ arcLength: Double) -> State {
        let progress = max(0, min(1, arcLength / length))
        var diff = th1 - th0
        while diff > .pi  { diff -= 2 * .pi }
        while diff < -.pi { diff += 2 * .pi }
        return State(pointX: x0 + (x1 - x0) * progress, pointY: y0 + (y1 - y0) * progress, heading: th0 + diff * progress)
    }

    private func sampleDubins(_ sIn: Double) -> State {
        guard sIn > 0 else { return State(pointX: x0, pointY: y0, heading: th0) }
        let L1 = seg1 * radius, L2 = seg2 * radius, L3 = seg3 * radius
        let arcLength = min(sIn, L1 + L2 + L3)
        var pointX = x0, pointY = y0, th = th0

        func advance(length segmentLength: Double, type: Character) {
            if type == "S" { pointX += cos(th) * segmentLength; pointY += sin(th) * segmentLength }
            else {
                let dth = segmentLength / radius * (type == "L" ? 1.0 : -1.0)
                let perp: Double = (type == "L") ? .pi / 2 : -.pi / 2
                let cx = pointX + cos(th + perp) * radius, cy = pointY + sin(th + perp) * radius
                let ang = atan2(pointY - cy, pointX - cx)
                pointX = cx + cos(ang + dth) * radius; pointY = cy + sin(ang + dth) * radius; th += dth
            }
        }
        if arcLength <= L1 { advance(length: arcLength, type: types[0]); return State(pointX: pointX, pointY: pointY, heading: th) }
        advance(length: L1, type: types[0])
        if arcLength <= L1 + L2 { advance(length: arcLength - L1, type: types[1]); return State(pointX: pointX, pointY: pointY, heading: th) }
        advance(length: L2, type: types[1])
        advance(length: arcLength - L1 - L2, type: types[2])
        return State(pointX: pointX, pointY: pointY, heading: th)
    }
}

private typealias PlannedPath = DubinsPlannedPath

private func mod2pi(_ angle: Double) -> Double {
    let tau = 2 * Double.pi; let wrapped = angle - tau * floor(angle / tau); return wrapped < 0 ? wrapped + tau : wrapped
}

private struct DubinsSolution {
    let first, middle, last: Double; let types: [Character]; var length: Double { first + middle + last }
}

private func dubinsLSL(_ dist: Double, _ alpha: Double, _ beta: Double) -> DubinsSolution? {
    let tmp0 = dist + sin(alpha) - sin(beta)
    let p2 = 2 + dist * dist - 2 * cos(alpha - beta) + 2 * dist * (sin(alpha) - sin(beta))
    guard p2 >= 0 else { return nil }
    let tmp1 = atan2(cos(beta) - cos(alpha), tmp0)
    return DubinsSolution(first: mod2pi(-alpha + tmp1), middle: sqrt(p2), last: mod2pi(beta - tmp1), types: ["L","S","L"])
}
private func dubinsRSR(_ dist: Double, _ alpha: Double, _ beta: Double) -> DubinsSolution? {
    let tmp0 = dist - sin(alpha) + sin(beta)
    let p2 = 2 + dist * dist - 2 * cos(alpha - beta) + 2 * dist * (sin(beta) - sin(alpha))
    guard p2 >= 0 else { return nil }
    let tmp1 = atan2(cos(alpha) - cos(beta), tmp0)
    return DubinsSolution(first: mod2pi(alpha - tmp1), middle: sqrt(p2), last: mod2pi(-beta + tmp1), types: ["R","S","R"])
}
private func dubinsLSR(_ dist: Double, _ alpha: Double, _ beta: Double) -> DubinsSolution? {
    let p2 = -2 + dist * dist + 2 * cos(alpha - beta) + 2 * dist * (sin(alpha) + sin(beta))
    guard p2 >= 0 else { return nil }
    let middle = sqrt(p2)
    let tmp1 = atan2(-cos(alpha) - cos(beta), dist + sin(alpha) + sin(beta)) - atan2(-2, middle)
    return DubinsSolution(first: mod2pi(-alpha + tmp1), middle: middle, last: mod2pi(-mod2pi(beta) + tmp1), types: ["L","S","R"])
}
private func dubinsRSL(_ dist: Double, _ alpha: Double, _ beta: Double) -> DubinsSolution? {
    let p2 = dist * dist - 2 + 2 * cos(alpha - beta) - 2 * dist * (sin(alpha) + sin(beta))
    guard p2 >= 0 else { return nil }
    let middle = sqrt(p2)
    let tmp1 = atan2(cos(alpha) + cos(beta), dist - sin(alpha) - sin(beta)) - atan2(2, middle)
    return DubinsSolution(first: mod2pi(alpha - tmp1), middle: middle, last: mod2pi(beta - tmp1), types: ["R","S","L"])
}
private func dubinsRLR(_ dist: Double, _ alpha: Double, _ beta: Double) -> DubinsSolution? {
    let tmp = (6 - dist * dist + 2 * cos(alpha - beta) + 2 * dist * (sin(alpha) - sin(beta))) / 8
    guard abs(tmp) <= 1 else { return nil }
    let middle = mod2pi(2 * .pi - acos(tmp))
    let first = mod2pi(alpha - atan2(cos(alpha) - cos(beta), dist - sin(alpha) + sin(beta)) + middle / 2)
    return DubinsSolution(first: first, middle: middle, last: mod2pi(alpha - beta - first + middle), types: ["R","L","R"])
}
private func dubinsLRL(_ dist: Double, _ alpha: Double, _ beta: Double) -> DubinsSolution? {
    let tmp = (6 - dist * dist + 2 * cos(alpha - beta) + 2 * dist * (sin(beta) - sin(alpha))) / 8
    guard abs(tmp) <= 1 else { return nil }
    let middle = mod2pi(2 * .pi - acos(tmp))
    let first = mod2pi(-alpha + atan2(-cos(alpha) + cos(beta), dist + sin(alpha) - sin(beta)) + middle / 2)
    return DubinsSolution(first: first, middle: middle, last: mod2pi(mod2pi(beta) - alpha - first + middle), types: ["L","R","L"])
}

private struct PathRequest {
    let x0, y0, th0: Double
    let x1, y1, th1: Double
    let radius: Double
    let endVisualHeading: Double
    let targetPoint: CGPoint
}

private func planPath(_ request: PathRequest) -> PlannedPath {
    if let planned = planDubins(request) {
        return planned
    }
    let distance = max(1, hypot(request.x1 - request.x0, request.y1 - request.y0))
    return PlannedPath(kind: .linear, length: distance, endVisualHeading: request.endVisualHeading,
                       targetPoint: request.targetPoint, x0: request.x0, y0: request.y0, th0: request.th0,
                       radius: request.radius, seg1: 0, seg2: 0, seg3: 0, types: [],
                       x1: request.x1, y1: request.y1, th1: request.th1)
}

private func planDubins(_ request: PathRequest) -> PlannedPath? {
    let dx = request.x1 - request.x0, dy = request.y1 - request.y0, distance = hypot(dx, dy)
    guard distance > 0.5 else { return nil }
    let dist = distance / request.radius, theta = mod2pi(atan2(dy, dx))
    let alpha = mod2pi(request.th0 - theta), beta = mod2pi(request.th1 - theta)
    let solvers: [(Double, Double, Double) -> DubinsSolution?] = [
        dubinsLSL, dubinsRSR, dubinsLSR, dubinsRSL, dubinsRLR, dubinsLRL,
    ]
    var best: DubinsSolution?; var bestLen = Double.infinity
    for solver in solvers {
        if let sol = solver(dist, alpha, beta), sol.length.isFinite, sol.length >= 0, sol.length < bestLen {
            bestLen = sol.length; best = sol
        }
    }
    guard let solution = best else { return nil }
    return PlannedPath(kind: .dubins, length: (solution.first + solution.middle + solution.last) * request.radius,
                       endVisualHeading: request.endVisualHeading, targetPoint: request.targetPoint,
                       x0: request.x0, y0: request.y0, th0: request.th0, radius: request.radius,
                       seg1: solution.first, seg2: solution.middle, seg3: solution.last, types: solution.types,
                       x1: request.x1, y1: request.y1, th1: request.th1)
}

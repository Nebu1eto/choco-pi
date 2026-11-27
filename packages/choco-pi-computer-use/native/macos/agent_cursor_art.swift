import AppKit

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

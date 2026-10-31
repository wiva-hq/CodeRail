// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Draws the Mac app's images from the C mark's geometry (design/brand/coderail-mark.svg):
//   swift icon.swift app out.png          the app icon: the mark on macOS's rounded square, 1024 px
//   swift icon.swift menubar <dir>        the menu bar's template image (one colour, as coderail-mark-mono.svg,
//                                         with the small cut's heavier ends): MenuBarIcon.png and @2x, 18 pt
import AppKit

// The mark in its 24-unit grid (y flipped): two rails sweep from 40° to 318° around (12.4, 11.48), the outer
// closing in, the inner opening out, both thinning, until they meet at the dot.
func drawMark(_ ctx: CGContext, scale s: Double, centre: CGPoint, rails: CGColor, dot dotColor: CGColor, heavy: Bool) {
  func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: centre.x + (x - 12) * s, y: centre.y - (y - 12) * s) }
  let cx = 12.4, cy = 11.48
  func rail(radius: (Double) -> Double, width: (Double) -> Double) -> CGPath {
    let n = 240
    let line: [(Double, Double)] = (0...n).map { i in
      let t = Double(i) / Double(n), a = (40 + 278 * t) * .pi / 180
      return (cx + radius(t) * cos(a), cy + radius(t) * sin(a))
    }
    var left: [CGPoint] = [], right: [CGPoint] = []
    for i in 0...n {
      let a = line[max(i - 1, 0)], b = line[min(i + 1, n)]
      let dx = b.0 - a.0, dy = b.1 - a.1, l = (dx * dx + dy * dy).squareRoot()
      let nx = -dy / l, ny = dx / l, w = width(Double(i) / Double(n)) / 2
      left.append(p(line[i].0 + nx * w, line[i].1 + ny * w))
      right.append(p(line[i].0 - nx * w, line[i].1 - ny * w))
    }
    let path = CGMutablePath()
    path.addLines(between: left + right.reversed())
    path.closeSubpath()
    return path
  }
  // The small cut keeps more of the rails' width toward their ends, and a bigger dot.
  let thin = heavy ? 1.3 : 2.0, thinInner = heavy ? 1.3 : 1.9
  ctx.setFillColor(rails)
  ctx.addPath(rail(radius: { 9.6 - 0.6 * $0 }, width: { 3.0 - thin * $0 }))
  ctx.addPath(rail(radius: { 5.0 + 3.85 * pow($0, 1.25) }, width: { 2.8 - thinInner * $0 }))
  ctx.fillPath()
  let dotAngle = 327 * Double.pi / 180, dotR = heavy ? 2.3 : 1.95
  let dot = p(cx + 9 * cos(dotAngle), cy + 9 * sin(dotAngle))
  ctx.setFillColor(dotColor)
  ctx.fillEllipse(in: CGRect(x: dot.x - dotR * s, y: dot.y - dotR * s, width: 2 * dotR * s, height: 2 * dotR * s))
}

/// A bitmap of exactly `px` pixels square, drawn by `draw` in pixel coordinates.
func png(_ px: Int, to path: String, _ draw: (CGContext) -> Void) {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw(NSGraphicsContext.current!.cgContext)
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let args = CommandLine.arguments
switch args.count == 3 ? args[1] : "" {
case "app":
  png(1024, to: args[2]) { ctx in
    // macOS icon grid: an 824 px body centred in 1024, corner radius ~185.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
    ctx.addPath(CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 185, cornerHeight: 185, transform: nil))
    ctx.setFillColor(NSColor(red: 0.094, green: 0.094, blue: 0.106, alpha: 1).cgColor)
    ctx.fillPath()
    ctx.restoreGState()
    drawMark(ctx, scale: 26, centre: CGPoint(x: 512, y: 512), rails: NSColor.white.cgColor,
             dot: NSColor(red: 0.290, green: 0.871, blue: 0.502, alpha: 1).cgColor, heavy: false)
  }
case "menubar":
  // A template image: black on clear, which macOS tints for the menu bar. The 24-unit grid fills the 18 pt square.
  for (scale, name) in [(1, "MenuBarIcon.png"), (2, "MenuBarIcon@2x.png")] {
    let px = 18 * scale
    png(px, to: "\(args[2])/\(name)") { ctx in
      drawMark(ctx, scale: Double(px) / 24, centre: CGPoint(x: Double(px) / 2, y: Double(px) / 2),
               rails: NSColor.black.cgColor, dot: NSColor.black.cgColor, heavy: true)
    }
  }
default:
  FileHandle.standardError.write("usage: swift icon.swift app <out.png> | menubar <dir>\n".data(using: .utf8)!)
  exit(1)
}

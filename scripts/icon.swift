// Build images/icon.png from images/logo.png (a transparent PNG):
//
//     swift scripts/icon.swift images/logo.png images/icon.png 256
//
// Crop a transparent logo to its content, pad it a little, and scale it to a square icon.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil)!
let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let w = img.width, h = img.height
let cs = CGColorSpaceCreateDeviceRGB()
var px = [UInt8](repeating: 0, count: w * h * 4)
let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))

var minX = w, minY = h, maxX = 0, maxY = 0
for y in 0..<h { for x in 0..<w where px[(y * w + x) * 4 + 3] > 12 {
    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
}}

let cut = ctx.makeImage()!
let side = max(maxX - minX, maxY - minY) + 1
let pad = side / 20
let crop = cut.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))!

let out = Int(args[3])!
let octx = CGContext(data: nil, width: out, height: out, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
octx.interpolationQuality = .high
let scale = Double(out) / Double(side + 2 * pad)
let dw = Double(crop.width) * scale, dh = Double(crop.height) * scale
octx.draw(crop, in: CGRect(x: (Double(out) - dw) / 2, y: (Double(out) - dh) / 2, width: dw, height: dh))

let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, octx.makeImage()!, nil)
CGImageDestinationFinalize(dest)

// System CryptoKit only. No subprocesses, files, Keychain, networking or UI in this bridge.
import Foundation
import CryptoKit
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

private let packageLimit = 25 * 1024 * 1024
@_cdecl("neb_handoff_seal")
public func nebHandoffSeal(_ key: UnsafePointer<UInt8>?, _ nonce: UnsafePointer<UInt8>?, _ input: UnsafePointer<UInt8>?, _ length: Int, _ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int, _ written: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let key, let nonce, let output, let written, length >= 0, length <= packageLimit,
          capacity >= length + 33, length == 0 || input != nil else { return -1 }
    written.pointee = 0
    var plain = length == 0 ? Data() : Data(bytes: input!, count: length)
    defer { plain.resetBytes(in: plain.startIndex..<plain.endIndex) }
    do {
        let secret = SymmetricKey(data: Data(bytes: key, count: 32))
        let iv = try AES.GCM.Nonce(data: Data(bytes: nonce, count: 12))
        let box = try AES.GCM.seal(plain, using: secret, nonce: iv)
        let magic: [UInt8] = [0x4e, 0x45, 0x42, 0x48, 0x31]
        magic.withUnsafeBufferPointer { output.update(from: $0.baseAddress!, count: 5) }
        output.advanced(by: 5).update(from: nonce, count: 12)
        box.ciphertext.copyBytes(to: output.advanced(by: 17), count: length)
        box.tag.copyBytes(to: output.advanced(by: 17 + length), count: 16)
        written.pointee = length + 33
        return 0
    } catch { return -2 }
}
@_cdecl("neb_handoff_open")
public func nebHandoffOpen(_ key: UnsafePointer<UInt8>?, _ input: UnsafePointer<UInt8>?, _ length: Int, _ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int, _ written: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let key, let input, let output, let written, length >= 33, length <= packageLimit + 33,
          capacity >= length - 33, Array(UnsafeBufferPointer(start: input, count: 5)) == [0x4e, 0x45, 0x42, 0x48, 0x31] else { return -1 }
    written.pointee = 0
    do {
        let secret = SymmetricKey(data: Data(bytes: key, count: 32))
        let nonce = try AES.GCM.Nonce(data: Data(bytes: input.advanced(by: 5), count: 12))
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: Data(bytes: input.advanced(by: 17), count: length - 33), tag: Data(bytes: input.advanced(by: length - 16), count: 16))
        var plain = try AES.GCM.open(box, using: secret)
        defer { plain.resetBytes(in: plain.startIndex..<plain.endIndex) }
        plain.copyBytes(to: output, count: plain.count)
        written.pointee = plain.count
        return 0
    } catch { return -2 }
}

// `op=0` resizes for the brief; `op=1` irreversibly covers a sender-selected rectangle.
// Pixel coordinates use image top-left, matching the preview and shared package schema.
@_cdecl("neb_handoff_image")
public func nebHandoffImage(_ input: UnsafePointer<UInt8>?, _ length: Int, _ op: Int32, _ left: Int, _ top: Int, _ right: Int, _ bottom: Int, _ maxSide: Int, _ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int, _ written: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let input, let output, let written, length > 0, length <= 10 * 1024 * 1024,
          op == 0 || op == 1, capacity > 0, maxSide > 0, maxSide <= 2400 else { return -1 }
    written.pointee = 0
    let data = Data(bytes: input, count: length)
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 10000, height <= 10000, width * height <= 16_000_000,
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
          image.width == width, image.height == height else { return -2 }
    let scale = min(1.0, Double(maxSide) / Double(max(width, height)))
    let w = max(1, Int((Double(width) * scale).rounded()))
    let h = max(1, Int((Double(height) * scale).rounded()))
    guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return -3 }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    if op == 1 {
        guard left >= 0, top >= 0, right > left, bottom > top, right <= width, bottom <= height else { return -1 }
        context.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1))
        let x = floor(Double(left) * scale), y = floor(Double(height - bottom) * scale)
        context.fill(CGRect(x: x, y: y, width: ceil(Double(right) * scale) - x, height: ceil(Double(height - top) * scale) - y))
    }
    guard let result = context.makeImage() else { return -3 }
    let encoded = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil) else { return -3 }
    CGImageDestinationAddImage(destination, result, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination), encoded.length <= capacity else { return -4 }
    output.update(from: encoded.bytes.assumingMemoryBound(to: UInt8.self), count: encoded.length)
    written.pointee = encoded.length
    return 0
}

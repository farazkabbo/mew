// Apple SDK only. No UI, permission requests, files, network, content logging or JS bridge.
import Foundation
import CoreGraphics
import CoreVideo
import ScreenCaptureKit
import Vision
import ImageIO
import UniformTypeIdentifiers
import Darwin

private let maxSide = 16_384
private let maxBytes = 128 * 1024 * 1024
private let maxOutput = 16 * 1024 * 1024
private let nativeGate = DispatchSemaphore(value: 1)
typealias CaptureGuard = @convention(c) (UnsafeMutableRawPointer?) -> Int32
typealias CaptureBytes = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int, UInt32, UInt32, UInt32) -> Void

// No borrowed caller pointers enter an Apple completion. A timed-out object is discarded.
private final class Completion<Value>: @unchecked Sendable {
    let ready = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var value: Value?
    private var abandoned = false
    func finish(_ value: Value?) {
        lock.lock()
        if !abandoned { self.value = value }
        lock.unlock()
        nativeGate.signal()
        ready.signal()
    }
    func wait(timeoutMilliseconds: Int = 2500) -> (Int32, Value?) {
        let completed = ready.wait(timeout: .now() + .milliseconds(timeoutMilliseconds)) == .success
        lock.lock()
        defer { lock.unlock() }
        abandoned = true
        defer { value = nil }
        return completed ? (value == nil ? 4 : 0, value) : (5, nil)
    }
}

private func size(_ width: UInt32, _ height: UInt32, _ channels: UInt32, _ length: Int,
                  allowed: [UInt32], side: Int = maxSide) -> Int? {
    guard width > 0, height > 0, width <= side, height <= side,
          allowed.contains(channels), length >= 0 else { return nil }
    let count = Int(width) * Int(height) * Int(channels)
    return count <= maxBytes && count == length ? count : nil
}

private func wipedBuffer(_ count: Int, _ use: (UnsafeMutableRawPointer) -> Int32) -> Int32 {
    guard count > 0, count <= maxBytes else { return 9 }
    let pointer = UnsafeMutableRawPointer.allocate(byteCount: count, alignment: 16)
    pointer.initializeMemory(as: UInt8.self, repeating: 0, count: count)
    defer { _ = memset_s(pointer, count, 0, count); pointer.deallocate() }
    return use(pointer)
}

private func validRect(_ rect: CGRect) -> Bool {
    [rect.minX, rect.minY, rect.width, rect.height].allSatisfy { $0.isFinite } &&
        rect.width > 0 && rect.height > 0 && rect.width <= CGFloat(maxSide) && rect.height <= CGFloat(maxSide)
}

private func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX-b.minX) < 0.01 && abs(a.minY-b.minY) < 0.01 &&
        abs(a.width-b.width) < 0.01 && abs(a.height-b.height) < 0.01
}

// Exact-ID metadata only, never window titles or accessibility text.
private func targetStillBound(_ kind: UInt32, _ id: UInt32, _ pid: Int32, _ bounds: CGRect) -> Bool {
    if kind == 2 {
        return pid == 0 && CGDisplayIsActive(id) != 0 && sameRect(CGDisplayBounds(id), bounds)
    }
    guard kind == 1, pid > 0, pid != getpid(),
          let array = CGWindowListCreateDescriptionFromArray([NSNumber(value: id)] as CFArray) as? [[String: Any]],
          array.count == 1, let item = array.first,
          (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id,
          (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
          let sharing = (item[kCGWindowSharingState as String] as? NSNumber)?.intValue, sharing > 0,
          let dictionary = item[kCGWindowBounds as String] as? [String: Any],
          let current = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { return false }
    return sameRect(current, bounds)
}

@_cdecl("neb_capture_permission")
func nebCapturePermission() -> Int32 { CGPreflightScreenCaptureAccess() ? 1 : 0 }

@_cdecl("neb_capture_once")
func nebCaptureOnce(_ kind: UInt32, _ id: UInt32, _ pid: Int32,
                    _ x: Double, _ y: Double, _ width: Double, _ height: Double,
                    _ check: CaptureGuard?, _ checkContext: UnsafeMutableRawPointer?,
                    _ output: CaptureBytes?, _ outputContext: UnsafeMutableRawPointer?) -> Int32 {
    guard #available(macOS 14.0, *) else { return 7 }
    guard !Thread.isMainThread else { return 8 }
    let bounds = CGRect(x: x, y: y, width: width, height: height)
    guard id != 0, (kind == 1 || kind == 2), validRect(bounds),
          let check, let output else { return 1 }
    guard check(checkContext) == 1 else { return 6 }
    guard CGPreflightScreenCaptureAccess() else { return 2 }
    guard targetStillBound(kind, id, pid, bounds) else { return 3 }
    guard nativeGate.wait(timeout: .now()) == .success else { return 8 }
    let metadata = Completion<SCShareableContent>()
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
        metadata.finish(content)
    }
    let (metadataStatus, content) = metadata.wait()
    guard metadataStatus == 0, let content else { return metadataStatus }
    let filter: SCContentFilter
    if kind == 1 {
        guard let window = content.windows.first(where: { $0.windowID == id }), window.isOnScreen,
              let app = window.owningApplication, app.processID == pid,
              app.processID != getpid(), !app.bundleIdentifier.isEmpty,
              sameRect(window.frame, bounds) else { return 3 }
        // desktopIndependentWindow captures exactly this window, with no overlapping Neb UI.
        filter = SCContentFilter(desktopIndependentWindow: window)
    } else {
        guard let display = content.displays.first(where: { $0.displayID == id }),
              sameRect(display.frame, bounds) else { return 3 }
        // Exclude the entire current process, including future overlays, from our display frame.
        let ownApps = content.applications.filter { $0.processID == getpid() }
        guard ownApps.count == 1 else { return 3 }
        filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
    }
    let scale = Double(filter.pointPixelScale)
    guard scale.isFinite, scale >= 1, scale <= 4 else { return 3 }
    let pixelWidth = Int(ceil(width * scale)), pixelHeight = Int(ceil(height * scale))
    guard pixelWidth > 0, pixelHeight > 0, pixelWidth <= maxSide, pixelHeight <= maxSide,
          pixelWidth * pixelHeight * 4 <= maxBytes else { return 9 }
    let config = SCStreamConfiguration()
    config.width = pixelWidth
    config.height = pixelHeight
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.showsCursor = false
    config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    config.captureResolution = .best
    guard check(checkContext) == 1 else { return 6 }
    guard CGPreflightScreenCaptureAccess() else { return 2 }
    guard targetStillBound(kind, id, pid, bounds) else { return 3 }
    guard nativeGate.wait(timeout: .now()) == .success else { return 8 }
    let screenshot = Completion<CGImage>()
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, _ in
        screenshot.finish(image)
    }
    let (status, image) = screenshot.wait()
    guard status == 0, let image else { return status }
    guard check(checkContext) == 1 else { return 6 }
    guard CGPreflightScreenCaptureAccess() else { return 2 }
    guard targetStillBound(kind, id, pid, bounds), image.width == pixelWidth,
          image.height == pixelHeight else { return 3 }
    return autoreleasepool {
        wipedBuffer(pixelWidth * pixelHeight * 4) { pointer in
            guard let context = CGContext(data: pointer, width: pixelWidth, height: pixelHeight,
                bitsPerComponent: 8, bytesPerRow: pixelWidth * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)
                else { return 4 }
            context.draw(image, in: CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
            guard check(checkContext) == 1 else { return 6 }
            guard CGPreflightScreenCaptureAccess(), targetStillBound(kind, id, pid, bounds) else { return 3 }
            output(outputContext, pointer.assumingMemoryBound(to: UInt8.self), pixelWidth * pixelHeight * 4,
                   UInt32(pixelWidth), UInt32(pixelHeight), 4)
            return 0
        }
    }
}

// The provider borrows the caller's immutable memory only for this synchronous scope.
private func borrowedImage(_ bytes: UnsafePointer<UInt8>, _ count: Int, _ width: UInt32,
                           _ height: UInt32, _ channels: UInt32) -> CGImage? {
    guard let provider = CGDataProvider(dataInfo: nil, data: bytes, size: count, releaseData: { _, _, _ in }) else { return nil }
    let gray = channels == 1
    let info = gray ? CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue) :
        CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)
    return CGImage(width: Int(width), height: Int(height), bitsPerComponent: 8,
        bitsPerPixel: Int(channels) * 8, bytesPerRow: Int(width * channels),
        space: gray ? CGColorSpaceCreateDeviceGray() : CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

@_cdecl("neb_ocr_read")
func nebOcrRead(_ bytes: UnsafePointer<UInt8>?, _ length: Int, _ width: UInt32,
                _ height: UInt32, _ channels: UInt32, _ output: CaptureBytes?,
                _ outputContext: UnsafeMutableRawPointer?) -> Int32 {
    guard !Thread.isMainThread else { return 8 }
    guard let bytes, let output,
          let count = size(width, height, channels, length, allowed: [1, 4], side: 2560) else { return 1 }
    return autoreleasepool {
        guard let image = borrowedImage(bytes, count, width, height, channels) else { return 4 }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) }
        catch { return 4 }
        guard let observations = request.results, observations.count <= 8192 else { return 9 }
        var lines: [[String: Any]] = []
        var textBytes = 0
        for observation in observations {
            guard let text = observation.topCandidates(1).first else { return 4 }
            let rect = observation.boundingBox
            guard rect.minX.isFinite, rect.minY.isFinite, rect.width.isFinite, rect.height.isFinite,
                  rect.minX >= 0, rect.minY >= 0, rect.maxX <= 1.001, rect.maxY <= 1.001 else { return 4 }
            textBytes += text.string.utf8.count
            guard textBytes <= 2 * 1024 * 1024 else { return 9 }
            lines.append(["words": [["text": text.string,
                "x": max(0, rect.minX * Double(width)),
                "y": max(0, (1 - rect.maxY) * Double(height)),
                "width": min(1, rect.width) * Double(width),
                "height": min(1, rect.height) * Double(height)]]])
        }
        guard var encoded = try? JSONSerialization.data(withJSONObject: ["lines": lines]),
              encoded.count <= 4 * 1024 * 1024 else { return 9 }
        defer { encoded.withUnsafeMutableBytes { raw in
            if let base = raw.baseAddress { _ = memset_s(base, raw.count, 0, raw.count) }
        } }
        // Mutable owned copy is zeroed; Foundation/Vision internal objects release at pool exit.
        return wipedBuffer(encoded.count) { pointer in
            encoded.copyBytes(to: pointer.assumingMemoryBound(to: UInt8.self), count: encoded.count)
            output(outputContext, pointer.assumingMemoryBound(to: UInt8.self), encoded.count, width, height, 0)
            return 0
        }
    }
}

@_cdecl("neb_jpeg_encode")
func nebJpegEncode(_ bytes: UnsafePointer<UInt8>?, _ length: Int, _ width: UInt32,
                   _ height: UInt32, _ channels: UInt32, _ quality: Double,
                   _ output: CaptureBytes?, _ outputContext: UnsafeMutableRawPointer?) -> Int32 {
    guard !Thread.isMainThread else { return 8 }
    guard let bytes, let output, quality.isFinite, (0...1).contains(quality),
          size(width, height, channels, length, allowed: [3, 4]) != nil else { return 1 }
    return autoreleasepool {
        // BGR is expanded into an explicitly wiped BGRA buffer. No ambiguous RGB ordering.
        wipedBuffer(Int(width) * Int(height) * 4) { pointer in
            let bgra = pointer.assumingMemoryBound(to: UInt8.self)
            for pixel in 0..<(Int(width) * Int(height)) {
                bgra[pixel*4] = bytes[pixel*Int(channels)]
                bgra[pixel*4+1] = bytes[pixel*Int(channels)+1]
                bgra[pixel*4+2] = bytes[pixel*Int(channels)+2]
                bgra[pixel*4+3] = 255
            }
            guard let image = borrowedImage(UnsafePointer(bgra), Int(width) * Int(height) * 4, width, height, 4)
                else { return 4 }
            return wipedBuffer(maxOutput) { encoded in
                let sink = JpegSink(encoded)
                var callbacks = CGDataConsumerCallbacks(putBytes: { context, bytes, count in
                    guard let context else { return 0 }
                    let sink = Unmanaged<JpegSink>.fromOpaque(context).takeUnretainedValue()
                    guard count > 0, count <= maxOutput - sink.count else { sink.overflow = true; return 0 }
                    sink.pointer.advanced(by: sink.count).copyMemory(from: bytes, byteCount: count)
                    sink.count += count
                    return count
                }, releaseConsumer: { _ in })
                guard let consumer = CGDataConsumer(info: Unmanaged.passUnretained(sink).toOpaque(), cbks: &callbacks),
                      let destination = CGImageDestinationCreateWithDataConsumer(consumer, UTType.jpeg.identifier as CFString, 1, nil)
                    else { return 4 }
                CGImageDestinationAddImage(destination, image,
                    [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                let success = CGImageDestinationFinalize(destination)
                guard !sink.overflow else { return 9 }
                guard success, sink.count > 0 else { return 4 }
                output(outputContext, encoded.assumingMemoryBound(to: UInt8.self), sink.count, width, height, 0)
                return 0
            }
        }
    }
}

private final class JpegSink {
    let pointer: UnsafeMutableRawPointer
    var count = 0
    var overflow = false
    init(_ pointer: UnsafeMutableRawPointer) { self.pointer = pointer }
}

#if NEB_NATIVE_TESTS
// Pure validation checks; never query permissions, metadata or screenshots.
@_cdecl("neb_capture_test_validation")
func nebCaptureTestValidation() -> Int32 {
    var failures: Int32 = 0
    func expect(_ condition: Bool) { if !condition { failures += 1 } }
    expect(size(1, 1, 4, 4, allowed: [4]) == 4)
    expect(size(0, 1, 4, 0, allowed: [4]) == nil)
    expect(size(UInt32.max, UInt32.max, 4, 0, allowed: [4]) == nil)
    expect(size(16_384, 16_384, 4, 1_073_741_824, allowed: [4]) == nil)
    expect(size(2, 2, 4, 15, allowed: [4]) == nil)
    expect(size(2, 2, 3, 12, allowed: [1,4]) == nil)
    expect(size(2561, 1, 1, 2561, allowed: [1], side: 2560) == nil)
    expect(!validRect(CGRect(x: CGFloat.nan, y: 0, width: 1, height: 1)))
    expect(!validRect(CGRect(x: 0, y: 0, width: 0, height: 1)))
    expect(!validRect(CGRect(x: 0, y: 0, width: 1, height: CGFloat.infinity)))
    expect(validRect(CGRect(x: -1920, y: -800, width: 1920, height: 1080)))
    let a = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
    expect(sameRect(a, a))
    expect(!sameRect(a, a.offsetBy(dx: 1, dy: 0)))
    var observedWiped = false
    let result = wipedBuffer(16) { pointer in
        observedWiped = pointer.assumingMemoryBound(to: UInt8.self)[0] == 0
        pointer.assumingMemoryBound(to: UInt8.self)[0] = 42
        return 6
    }
    expect(result == 6 && observedWiped)
    expect(wipedBuffer(maxBytes+1) { _ in failures += 1; return 0 } == 9)
    // Exercise delivery and late-completion abandonment without any system requests.
    expect(nativeGate.wait(timeout: .now()) == .success)
    let delivered = Completion<Int>()
    delivered.finish(42)
    let (deliveredStatus, deliveredValue) = delivered.wait(timeoutMilliseconds: 0)
    expect(deliveredStatus == 0 && deliveredValue == 42)
    expect(nativeGate.wait(timeout: .now()) == .success)
    let late = Completion<Int>()
    let (timeoutStatus, timeoutValue) = late.wait(timeoutMilliseconds: 0)
    expect(timeoutStatus == 5 && timeoutValue == nil)
    late.finish(99)
    let (lateStatus, lateValue) = late.wait(timeoutMilliseconds: 0)
    expect(lateStatus == 4 && lateValue == nil)
    return failures
}
#endif

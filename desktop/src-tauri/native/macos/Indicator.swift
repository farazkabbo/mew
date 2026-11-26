// Owned, fixed-content capture indicator. This file never captures pixels or asks permission.
import AppKit
import Metal
import QuartzCore
import CoreGraphics
import Foundation

// This guard is the only state touched by Metal's callback. It has no AppKit references and
// no borrowed caller pointers. Once invalidated, no late callback can restore a proof.
final class IndicatorLease: @unchecked Sendable {
    let token: UInt64
    let created: CFTimeInterval
    private let lock = NSLock()
    private var invalid = false
    private var presented: CFTimeInterval?
    private var validating = false
    init(token: UInt64, now: CFTimeInterval) { self.token = token; created = now }
    @discardableResult func invalidate() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let changed = !invalid
        invalid = true
        return changed
    }
    func markPresented(token: UInt64, time: CFTimeInterval, now: CFTimeInterval) {
        lock.lock(); defer { lock.unlock() }
        guard !invalid, token == self.token, time.isFinite, now.isFinite,
              time >= created, time > 0, time <= now, now - created <= 2 else { return }
        presented = time
    }
    // 0 pending, 1 presented, -1 invalidated, -3 expired. Timeouts are terminal.
    func status(now: CFTimeInterval) -> Int32 {
        lock.lock(); defer { lock.unlock() }
        if invalid { return -1 }
        if !now.isFinite || now < created || now - created >= 15 ||
            (presented == nil && now - created >= 2) { invalid = true; return -3 }
        return presented == nil ? 0 : 1
    }
    func startValidation() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if invalid || validating { return false }
        validating = true; return true
    }
    func endValidation() { lock.lock(); validating = false; lock.unlock() }
}

final class IndicatorPool: @unchecked Sendable {
    private let lock = NSLock()
    private var active: IndicatorLease?
    private var highest: UInt64 = 0
    func acquire(_ token: UInt64) -> IndicatorLease? {
        lock.lock(); defer { lock.unlock() }
        guard active == nil, token > highest else { return nil }
        highest = token
        let lease = IndicatorLease(token: token, now: CACurrentMediaTime())
        active = lease
        return lease
    }
    func find(_ token: UInt64) -> IndicatorLease? {
        lock.lock(); defer { lock.unlock() }
        return active?.token == token ? active : nil
    }
    func release(_ lease: IndicatorLease) {
        lock.lock(); defer { lock.unlock() }
        if active === lease { active = nil }
    }
}
private let indicatorPool = IndicatorPool()
// Main thread only; retain until both the panel is closed and its GPU submission has finished.
private var indicatorSession: IndicatorSession?
private final class IndicatorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private func equalRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX-b.minX) < 0.01 && abs(a.minY-b.minY) < 0.01 &&
    abs(a.width-b.width) < 0.01 && abs(a.height-b.height) < 0.01
}
private func screenID(_ screen: NSScreen) -> CGDirectDisplayID? {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
}

private final class IndicatorSession {
    let lease: IndicatorLease
    let quartz: CGRect
    let panel: IndicatorPanel
    let layer: CAMetalLayer
    let display: CGDirectDisplayID
    let displayBounds: CGRect
    let frame: CGRect
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private var closed = false
    private var ordered = false
    private var renderFinished = true
    private var device: MTLDevice
    private var queue: MTLCommandQueue
    private var pipeline: MTLRenderPipelineState

    init?(lease: IndicatorLease, rect: CGRect) {
        precondition(Thread.isMainThread)
        guard lease.status(now: CACurrentMediaTime()) >= 0,
              let screen = NSScreen.screens.first(where: {
                  guard let id = screenID($0) else { return false }
                  return CGDisplayIsActive(id) != 0 && CGDisplayBounds(id).contains(rect)
              }), let id = screenID(screen), let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { fputs("[indicator] screen/device unavailable\n", stderr); return nil }
        // AppKit has an upward Y axis; CoreGraphics uses primary-display top-left coordinates.
        let frame = CGRect(x: rect.minX, y: CGDisplayBounds(CGMainDisplayID()).height - rect.maxY,
                           width: rect.width, height: rect.height)
        guard screen.frame.contains(frame) else { fputs("[indicator] coordinate frame unavailable\n", stderr); return nil }
        let source = """
        #include <metal_stdlib>
        using namespace metal;
        vertex float4 neb_indicator_vertex(uint id [[vertex_id]]) {
            const float2 p[3] = {float2(-1,-1),float2(3,-1),float2(-1,3)};
            return float4(p[id],0,1);
        }
        fragment float4 neb_indicator_border(float4 p [[position]], constant float2 &size [[buffer(0)]]) {
            float edge = min(min(p.x,p.y),min(size.x-p.x,size.y-p.y));
            return edge < 4.0 ? float4(1.0,0.08,0.08,1.0) : float4(0.0);
        }
        """
        let library: MTLLibrary
        do { library = try device.makeLibrary(source: source, options: nil) } catch { fputs("[indicator] fixed Metal program unavailable\n", stderr); return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "neb_indicator_vertex")
        descriptor.fragmentFunction = library.makeFunction(name: "neb_indicator_border")
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        let pipeline: MTLRenderPipelineState
        do { pipeline = try device.makeRenderPipelineState(descriptor: descriptor) } catch { fputs("[indicator] fixed Metal program unavailable\n", stderr); return nil }
        self.lease = lease; quartz = rect; self.frame = frame; display = id
        displayBounds = CGDisplayBounds(id)
        self.device = device; self.queue = queue; self.pipeline = pipeline
        panel = IndicatorPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.alphaValue = 1
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .statusBar // Below system security dialogs.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let view = NSView(frame: CGRect(origin: .zero, size: frame.size))
        view.wantsLayer = true
        layer = CAMetalLayer()
        layer.device = device
        layer.pixelFormat = .bgra8Unorm
        layer.isOpaque = false
        layer.framebufferOnly = true
        layer.presentsWithTransaction = false
        layer.allowsNextDrawableTimeout = true
        layer.maximumDrawableCount = 2
        layer.contentsScale = screen.backingScaleFactor
        layer.drawableSize = CGSize(width: frame.width * screen.backingScaleFactor,
                                    height: frame.height * screen.backingScaleFactor)
        layer.frame = view.bounds
        view.layer = layer
        panel.contentView = view
    }
    func show() {
        precondition(Thread.isMainThread)
        let center = NotificationCenter.default
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMoveNotification,
                     NSWindow.didResizeNotification, NSWindow.willCloseNotification,
                     NSWindow.didMiniaturizeNotification, NSWindow.didChangeScreenNotification] {
            observers.append(center.addObserver(forName: name, object: panel, queue: .main) { [weak self] _ in
                // AppKit can emit intermediate hidden/geometry notifications while ordering.
                // No proof exists at that stage; validate after the ordering turn instead.
                guard let self, self.ordered else { return }
                if !self.visible(requireOcclusion: self.lease.status(now: CACurrentMediaTime()) == 1) { self.close() }
            })
        }
        observers.append(center.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                             object: nil, queue: .main) { [weak self] _ in self?.close() })
        panel.orderFrontRegardless()
        ordered = true
        guard !closed else { return }
        // Visibility alone is not presentation. Only submit after AppKit reports a visible panel.
        // Retry once on the main run loop; all proof still comes from addPresentedHandler below.
        DispatchQueue.main.async { [weak self] in self?.render() }
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self else { return }
            let status=self.lease.status(now: CACurrentMediaTime())
            if status < 0 || !self.visible(requireOcclusion: status == 1) { self.close() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
    func visible(requireOcclusion: Bool = true) -> Bool {
        precondition(Thread.isMainThread)
        if closed || lease.status(now: CACurrentMediaTime()) < 0 { return false }
        if !panel.isVisible || panel.isMiniaturized || panel.alphaValue != 1 { fputs("[indicator] native window hidden\n", stderr); return false }
        if requireOcclusion && !panel.occlusionState.contains(.visible) { fputs("[indicator] native window occluded\n", stderr); return false }
        if !equalRect(panel.frame, frame) { fputs("[indicator] native window frame changed\n", stderr); return false }
        guard let screen=panel.screen, screenID(screen)==display,
            CGDisplayIsActive(display) != 0, equalRect(CGDisplayBounds(display),displayBounds),
            displayBounds.contains(quartz), screen.frame.contains(frame) else { fputs("[indicator] display changed\n", stderr); return false }
        guard panel.contentView?.layer === layer, !layer.isHidden, layer.opacity == 1,
            equalRect(layer.frame,CGRect(origin:.zero,size:frame.size)),
            layer.drawableSize.width>0,layer.drawableSize.height>0 else { fputs("[indicator] layer changed\n", stderr); return false }
        return indicatorPool.find(lease.token) === lease
    }
    private func render() {
        precondition(Thread.isMainThread)
        guard visible(requireOcclusion: false), let drawable = layer.nextDrawable(), let command = queue.makeCommandBuffer() else {
            close(); return
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { close(); return }
        encoder.setRenderPipelineState(pipeline)
        var dimensions = SIMD2<Float>(Float(drawable.texture.width), Float(drawable.texture.height))
        encoder.setFragmentBytes(&dimensions, length: MemoryLayout<SIMD2<Float>>.size, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        let lease = self.lease
        let token = lease.token
        drawable.addPresentedHandler { drawable in
            lease.markPresented(token: token, time: drawable.presentedTime, now: CACurrentMediaTime())
        }
        renderFinished = false
        command.addCompletedHandler { [weak self, lease] completed in
            if completed.status != .completed { lease.invalidate() }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.renderFinished = true
                if self.closed { self.release() }
            }
        }
        command.present(drawable)
        command.commit()
    }
    func close() {
        precondition(Thread.isMainThread)
        lease.invalidate()
        guard !closed else { return }
        closed = true
        timer?.invalidate(); timer = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        panel.orderOut(nil)
        panel.close()
        if renderFinished { release() }
    }
    private func release() {
        indicatorPool.release(lease)
        if indicatorSession === self { indicatorSession = nil }
    }
}

@_cdecl("neb_indicator_begin")
public func nebIndicatorBegin(_ token: UInt64, _ x: Double, _ y: Double,
                              _ width: Double, _ height: Double) -> Int32 {
    guard !Thread.isMainThread else { return -4 }
    guard token > 0, [x,y,width,height].allSatisfy({ $0.isFinite }),
          width >= 8, height >= 8, width <= 16384, height <= 16384 else { return -1 }
    guard let lease = indicatorPool.acquire(token) else { return -4 }
    let rect = CGRect(x: x, y: y, width: width, height: height)
    DispatchQueue.main.async {
        guard lease.status(now: CACurrentMediaTime()) >= 0,
              let session = IndicatorSession(lease: lease, rect: rect) else {
            lease.invalidate(); indicatorPool.release(lease); return
        }
        indicatorSession = session
        session.show()
    }
    return 0
}

@_cdecl("neb_indicator_poll")
public func nebIndicatorPoll(_ token: UInt64) -> Int32 {
    guard let lease = indicatorPool.find(token) else { return -1 }
    // Pending is never capture permission. Do not queue a synchronous visibility check
    // behind initial shader compilation: presentation has its own bounded two-second wait.
    let initial = lease.status(now: CACurrentMediaTime())
    if initial <= 0 { return initial }
    if Thread.isMainThread {
        guard lease.status(now: CACurrentMediaTime()) >= 0,
              let session = indicatorSession, session.lease === lease, session.visible() else {
            lease.invalidate()
            if indicatorSession?.lease === lease { indicatorSession?.close() }
            return -1
        }
        return lease.status(now: CACurrentMediaTime())
    }
    guard lease.startValidation() else { lease.invalidate(); return -4 }
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        defer { lease.endValidation(); done.signal() }
        guard let session = indicatorSession, session.lease === lease, session.visible() else {
            lease.invalidate()
            if indicatorSession?.lease === lease { indicatorSession?.close() }
            return
        }
    }
    guard done.wait(timeout: .now() + .milliseconds(100)) == .success else {
        lease.invalidate(); return -3
    }
    return lease.status(now: CACurrentMediaTime())
}

@_cdecl("neb_indicator_end")
public func nebIndicatorEnd(_ token: UInt64) {
    guard let lease = indicatorPool.find(token) else { return }
    // Queue cleanup only once; repeated end calls cannot flood the main queue.
    guard lease.invalidate() else { return }
    DispatchQueue.main.async {
        if indicatorSession?.lease === lease { indicatorSession?.close() }
        // If creation has not run yet, that owned closure observes the invalid lease and releases.
    }
}

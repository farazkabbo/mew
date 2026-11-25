//! The cursor layer (docs/CURSOR_MODES.md, D): what SHOW ME, DO IT's replay and CATCH ME draw
//! near the student's cursor, rendered with Direct2D onto a DirectComposition swap chain.
//!
//! One window per monitor that has something on it: popup, layered and transparent (every click
//! goes through to the app underneath), topmost, never activated, hidden from Alt+Tab, and kept
//! out of screen captures unless the student lets overlays show in them. The window is created
//! when a scene first reaches its monitor and hidden when it has nothing to show. Scenes arrive
//! from the engine thread; a frame is drawn only when the scene changed, and Present waits for
//! the monitor's refresh, so an animation runs at the refresh rate and a still scene costs
//! nothing.
//!
//! The layer never moves the cursor, never takes the focus and never sees a click.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Once;
use std::time::{Duration, Instant};

use windows::core::{w, Interface, BOOL};
use windows::Win32::Foundation::{COLORREF, HMODULE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_FIGURE_BEGIN_HOLLOW, D2D1_FIGURE_END_OPEN,
    D2D1_PIXEL_FORMAT, D2D_RECT_F,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1DeviceContext, ID2D1Factory1, ID2D1RenderTarget, ID2D1StrokeStyle,
    D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_TARGET,
    D2D1_BITMAP_PROPERTIES1, D2D1_CAP_STYLE_ROUND, D2D1_DASH_STYLE_CUSTOM,
    D2D1_DEVICE_CONTEXT_OPTIONS_NONE, D2D1_DRAW_TEXT_OPTIONS_CLIP, D2D1_ELLIPSE,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_LINE_JOIN_ROUND, D2D1_QUADRATIC_BEZIER_SEGMENT,
    D2D1_ROUNDED_RECT, D2D1_STROKE_STYLE_PROPERTIES,
};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, DWRITE_FACTORY_TYPE_SHARED,
    DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_SEMI_BOLD,
    DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_CENTER,
    DWRITE_WORD_WRAPPING_NO_WRAP,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, IDXGIDevice, IDXGIFactory2, IDXGISurface, IDXGISwapChain1,
    DXGI_CREATE_FACTORY_FLAGS, DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1,
    DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
    RegisterClassExW, SetLayeredWindowAttributes, SetWindowDisplayAffinity, ShowWindow,
    TranslateMessage, LWA_ALPHA, MSG, PM_REMOVE, SW_HIDE, SW_SHOWNOACTIVATE,
    WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use windows_numerics::Vector2;

use crate::screen::cursor::scene::{intersects, scaled, Scene, Shape, CAPTION_H};
use crate::screen::frame::ScreenRect;

static REGISTER: Once = Once::new();
const CLASS: windows::core::PCWSTR = w!("MewCursorLayer");

enum Msg {
    Scene(Scene),
    Captures(bool),
}

/// The running layer. Dropping it closes every window.
pub struct CursorLayer {
    sender: Sender<Msg>,
}

impl CursorLayer {
    /// Starts the layer thread (windows are made when there's something to show).
    pub fn start(show_in_captures: bool) -> Option<Self> {
        let (sender, receiver) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        std::thread::Builder::new()
            .name("mew-cursor-layer".into())
            .spawn(move || match Gfx::new() {
                Ok(gfx) => {
                    let _ = ready.send(true);
                    run(gfx, receiver, show_in_captures);
                }
                Err(error) => {
                    eprintln!("[cursor] layer unavailable ({:#x})", error.code().0);
                    let _ = ready.send(false);
                }
            })
            .ok()?;
        started
            .recv_timeout(Duration::from_secs(3))
            .ok()?
            .then_some(Self { sender })
    }

    /// Shows `scene` (replacing whatever was shown).
    pub fn show(&self, scene: Scene) {
        let _ = self.sender.send(Msg::Scene(scene));
    }

    pub fn clear(&self) {
        self.show(Scene::default());
    }

    pub fn set_shown_in_captures(&self, shown: bool) {
        let _ = self.sender.send(Msg::Captures(shown));
    }
}

/// Device-independent pieces, made once per layer thread.
struct Gfx {
    d3d: ID3D11Device,
    factory: ID2D1Factory1,
    dc: ID2D1DeviceContext,
    dxgi_factory: IDXGIFactory2,
    dcomp: IDCompositionDevice,
    dwrite: IDWriteFactory,
    dots: ID2D1StrokeStyle,
    round: ID2D1StrokeStyle,
}

impl Gfx {
    fn new() -> windows::core::Result<Self> {
        // SAFETY: standard Direct3D/Direct2D/DirectComposition creation with out values this
        // function owns; every interface is released when dropped.
        unsafe {
            let mut d3d = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut d3d),
                None,
                None,
            )?;
            let d3d = d3d.ok_or_else(windows::core::Error::empty)?;
            let dxgi: IDXGIDevice = d3d.cast()?;
            let factory: ID2D1Factory1 =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let dc = factory
                .CreateDevice(&dxgi)?
                .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
            let dxgi_factory: IDXGIFactory2 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))?;
            let dcomp: IDCompositionDevice = DCompositionCreateDevice(&dxgi)?;
            let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            let (dots, round) = stroke_styles(&factory)?;
            Ok(Self {
                d3d,
                factory,
                dc,
                dxgi_factory,
                dcomp,
                dwrite,
                dots,
                round,
            })
        }
    }
}

/// Round-dotted (the ghost path) and plain round-capped strokes.
pub fn stroke_styles(
    factory: &ID2D1Factory1,
) -> windows::core::Result<(ID2D1StrokeStyle, ID2D1StrokeStyle)> {
    let props = |dash| D2D1_STROKE_STYLE_PROPERTIES {
        startCap: D2D1_CAP_STYLE_ROUND,
        endCap: D2D1_CAP_STYLE_ROUND,
        dashCap: D2D1_CAP_STYLE_ROUND,
        lineJoin: D2D1_LINE_JOIN_ROUND,
        miterLimit: 1.0,
        dashStyle: dash,
        dashOffset: 0.0,
    };
    let base: windows::Win32::Graphics::Direct2D::ID2D1Factory = factory.cast()?;
    // SAFETY: plain factory calls with properties built here.
    unsafe {
        let dots = base.CreateStrokeStyle(&props(D2D1_DASH_STYLE_CUSTOM), Some(&[0.0, 2.6]))?;
        let round = base.CreateStrokeStyle(
            &props(windows::Win32::Graphics::Direct2D::D2D1_DASH_STYLE_SOLID),
            None,
        )?;
        Ok((dots, round))
    }
}

/// One monitor's window and swap chain.
struct Surface {
    monitor: ScreenRect,
    scale: f32,
    hwnd: HWND,
    swap: IDXGISwapChain1,
    _target: IDCompositionTarget,
    _visual: IDCompositionVisual,
    shown: bool,
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: a window this thread created, destroyed once.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

fn run(gfx: Gfx, receiver: Receiver<Msg>, mut show_in_captures: bool) {
    let mut surfaces: Vec<Surface> = Vec::new();
    let mut monitors: Vec<(ScreenRect, f32)> = Vec::new();
    let mut monitors_at = Instant::now() - Duration::from_secs(10);
    let mut scene = Scene::default();
    let mut dirty = false;
    loop {
        pump();
        match receiver.recv_timeout(Duration::from_millis(if dirty { 0 } else { 50 })) {
            Ok(Msg::Scene(s)) => {
                scene = s;
                dirty = true;
            }
            Ok(Msg::Captures(shown)) => {
                show_in_captures = shown;
                for s in &surfaces {
                    set_affinity(s.hwnd, shown);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Only the newest scene matters.
        while let Ok(msg) = receiver.try_recv() {
            match msg {
                Msg::Scene(s) => {
                    scene = s;
                    dirty = true;
                }
                Msg::Captures(shown) => show_in_captures = shown,
            }
        }
        if !dirty {
            continue;
        }
        dirty = false;
        if monitors_at.elapsed() > Duration::from_secs(1) {
            monitors = list_monitors();
            monitors_at = Instant::now();
            // A monitor that went away (or changed size or scaling) gets a fresh surface.
            surfaces.retain(|s| {
                monitors
                    .iter()
                    .any(|(m, sc)| *m == s.monitor && *sc == s.scale)
            });
        }
        let bounds = scene.bounds();
        for &(monitor, scale) in &monitors {
            let wanted = bounds.is_some_and(|b| intersects(b, monitor));
            let index = surfaces.iter().position(|s| s.monitor == monitor);
            match (wanted, index) {
                (true, None) => match make_surface(&gfx, monitor, scale, show_in_captures) {
                    Ok(surface) => surfaces.push(surface),
                    Err(error) => {
                        eprintln!("[cursor] layer window failed ({:#x})", error.code().0);
                        continue;
                    }
                },
                (false, Some(i)) if surfaces[i].shown => {
                    // SAFETY: our own window.
                    let _ = unsafe { ShowWindow(surfaces[i].hwnd, SW_HIDE) };
                    surfaces[i].shown = false;
                    continue;
                }
                (false, _) => continue,
                _ => {}
            }
            let Some(surface) = surfaces.iter_mut().find(|s| s.monitor == monitor) else {
                continue;
            };
            if let Err(error) = present(&gfx, surface, &scene) {
                eprintln!("[cursor] layer draw failed ({:#x})", error.code().0);
            }
            if !surface.shown {
                // SAFETY: our own window; shown without activating.
                let _ = unsafe { ShowWindow(surface.hwnd, SW_SHOWNOACTIVATE) };
                surface.shown = true;
            }
        }
    }
}

fn set_affinity(hwnd: HWND, shown_in_captures: bool) {
    let affinity = if shown_in_captures {
        WDA_NONE
    } else {
        WDA_EXCLUDEFROMCAPTURE
    };
    // SAFETY: a top-level window this process owns.
    let _ = unsafe { SetWindowDisplayAffinity(hwnd, affinity) };
}

fn make_surface(
    gfx: &Gfx,
    monitor: ScreenRect,
    scale: f32,
    show_in_captures: bool,
) -> windows::core::Result<Surface> {
    // SAFETY: GetModuleHandleW(None) is this executable; the class is registered once with a
    // valid window procedure; the window is created and destroyed on this thread.
    unsafe {
        let instance = GetModuleHandleW(None)?;
        REGISTER.call_once(|| {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: CLASS,
                ..Default::default()
            };
            RegisterClassExW(&class);
        });
        let hwnd = CreateWindowExW(
            WS_EX_NOREDIRECTIONBITMAP
                | WS_EX_LAYERED
                | WS_EX_TRANSPARENT
                | WS_EX_TOPMOST
                | WS_EX_TOOLWINDOW
                | WS_EX_NOACTIVATE,
            CLASS,
            w!(""),
            WS_POPUP,
            monitor.left,
            monitor.top,
            monitor.width(),
            monitor.height(),
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        // Layered with full opacity: the composition content shows, and hit-testing passes
        // through (WS_EX_TRANSPARENT needs WS_EX_LAYERED for that).
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA)?;
        set_affinity(hwnd, show_in_captures);
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: monitor.width() as u32,
            Height: monitor.height() as u32,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            ..Default::default()
        };
        let swap = gfx
            .dxgi_factory
            .CreateSwapChainForComposition(&gfx.d3d, &desc, None)?;
        let target = gfx.dcomp.CreateTargetForHwnd(hwnd, true)?;
        let visual = gfx.dcomp.CreateVisual()?;
        visual.SetContent(&swap)?;
        target.SetRoot(&visual)?;
        gfx.dcomp.Commit()?;
        Ok(Surface {
            monitor,
            scale,
            hwnd,
            swap,
            _target: target,
            _visual: visual,
            shown: false,
        })
    }
}

fn present(gfx: &Gfx, surface: &Surface, scene: &Scene) -> windows::core::Result<()> {
    // SAFETY: the back buffer belongs to this surface's swap chain; the bitmap wraps it only for
    // this frame and the target is released before Present.
    unsafe {
        let buffer: IDXGISurface = surface.swap.GetBuffer(0)?;
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let bitmap = gfx.dc.CreateBitmapFromDxgiSurface(&buffer, Some(&props))?;
        gfx.dc.SetTarget(&bitmap);
        gfx.dc.BeginDraw();
        let rt: ID2D1RenderTarget = gfx.dc.cast()?;
        let drawn = draw(
            &rt,
            &gfx.factory,
            &gfx.dwrite,
            (&gfx.dots, &gfx.round),
            scene,
            (surface.monitor.left, surface.monitor.top),
            surface.scale,
        );
        let ended = gfx.dc.EndDraw(None, None);
        gfx.dc.SetTarget(None);
        drawn?;
        ended?;
        surface.swap.Present(1, DXGI_PRESENT(0)).ok()
    }
}

const VIOLET: (f32, f32, f32) = (0.420, 0.306, 0.902);
const AMBER: (f32, f32, f32) = (0.961, 0.647, 0.141);

fn colour((r, g, b): (f32, f32, f32), a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r, g, b, a }
}

fn pt(x: f64, y: f64, origin: (i32, i32)) -> Vector2 {
    Vector2 {
        X: (x - f64::from(origin.0)) as f32,
        Y: (y - f64::from(origin.1)) as f32,
    }
}

/// Draws `scene` (global pixels) onto `rt`, whose top-left is `origin` on the virtual desktop.
/// Public for the renderer test, which draws onto a bitmap instead of a window.
pub fn draw(
    rt: &ID2D1RenderTarget,
    factory: &ID2D1Factory1,
    dwrite: &IDWriteFactory,
    (dots, round): (&ID2D1StrokeStyle, &ID2D1StrokeStyle),
    scene: &Scene,
    origin: (i32, i32),
    scale: f32,
) -> windows::core::Result<()> {
    // SAFETY: drawing calls between BeginDraw and EndDraw (the caller's) on a live target, with
    // resources made here and released when dropped.
    unsafe {
        rt.SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        rt.Clear(Some(&colour((0.0, 0.0, 0.0), 0.0)));
        let brush = rt.CreateSolidColorBrush(&colour(VIOLET, 1.0), None)?;
        let mut format: Option<IDWriteTextFormat> = None;
        for shape in &scene.shapes {
            match shape {
                Shape::GhostPath {
                    from,
                    control,
                    to,
                    alpha,
                } => {
                    let path = factory.CreatePathGeometry()?;
                    let sink = path.Open()?;
                    sink.BeginFigure(pt(from.0, from.1, origin), D2D1_FIGURE_BEGIN_HOLLOW);
                    sink.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT {
                        point1: pt(control.0, control.1, origin),
                        point2: pt(to.0, to.1, origin),
                    });
                    sink.EndFigure(D2D1_FIGURE_END_OPEN);
                    sink.Close()?;
                    // A soft halo under round dots.
                    brush.SetColor(&colour(VIOLET, alpha * 0.18));
                    rt.DrawGeometry(&path, &brush, 10.0 * scale, round);
                    brush.SetColor(&colour(VIOLET, *alpha));
                    rt.DrawGeometry(&path, &brush, 4.0 * scale, dots);
                }
                Shape::Glow {
                    rect,
                    scale: grow,
                    alpha,
                    warn,
                } => {
                    let hue = if *warn { AMBER } else { VIOLET };
                    let r = scaled(*rect, *grow, (4.0 * scale) as i32);
                    let rounded = D2D1_ROUNDED_RECT {
                        rect: D2D_RECT_F {
                            left: (r.left - origin.0) as f32,
                            top: (r.top - origin.1) as f32,
                            right: (r.right - origin.0) as f32,
                            bottom: (r.bottom - origin.1) as f32,
                        },
                        radiusX: 8.0 * scale,
                        radiusY: 8.0 * scale,
                    };
                    brush.SetColor(&colour(hue, alpha * 0.16));
                    rt.FillRoundedRectangle(&rounded, &brush);
                    brush.SetColor(&colour(hue, alpha * 0.25));
                    rt.DrawRoundedRectangle(&rounded, &brush, 9.0 * scale, round);
                    brush.SetColor(&colour(hue, alpha * 0.95));
                    rt.DrawRoundedRectangle(&rounded, &brush, 2.5 * scale, round);
                }
                Shape::Caption {
                    at,
                    text,
                    warn,
                    scale: chip,
                } => {
                    if format.is_none() {
                        let f = dwrite.CreateTextFormat(
                            w!("Segoe UI"),
                            None,
                            DWRITE_FONT_WEIGHT_SEMI_BOLD,
                            DWRITE_FONT_STYLE_NORMAL,
                            DWRITE_FONT_STRETCH_NORMAL,
                            14.0 * chip,
                            w!(""),
                        )?;
                        f.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)?;
                        f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
                        f.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
                        format = Some(f);
                    }
                    let Some(f) = &format else { continue };
                    let width = crate::screen::cursor::scene::caption_width(text) as f32 * chip;
                    let height = CAPTION_H as f32 * chip;
                    let p = pt(at.0, at.1, origin);
                    let rect = D2D_RECT_F {
                        left: p.X,
                        top: p.Y,
                        right: p.X + width,
                        bottom: p.Y + height,
                    };
                    brush.SetColor(&colour((0.12, 0.106, 0.18), 0.94));
                    rt.FillRoundedRectangle(
                        &D2D1_ROUNDED_RECT {
                            rect,
                            radiusX: height / 2.0,
                            radiusY: height / 2.0,
                        },
                        &brush,
                    );
                    brush.SetColor(&colour(if *warn { AMBER } else { VIOLET }, 1.0));
                    rt.DrawRoundedRectangle(
                        &D2D1_ROUNDED_RECT {
                            rect,
                            radiusX: height / 2.0,
                            radiusY: height / 2.0,
                        },
                        &brush,
                        1.5 * chip,
                        round,
                    );
                    brush.SetColor(&colour((1.0, 1.0, 1.0), 1.0));
                    let utf16: Vec<u16> = text.encode_utf16().collect();
                    rt.DrawText(
                        &utf16,
                        f,
                        &rect,
                        &brush,
                        D2D1_DRAW_TEXT_OPTIONS_CLIP,
                        DWRITE_MEASURING_MODE_NATURAL,
                    );
                }
                Shape::Dot { at, radius, alpha } => {
                    brush.SetColor(&colour(VIOLET, *alpha));
                    rt.FillEllipse(
                        &D2D1_ELLIPSE {
                            point: pt(at.0, at.1, origin),
                            radiusX: *radius,
                            radiusY: *radius,
                        },
                        &brush,
                    );
                }
                Shape::Ring { at, radius } => {
                    brush.SetColor(&colour(VIOLET, 0.6));
                    rt.DrawEllipse(
                        &D2D1_ELLIPSE {
                            point: pt(at.0, at.1, origin),
                            radiusX: *radius,
                            radiusY: *radius,
                        },
                        &brush,
                        1.5,
                        round,
                    );
                }
            }
        }
        Ok(())
    }
}

/// Every monitor's rectangle (global physical pixels) and scaling.
pub fn list_monitors() -> Vec<(ScreenRect, f32)> {
    unsafe extern "system" fn each(
        monitor: HMONITOR,
        _dc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: `data` is the Vec passed below, alive for the whole enumeration.
        let list = unsafe { &mut *(data.0 as *mut Vec<(ScreenRect, f32)>) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: valid handle from the enumeration and a sized struct.
        if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            let (mut dx, mut dy) = (96u32, 96u32);
            // SAFETY: valid handle and out pointers.
            let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
            let r = info.rcMonitor;
            list.push((
                ScreenRect {
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                },
                dx.max(96) as f32 / 96.0,
            ));
        }
        BOOL(1)
    }
    let mut list: Vec<(ScreenRect, f32)> = Vec::new();
    // SAFETY: the callback only touches `list` through the pointer, during this call.
    let _ = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(each),
            LPARAM(&mut list as *mut Vec<(ScreenRect, f32)> as isize),
        )
    };
    list
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: default handling for our own windows.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn pump() {
    let mut msg = MSG::default();
    // SAFETY: standard message pump for windows owned by this thread.
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::cursor::scene::ghost_path;
    use windows::Win32::Graphics::Direct2D::{
        D2D1_FEATURE_LEVEL_DEFAULT, D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT,
        D2D1_RENDER_TARGET_USAGE_NONE,
    };
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppPBGRA, IWICImagingFactory,
        WICBitmapCacheOnLoad,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    /// Draws a scene onto an offscreen bitmap (no window, nothing on the user's screen) and
    /// checks that each shape put pixels where it should, with negative monitor coordinates.
    #[test]
    fn draws_a_scene_onto_a_bitmap() {
        // SAFETY: COM, WIC and Direct2D on this test thread; resources dropped at the end.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let wic: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let (w, h) = (400u32, 300u32);
            let bitmap = wic
                .CreateBitmap(w, h, &GUID_WICPixelFormat32bppPBGRA, WICBitmapCacheOnLoad)
                .unwrap();
            let factory: ID2D1Factory1 =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).unwrap();
            let rt = factory
                .CreateWicBitmapRenderTarget(
                    &bitmap,
                    &D2D1_RENDER_TARGET_PROPERTIES {
                        r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                        pixelFormat: D2D1_PIXEL_FORMAT {
                            format: DXGI_FORMAT_B8G8R8A8_UNORM,
                            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                        },
                        dpiX: 96.0,
                        dpiY: 96.0,
                        usage: D2D1_RENDER_TARGET_USAGE_NONE,
                        minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
                    },
                )
                .unwrap();
            let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).unwrap();
            let (dots, round) = stroke_styles(&factory).unwrap();
            // The "monitor" sits at (-1000, -200): a screen left of and above the primary.
            let origin = (-1000, -200);
            let scene = Scene {
                shapes: vec![
                    ghost_path((-980.0, 50.0), (-640.0, 50.0), 0.9),
                    Shape::Glow {
                        rect: ScreenRect {
                            left: -800,
                            top: -150,
                            right: -700,
                            bottom: -120,
                        },
                        scale: 1.0,
                        alpha: 1.0,
                        warn: false,
                    },
                    Shape::Caption {
                        at: (-990.0, -60.0),
                        text: "below".into(),
                        warn: true,
                        scale: 1.0,
                    },
                ],
            };
            rt.BeginDraw();
            draw(&rt, &factory, &dwrite, (&dots, &round), &scene, origin, 1.0).unwrap();
            rt.EndDraw(None, None).unwrap();
            let stride = w * 4;
            let mut pixels = vec![0u8; (stride * h) as usize];
            bitmap
                .CopyPixels(std::ptr::null(), stride, &mut pixels)
                .unwrap();
            let alpha = |x: u32, y: u32| pixels[(y * stride + x * 4 + 3) as usize];
            // The glow's edge (local x 200..300, y 50..80, padded 4): its border is drawn.
            assert!(alpha(196, 65) > 100, "glow edge {}", alpha(196, 65));
            // The caption's chip (local 10..~71, 140..170).
            assert!(alpha(30, 155) > 200, "caption {}", alpha(30, 155));
            // The ghost path's halo somewhere along its line, above y = 250 local.
            let on_path = (20..360).any(|x| (150..260).any(|y| alpha(x, y) > 20));
            assert!(on_path);
            // Far from everything: clear.
            assert_eq!(alpha(395, 295), 0);
        }
    }

    /// The draw code's time for a busy frame (ghost path, glow, caption, debug marks) on a
    /// full-HD software bitmap: an upper bound for the GPU path. Printed for the docs.
    #[test]
    fn a_busy_frame_draws_well_within_a_frame() {
        // SAFETY: as in the test above.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let wic: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let bitmap = wic
                .CreateBitmap(
                    1920,
                    1080,
                    &GUID_WICPixelFormat32bppPBGRA,
                    WICBitmapCacheOnLoad,
                )
                .unwrap();
            let factory: ID2D1Factory1 =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).unwrap();
            let rt = factory
                .CreateWicBitmapRenderTarget(
                    &bitmap,
                    &D2D1_RENDER_TARGET_PROPERTIES {
                        r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                        pixelFormat: D2D1_PIXEL_FORMAT {
                            format: DXGI_FORMAT_B8G8R8A8_UNORM,
                            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                        },
                        dpiX: 96.0,
                        dpiY: 96.0,
                        usage: D2D1_RENDER_TARGET_USAGE_NONE,
                        minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
                    },
                )
                .unwrap();
            let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).unwrap();
            let (dots, round) = stroke_styles(&factory).unwrap();
            let scene = Scene {
                shapes: vec![
                    ghost_path((200.0, 900.0), (1500.0, 200.0), 0.6),
                    Shape::Glow {
                        rect: ScreenRect {
                            left: 1450,
                            top: 180,
                            right: 1560,
                            bottom: 220,
                        },
                        scale: 1.6,
                        alpha: 1.0,
                        warn: false,
                    },
                    Shape::Caption {
                        at: (230.0, 930.0),
                        text: "Personalization".into(),
                        warn: false,
                        scale: 1.0,
                    },
                    Shape::Dot {
                        at: (1490.0, 205.0),
                        radius: 5.0,
                        alpha: 0.9,
                    },
                    Shape::Ring {
                        at: (1490.0, 205.0),
                        radius: 30.0,
                    },
                ],
            };
            let runs = 60;
            let started = std::time::Instant::now();
            for _ in 0..runs {
                rt.BeginDraw();
                draw(&rt, &factory, &dwrite, (&dots, &round), &scene, (0, 0), 1.0).unwrap();
                rt.EndDraw(None, None).unwrap();
            }
            let per = started.elapsed().as_secs_f64() * 1000.0 / f64::from(runs);
            println!("busy frame, software, 1920x1080: {per:.2} ms");
            assert!(per < 16.0, "{per}");
        }
    }
}

//! One frame from Windows.Graphics.Capture, copied to a CPU buffer we own.
//!
//! A capture item is made for exactly one window or monitor (never the whole virtual screen),
//! a one-buffer frame pool receives a single frame, and the session is closed straight away.
//! Windows draws its yellow capture border for that moment: unpackaged apps can't turn it off
//! (`IsBorderRequired` needs the packaged `graphicsCaptureWithoutBorder` capability), and it
//! doubles as part of the capture indicator.

use std::time::{Duration, Instant};

use windows::core::{factory, Interface};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::target::Target;
use crate::screen::frame::TargetKind;
use crate::screen::image::Pixels;
use crate::screen::secret::SecretBytes;

/// How long to wait for Windows to deliver the frame.
const FRAME_TIMEOUT: Duration = Duration::from_millis(1500);
const POLL_EVERY: Duration = Duration::from_millis(4);
/// Refuse absurd sizes rather than allocate gigabytes (8K is 7680×4320).
const MAX_SIDE: i32 = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureError {
    /// The window closed or the monitor went away between asking and capturing.
    TargetGone,
    /// No frame arrived in time (e.g. the secure desktop is showing, or the GPU is busy).
    Timeout,
    TooLarge,
    /// Any other Windows error (HRESULT, for the log).
    Windows(i32),
}

impl From<windows::core::Error> for CaptureError {
    fn from(error: windows::core::Error) -> Self {
        CaptureError::Windows(error.code().0)
    }
}

/// A Direct3D device kept for the worker thread's lifetime (creating one costs tens of ms).
pub struct Capturer {
    d3d: ID3D11Device,
    context: ID3D11DeviceContext,
    device: IDirect3DDevice,
}

impl Capturer {
    pub fn new() -> Result<Self, CaptureError> {
        let (d3d, context) = create_d3d_device(D3D_DRIVER_TYPE_HARDWARE)
            .or_else(|_| create_d3d_device(D3D_DRIVER_TYPE_WARP))?;
        let dxgi: IDXGIDevice = d3d.cast()?;
        // SAFETY: `dxgi` is a valid DXGI device; the call returns a new WinRT wrapper around it.
        let device: IDirect3DDevice =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }?.cast()?;
        Ok(Self {
            d3d,
            context,
            device,
        })
    }

    /// Captures one frame of `target` as tightly packed BGRA.
    pub fn capture(&self, target: &Target) -> Result<Pixels, CaptureError> {
        let item = capture_item(target)?;
        let size = item.Size()?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err(CaptureError::TargetGone);
        }
        if size.Width > MAX_SIDE || size.Height > MAX_SIDE {
            return Err(CaptureError::TooLarge);
        }
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &self.device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        // The cursor isn't part of what the user asks about (and may hide what it points at).
        // Available from Windows 10 2004, which we require; ignore failure on odd builds.
        let _ = session.SetIsCursorCaptureEnabled(false);
        session.StartCapture()?;

        let started = Instant::now();
        let result = loop {
            match pool.TryGetNextFrame() {
                Ok(frame) => break self.copy_out(&frame),
                Err(_) if started.elapsed() < FRAME_TIMEOUT => std::thread::sleep(POLL_EVERY),
                Err(_) => break Err(CaptureError::Timeout),
            }
        };
        // Stop capturing at once: one frame, no stream (brief §7.1).
        let _ = session.Close();
        let _ = pool.Close();
        result
    }

    fn copy_out(
        &self,
        frame: &windows::Graphics::Capture::Direct3D11CaptureFrame,
    ) -> Result<Pixels, CaptureError> {
        let content = frame.ContentSize()?;
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        // SAFETY: the surface of a capture frame is backed by an ID3D11Texture2D.
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: `desc` is a valid out pointer.
        unsafe { texture.GetDesc(&mut desc) };
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging: Option<ID3D11Texture2D> = None;
        // SAFETY: `desc` describes a valid staging texture; `staging` receives it.
        unsafe { self.d3d.CreateTexture2D(&desc, None, Some(&mut staging)) }?;
        let staging = staging.ok_or(CaptureError::Windows(0))?;
        // SAFETY: both textures have the same size and format (the description was copied).
        unsafe { self.context.CopyResource(&staging, &texture) };

        let width = (content.Width.max(0) as u32).min(desc.Width);
        let height = (content.Height.max(0) as u32).min(desc.Height);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: a CPU-readable staging texture, subresource 0; unmapped below.
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }?;
        let stride = width as usize * 4;
        let mut data = SecretBytes::zeroed(stride * height as usize);
        let pitch = mapped.RowPitch as usize;
        for row in 0..height as usize {
            // SAFETY: the mapping holds `desc.Height` rows of `RowPitch` bytes each, and
            // row < height <= desc.Height, stride <= RowPitch (4 bytes per pixel, width <= desc.Width).
            let src = unsafe {
                std::slice::from_raw_parts((mapped.pData as *const u8).add(row * pitch), stride)
            };
            data.as_mut_slice()[row * stride..(row + 1) * stride].copy_from_slice(src);
        }
        // The staging texture is mapped read-only, so it isn't zeroed here; it's released (with
        // the frame) when this function returns.
        // SAFETY: matches the Map above.
        unsafe { self.context.Unmap(&staging, 0) };
        Ok(Pixels {
            width,
            height,
            channels: 4,
            data,
        })
    }
}

fn create_d3d_device(
    driver: D3D_DRIVER_TYPE,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device = None;
    let mut context = None;
    // SAFETY: out pointers are valid locals; no adapter or software module.
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }?;
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context)),
        _ => Err(windows::core::Error::empty()),
    }
}

fn capture_item(target: &Target) -> Result<GraphicsCaptureItem, CaptureError> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item = match (target.kind, target.window) {
        // SAFETY: the handle came from Windows moments ago; Windows validates it and fails
        // cleanly if the window has closed since.
        (TargetKind::Window, Some(hwnd)) => unsafe { interop.CreateForWindow(hwnd) },
        // SAFETY: as above, for the monitor handle.
        _ => unsafe { interop.CreateForMonitor(target.monitor) },
    };
    item.map_err(|_| CaptureError::TargetGone)
}

#[cfg(test)]
mod tests {
    //! Captures only a window this test creates itself, never the user's screen content.
    use super::*;
    use crate::screen::win::target::window_target;
    use crate::screen::win::ComThread;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateSolidBrush, HBRUSH};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // SAFETY: default handling for a test window.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn pump(for_ms: u64) {
        let until = Instant::now() + Duration::from_millis(for_ms);
        let mut msg = MSG::default();
        while Instant::now() < until {
            // SAFETY: standard message pump on the thread that owns the window.
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Run with `cargo test -- --ignored` on a desktop session (it shows a small window).
    #[test]
    #[ignore = "needs an interactive Windows desktop and a GPU"]
    fn captures_a_window_it_drew() {
        let _com = ComThread::init().unwrap();
        // SAFETY: a plain test window with a solid colour (BGR 0x203040 → R=0x40,G=0x30,B=0x20).
        let hwnd = unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(proc),
                hInstance: instance.into(),
                lpszClassName: w!("MewCaptureTest"),
                hbrBackground: HBRUSH(
                    CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x0020_3040)).0,
                ),
                ..Default::default()
            };
            RegisterClassExW(&class);
            // No activation: it must not take keyboard focus from whoever is using the PC.
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("MewCaptureTest"),
                w!("Mew capture test"),
                WS_POPUP | WS_VISIBLE,
                200,
                200,
                320,
                200,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap()
        };
        pump(300);
        let target = window_target(hwnd).expect("target");
        let capturer = Capturer::new().unwrap();
        let pixels = capturer.capture(&target).unwrap();
        // SAFETY: the window was created above on this thread.
        unsafe { DestroyWindow(hwnd).unwrap() };
        assert!(
            pixels.width >= 300 && pixels.height >= 180,
            "{}x{}",
            pixels.width,
            pixels.height
        );
        let mid = ((pixels.height / 2 * pixels.width + pixels.width / 2) * 4) as usize;
        assert_eq!(
            &pixels.data.as_slice()[mid..mid + 3],
            &[0x20, 0x30, 0x40],
            "BGR of the window colour"
        );
    }
}

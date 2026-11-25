//! Handoff's pictures: a saved crop decoded (WIC) so the sender can add a blur box in the
//! preview, and the boxes covered with a solid tint (unrecoverable, unlike a light blur). Plus
//! copying a command to the clipboard for Pick up from here (never running it).

use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat24bppBGR, IWICImagingFactory,
    WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::Shell::SHCreateMemStream;

use crate::screen::image::Pixels;
use crate::screen::privacy::redact::PixelRect;
use crate::screen::secret::SecretBytes;

/// The tint covered text gets: neb's violet, dark.
pub const TINT: [u8; 3] = [0x3a, 0x2a, 0x7a];

/// A JPEG decoded to 24-bit BGR (None if it isn't one).
pub fn decode_jpeg(jpeg: &[u8]) -> Option<Pixels> {
    // SAFETY: WIC on a thread with COM initialised; the stream wraps a copy of `jpeg`; every
    // interface is released when dropped; the pixel buffer is sized for the frame.
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let stream = SHCreateMemStream(Some(jpeg))?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
            .ok()?;
        let frame = decoder.GetFrame(0).ok()?;
        let converter = factory.CreateFormatConverter().ok()?;
        converter
            .Initialize(
                &frame,
                &GUID_WICPixelFormat24bppBGR,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .ok()?;
        let (mut w, mut h) = (0u32, 0u32);
        converter.GetSize(&mut w, &mut h).ok()?;
        if w == 0 || h == 0 || w > 4000 || h > 4000 {
            return None;
        }
        let stride = w * 3;
        let mut data = vec![0u8; (stride * h) as usize];
        converter
            .CopyPixels(std::ptr::null(), stride, &mut data)
            .ok()?;
        Some(Pixels {
            width: w,
            height: h,
            channels: 3,
            data: SecretBytes::from_vec(data),
        })
    }
}

/// The crop with `boxes` (image pixels) covered, re-encoded.
pub fn cover(jpeg: &[u8], boxes: &[PixelRect]) -> Option<Vec<u8>> {
    let pixels = decode_jpeg(jpeg)?;
    let (w, h) = (pixels.width, pixels.height);
    let mut data = pixels.data.as_slice().to_vec();
    for b in boxes {
        for y in b.top.min(h)..b.bottom.min(h) {
            for x in b.left.min(w)..b.right.min(w) {
                let i = ((y * w + x) * 3) as usize;
                data[i..i + 3].copy_from_slice(&TINT);
            }
        }
    }
    let pixels = Pixels {
        width: w,
        height: h,
        channels: 3,
        data: SecretBytes::from_vec(data),
    };
    let out = super::encode::encode_jpeg_with(&pixels, super::encode::FOR_CLIP).ok()?;
    Some(out.as_slice().to_vec())
}

/// A crop made at most `max_side` on its long side (for the brief's model input).
pub fn shrink_jpeg(jpeg: &[u8], max_side: u32) -> Option<Vec<u8>> {
    let p = decode_jpeg(jpeg)?;
    let long = p.width.max(p.height);
    if long <= max_side {
        return Some(jpeg.to_vec());
    }
    let (w, h) = (
        (p.width * max_side / long).max(1),
        (p.height * max_side / long).max(1),
    );
    let src = p.data.as_slice();
    let mut out = vec![0u8; (w * h * 3) as usize];
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = (x * p.width / w, y * p.height / h);
            let s = ((sy * p.width + sx) * 3) as usize;
            let d = ((y * w + x) * 3) as usize;
            out[d..d + 3].copy_from_slice(&src[s..s + 3]);
        }
    }
    let small = Pixels {
        width: w,
        height: h,
        channels: 3,
        data: SecretBytes::from_vec(out),
    };
    Some(
        super::encode::encode_jpeg_with(&small, super::encode::FOR_MODEL)
            .ok()?
            .as_slice()
            .to_vec(),
    )
}

/// Puts `text` on the clipboard (a command for the receiver to run themselves).
pub fn copy_text(text: &str) -> bool {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: the clipboard is opened and closed here; the global memory is handed to the
    // clipboard on success (and owned by it from then on).
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let ok = (|| {
            EmptyClipboard().ok()?;
            let mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).ok()?;
            let ptr = GlobalLock(mem) as *mut u16;
            if ptr.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            let _ = GlobalUnlock(mem);
            SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(mem.0))).ok()?;
            Some(())
        })()
        .is_some();
        let _ = CloseClipboard();
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    #[test]
    fn a_box_is_covered_and_the_rest_kept() {
        // SAFETY: COM for this test thread.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let white = Pixels {
            width: 40,
            height: 20,
            channels: 3,
            data: SecretBytes::from_vec(vec![255u8; 40 * 20 * 3]),
        };
        let jpeg = super::super::encode::encode_jpeg(&white).unwrap();
        let covered = cover(
            jpeg.as_slice(),
            &[PixelRect {
                left: 0,
                top: 0,
                right: 16,
                bottom: 16,
            }],
        )
        .unwrap();
        let back = decode_jpeg(&covered).unwrap();
        let at = |x: u32, y: u32| back.data.as_slice()[((y * 40 + x) * 3) as usize];
        assert!(at(4, 4) < 150, "covered");
        assert!(at(35, 10) > 200, "kept");
    }
}

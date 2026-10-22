//! JPEG encoding with Windows' own codec (WIC), straight into a buffer we own.
//!
//! The encoder writes into our `SecretBytes` through a memory stream, so the only copy of the
//! JPEG is one we can wipe. No file, no temp folder, no new crate.

use std::mem::ManuallyDrop;

use windows::core::{w, GUID, PWSTR};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR,
    IWICImagingFactory, WICBitmapEncoderNoCache,
};
use windows::Win32::System::Com::StructuredStorage::PROPBAG2;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STREAM_SEEK_CUR};
use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_R4};

use crate::screen::image::Pixels;
use crate::screen::secret::SecretBytes;

/// Good enough to read UI text; screenshots of 1600×900 come out around 150–300 KB.
pub const JPEG_QUALITY: f32 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodeError {
    /// The input wasn't 3-channel BGR of the stated size.
    BadInput,
    Windows(i32),
}

impl From<windows::core::Error> for EncodeError {
    fn from(error: windows::core::Error) -> Self {
        EncodeError::Windows(error.code().0)
    }
}

/// Encodes BGR pixels as a JPEG (the thread must have COM initialised).
pub fn encode_jpeg(pixels: &Pixels) -> Result<SecretBytes, EncodeError> {
    let stride = pixels.stride();
    if pixels.channels != 3
        || pixels.data.len() != stride * pixels.height as usize
        || pixels.width == 0
        || pixels.height == 0
    {
        return Err(EncodeError::BadInput);
    }
    // A JPEG of an image is far smaller than its raw pixels; the header room covers tiny images.
    let mut out = SecretBytes::zeroed(pixels.data.len() + 64 * 1024);

    // SAFETY: standard WIC encoding sequence; every out pointer is a valid local, and the
    // stream's backing memory (`out`) outlives the stream, which is dropped at the end of this
    // block. WIC's binding types the buffer as `&[u8]` but writes into it, so the slice is built
    // from the mutable pointer and no other reference to `out` exists until the block ends.
    let written = unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = factory.CreateStream()?;
        let buffer = std::slice::from_raw_parts(out.as_mut_slice().as_mut_ptr(), out.len());
        stream.InitializeFromMemory(buffer)?;

        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut options = None;
        encoder.CreateNewFrame(&mut frame, &mut options)?;
        let frame = frame.ok_or(EncodeError::Windows(0))?;
        if let Some(options) = &options {
            let name = w!("ImageQuality");
            let property = PROPBAG2 {
                pstrName: PWSTR(name.as_ptr().cast_mut()),
                ..Default::default()
            };
            let value = float_variant(JPEG_QUALITY);
            options.Write(1, &property, &value)?;
        }
        frame.Initialize(options.as_ref())?;
        frame.SetSize(pixels.width, pixels.height)?;
        let mut format: GUID = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format)?;
        if format != GUID_WICPixelFormat24bppBGR {
            return Err(EncodeError::BadInput);
        }
        frame.WritePixels(pixels.height, stride as u32, pixels.data.as_slice())?;
        frame.Commit()?;
        encoder.Commit()?;
        let mut position = 0u64;
        stream.Seek(0, STREAM_SEEK_CUR, Some(&mut position))?;
        position as usize
    };
    if written == 0 || written > out.len() {
        return Err(EncodeError::Windows(0));
    }
    out.truncate(written);
    Ok(out)
}

fn float_variant(value: f32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_R4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { fltVal: value },
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::win::ComThread;

    #[test]
    fn encodes_a_jpeg_in_memory() {
        let _com = ComThread::init().unwrap();
        let (width, height) = (64u32, 32u32);
        let mut data = SecretBytes::zeroed((width * height * 3) as usize);
        for (i, byte) in data.as_mut_slice().iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        let jpeg = encode_jpeg(&Pixels {
            width,
            height,
            channels: 3,
            data,
        })
        .unwrap();
        let bytes = jpeg.as_slice();
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF], "JPEG start of image");
        assert_eq!(
            &bytes[bytes.len() - 2..],
            &[0xFF, 0xD9],
            "JPEG end of image"
        );
    }

    #[test]
    fn refuses_mismatched_input() {
        let _com = ComThread::init().unwrap();
        let pixels = Pixels {
            width: 10,
            height: 10,
            channels: 4,
            data: SecretBytes::zeroed(400),
        };
        assert_eq!(encode_jpeg(&pixels).unwrap_err(), EncodeError::BadInput);
    }
}

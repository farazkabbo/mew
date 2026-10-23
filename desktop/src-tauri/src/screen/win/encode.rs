//! JPEG encoding with Windows' own codec (WIC), straight into a buffer we own.
//!
//! The encoder writes into our `SecretBytes` through a memory stream, so the only copy of the
//! JPEG is one we can wipe. No file, no temp folder, no new crate.

use std::mem::ManuallyDrop;

use windows::core::{w, GUID, PWSTR};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR,
    IWICImagingFactory, WICBitmapEncoderNoCache, WICJpegYCrCbSubsampling444,
};
use windows::Win32::System::Com::StructuredStorage::PROPBAG2;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STREAM_SEEK_CUR};
use windows::Win32::System::Variant::{
    VARENUM, VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_R4, VT_UI1,
};

use crate::screen::image::Pixels;
use crate::screen::secret::SecretBytes;

/// How a JPEG is written.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JpegOptions {
    /// 0–1.
    pub quality: f32,
    /// Full colour resolution (4:4:4) instead of the encoder's default 4:2:0: sharper coloured
    /// text, a little larger.
    pub full_chroma: bool,
}

/// What the tutor is sent: good enough to read UI text; screenshots of 1600×900 come out around
/// 150–300 KB.
pub const FOR_MODEL: JpegOptions = JpegOptions {
    quality: 0.8,
    full_chroma: false,
};

/// A saved clip (decision 9): kept, so worth the extra bytes.
pub const FOR_CLIP: JpegOptions = JpegOptions {
    quality: 0.9,
    full_chroma: true,
};

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

/// Encodes BGR pixels as a JPEG for the tutor (the thread must have COM initialised).
pub fn encode_jpeg(pixels: &Pixels) -> Result<SecretBytes, EncodeError> {
    encode_jpeg_with(pixels, FOR_MODEL)
}

/// Encodes BGR pixels as a JPEG with `options` (the thread must have COM initialised).
pub fn encode_jpeg_with(pixels: &Pixels, options: JpegOptions) -> Result<SecretBytes, EncodeError> {
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
        let mut bag = None;
        encoder.CreateNewFrame(&mut frame, &mut bag)?;
        let frame = frame.ok_or(EncodeError::Windows(0))?;
        if let Some(bag) = &bag {
            let quality = w!("ImageQuality");
            let property = PROPBAG2 {
                pstrName: PWSTR(quality.as_ptr().cast_mut()),
                ..Default::default()
            };
            bag.Write(1, &property, &float_variant(options.quality))?;
            if options.full_chroma {
                let subsampling = w!("JpegYCrCbSubsampling");
                let property = PROPBAG2 {
                    pstrName: PWSTR(subsampling.as_ptr().cast_mut()),
                    ..Default::default()
                };
                let value = byte_variant(WICJpegYCrCbSubsampling444.0 as u8);
                bag.Write(1, &property, &value)?;
            }
        }
        frame.Initialize(bag.as_ref())?;
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
    variant(VT_R4, VARIANT_0_0_0 { fltVal: value })
}

fn byte_variant(value: u8) -> VARIANT {
    variant(VT_UI1, VARIANT_0_0_0 { bVal: value })
}

fn variant(vt: VARENUM, value: VARIANT_0_0_0) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: value,
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

    /// The sampling factors of each colour component, from the JPEG's start-of-frame header.
    fn sampling_factors(jpeg: &[u8]) -> Vec<u8> {
        let mut at = 2;
        while at + 4 <= jpeg.len() {
            let (marker, length) = (
                jpeg[at + 1],
                usize::from(u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]])),
            );
            if marker == 0xC0 || marker == 0xC2 {
                let components = usize::from(jpeg[at + 9]);
                return (0..components).map(|i| jpeg[at + 11 + i * 3]).collect();
            }
            at += 2 + length;
        }
        Vec::new()
    }

    #[test]
    fn writes_clips_at_full_colour_resolution() {
        let _com = ComThread::init().unwrap();
        let (width, height) = (64u32, 64u32);
        let pixels = || {
            let mut data = SecretBytes::zeroed((width * height * 3) as usize);
            for (i, byte) in data.as_mut_slice().iter_mut().enumerate() {
                *byte = (i * 7 % 256) as u8;
            }
            Pixels {
                width,
                height,
                channels: 3,
                data,
            }
        };
        let clip = encode_jpeg_with(&pixels(), FOR_CLIP).unwrap();
        assert_eq!(sampling_factors(clip.as_slice()), vec![0x11, 0x11, 0x11]);
        let model = encode_jpeg(&pixels()).unwrap();
        assert_ne!(
            sampling_factors(model.as_slice()),
            vec![0x11, 0x11, 0x11],
            "the tutor's copy keeps the smaller default"
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

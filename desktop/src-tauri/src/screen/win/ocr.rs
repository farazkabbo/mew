//! On-device text recognition with Windows.Media.Ocr, used to find text to cover before upload.
//! Nothing recognised here is logged, stored or sent: only rectangles leave this module.

use windows::core::Interface;
use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Win32::System::WinRT::IMemoryBufferByteAccess;

use crate::screen::image::Pixels;
use crate::screen::privacy::redact::{OcrLine, OcrWord};
use crate::screen::secret::wipe;

/// Longest side we OCR at. Screen text stays readable; bigger images cost time for nothing.
pub const OCR_MAX_SIDE: u32 = 2560;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrError {
    /// No OCR language is installed for the user's languages.
    NoLanguage,
    Windows(i32),
}

impl From<windows::core::Error> for OcrError {
    fn from(error: windows::core::Error) -> Self {
        OcrError::Windows(error.code().0)
    }
}

pub struct Ocr {
    engine: OcrEngine,
    max_side: u32,
}

impl Ocr {
    /// An engine for the user's display languages (the thread must have COM initialised).
    pub fn new() -> Result<Self, OcrError> {
        let engine =
            OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| OcrError::NoLanguage)?;
        let max_side = OcrEngine::MaxImageDimension()
            .unwrap_or(OCR_MAX_SIDE)
            .min(OCR_MAX_SIDE);
        Ok(Self { engine, max_side })
    }

    /// The longest side `read` accepts; callers downscale to this first.
    pub fn max_side(&self) -> u32 {
        self.max_side
    }

    /// Recognises the text in an 8-bit grey image.
    pub fn read(&self, grey: &Pixels) -> Result<Vec<OcrLine>, OcrError> {
        if grey.channels != 1 || grey.width == 0 || grey.height == 0 {
            return Err(OcrError::Windows(0));
        }
        let bitmap = SoftwareBitmap::Create(
            BitmapPixelFormat::Gray8,
            grey.width as i32,
            grey.height as i32,
        )?;
        write_rows(&bitmap, Some(grey))?;
        let result = self
            .engine
            .RecognizeAsync(&bitmap)
            .and_then(|operation| operation.join());
        // Our copy inside the bitmap is wiped whatever happened, then the bitmap is released.
        let _ = write_rows(&bitmap, None);
        let _ = bitmap.Close();

        let mut lines = Vec::new();
        for line in result?.Lines()? {
            let mut words = Vec::new();
            for word in line.Words()? {
                let rect = word.BoundingRect()?;
                words.push(OcrWord {
                    text: word.Text()?.to_string_lossy(),
                    x: rect.X,
                    y: rect.Y,
                    width: rect.Width,
                    height: rect.Height,
                });
            }
            lines.push(OcrLine { words });
        }
        Ok(lines)
    }
}

/// Copies `grey` into the bitmap's pixel buffer row by row, or zeroes the buffer when `grey`
/// is None.
fn write_rows(bitmap: &SoftwareBitmap, grey: Option<&Pixels>) -> windows::core::Result<()> {
    let buffer = bitmap.LockBuffer(BitmapBufferAccessMode::Write)?;
    let plane = buffer.GetPlaneDescription(0)?;
    let reference = buffer.CreateReference()?;
    let access: IMemoryBufferByteAccess = reference.cast()?;
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut capacity = 0u32;
    // SAFETY: GetBuffer returns the locked buffer's address and size; it stays valid until
    // `reference` and `buffer` are closed at the end of this function.
    unsafe { access.GetBuffer(&mut data, &mut capacity) }?;
    if !data.is_null() {
        // SAFETY: `data` points to `capacity` writable bytes (see above), and nothing else
        // references them while the buffer is locked for writing.
        let bytes = unsafe { std::slice::from_raw_parts_mut(data, capacity as usize) };
        match grey {
            None => wipe(bytes),
            Some(grey) => {
                let (start, stride) = (
                    plane.StartIndex.max(0) as usize,
                    plane.Stride.max(0) as usize,
                );
                let row_len = grey.width as usize;
                for (row, src) in grey.data.as_slice().chunks_exact(row_len).enumerate() {
                    let at = start + row * stride;
                    if let Some(dst) = bytes.get_mut(at..at + row_len) {
                        dst.copy_from_slice(src);
                    }
                }
            }
        }
    }
    reference.Close()?;
    buffer.Close()?;
    Ok(())
}

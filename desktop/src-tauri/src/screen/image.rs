//! Pure pixel work on captured frames: downscaling for upload and spotting blank captures.

use super::secret::SecretBytes;

/// Longest side of the image we send. Enough to read UI text; small enough to upload quickly.
pub const MAX_LONG_SIDE: u32 = 1600;

/// A frame of tightly packed pixels.
#[derive(Debug)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    /// Bytes per pixel: 4 for BGRA, 3 for BGR, 1 for grey.
    pub channels: u32,
    pub data: SecretBytes,
}

impl Pixels {
    pub fn stride(&self) -> usize {
        self.width as usize * self.channels as usize
    }
}

/// The size to scale `width`×`height` to so the longest side is at most `max_side`, keeping
/// the aspect ratio (never upscales; never returns a zero side).
pub fn fit_within(width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max_side || long == 0 {
        return (width.max(1), height.max(1));
    }
    let scale = |side: u32| {
        ((u64::from(side) * u64::from(max_side) + u64::from(long) / 2) / u64::from(long)).max(1)
            as u32
    };
    (scale(width), scale(height))
}

/// Downscales BGRA to BGR (what the JPEG encoder takes) by averaging the source pixels each
/// output pixel covers. Alpha is dropped: captured desktop content is opaque.
pub fn downscale_bgra_to_bgr(source: &Pixels, max_side: u32) -> Pixels {
    downscale(source, max_side, 3, |[b, g, r], out| {
        out.copy_from_slice(&[b, g, r])
    })
}

/// Downscales BGRA to 8-bit grey (what OCR reads fastest), using Rec. 601 luma weights.
pub fn downscale_bgra_to_gray(source: &Pixels, max_side: u32) -> Pixels {
    downscale(source, max_side, 1, |[b, g, r], out| {
        out[0] =
            ((u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114 + 500) / 1000) as u8;
    })
}

/// Box-filter downscale of BGRA: each output pixel averages the source pixels it covers, then
/// `write` turns that average colour ([b, g, r]) into `channels` output bytes.
fn downscale(
    source: &Pixels,
    max_side: u32,
    channels: u32,
    write: impl Fn([u8; 3], &mut [u8]),
) -> Pixels {
    debug_assert_eq!(source.channels, 4);
    let (out_w, out_h) = fit_within(source.width, source.height, max_side);
    let out_channels = channels as usize;
    let mut data = SecretBytes::zeroed(out_w as usize * out_h as usize * out_channels);
    let src = source.data.as_slice();
    let src_stride = source.stride();
    let out = data.as_mut_slice();
    let (sw, sh) = (u64::from(source.width), u64::from(source.height));

    for oy in 0..u64::from(out_h) {
        let y0 = (oy * sh / u64::from(out_h)) as usize;
        let y1 = (((oy + 1) * sh).div_ceil(u64::from(out_h)) as usize).max(y0 + 1);
        for ox in 0..u64::from(out_w) {
            let x0 = (ox * sw / u64::from(out_w)) as usize;
            let x1 = (((ox + 1) * sw).div_ceil(u64::from(out_w)) as usize).max(x0 + 1);
            let mut sum = [0u64; 3];
            for y in y0..y1 {
                let row = &src[y * src_stride..];
                for x in x0..x1 {
                    let px = &row[x * 4..x * 4 + 3];
                    sum[0] += u64::from(px[0]);
                    sum[1] += u64::from(px[1]);
                    sum[2] += u64::from(px[2]);
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            let average = sum.map(|channel| ((channel + count / 2) / count) as u8);
            let at = (oy as usize * out_w as usize + ox as usize) * out_channels;
            write(average, &mut out[at..at + out_channels]);
        }
    }
    Pixels {
        width: out_w,
        height: out_h,
        channels,
        data,
    }
}

/// The part of `source` inside `left..right` × `top..bottom` (clamped to the image), as a new
/// buffer of the same kind.
pub fn crop(source: &Pixels, left: u32, top: u32, right: u32, bottom: u32) -> Pixels {
    let channels = source.channels as usize;
    let (right, bottom) = (right.min(source.width), bottom.min(source.height));
    let (left, top) = (left.min(right), top.min(bottom));
    let (width, height) = (right - left, bottom - top);
    let row_bytes = width as usize * channels;
    let mut data = SecretBytes::zeroed(row_bytes * height as usize);
    let src = source.data.as_slice();
    let stride = source.stride();
    for (row, out) in data.as_mut_slice().chunks_exact_mut(row_bytes.max(1)).enumerate() {
        let at = (top as usize + row) * stride + left as usize * channels;
        out.copy_from_slice(&src[at..at + row_bytes]);
    }
    Pixels {
        width,
        height,
        channels: source.channels,
        data,
    }
}

/// True when every sampled pixel is (near) black: what exclusive-fullscreen games and protected
/// (DRM) content look like to Windows.Graphics.Capture. We say so instead of sending it.
pub fn looks_blank(pixels: &Pixels) -> bool {
    let channels = pixels.channels as usize;
    let data = pixels.data.as_slice();
    let total = pixels.width as usize * pixels.height as usize;
    if total == 0 {
        return true;
    }
    // ~4,000 evenly spaced samples are plenty and keep this well under a millisecond.
    let step = (total / 4096).max(1);
    (0..total).step_by(step).all(|i| {
        let px = &data[i * channels..i * channels + 3];
        px.iter().all(|&v| v <= 8)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bgra(width: u32, height: u32, fill: impl Fn(u32, u32) -> [u8; 4]) -> Pixels {
        let mut data = SecretBytes::zeroed((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let at = ((y * width + x) * 4) as usize;
                data.as_mut_slice()[at..at + 4].copy_from_slice(&fill(x, y));
            }
        }
        Pixels {
            width,
            height,
            channels: 4,
            data,
        }
    }

    #[test]
    fn fits_the_long_side_and_keeps_the_aspect_ratio() {
        assert_eq!(fit_within(3840, 2160, 1600), (1600, 900));
        assert_eq!(fit_within(2160, 3840, 1600), (900, 1600));
        assert_eq!(fit_within(1280, 720, 1600), (1280, 720));
        assert_eq!(fit_within(5000, 1, 1600), (1600, 1));
        assert_eq!(fit_within(0, 0, 1600), (1, 1));
    }

    #[test]
    fn averages_when_downscaling() {
        // A 4×2 checkerboard of black and white halves to 2×1 mid-grey.
        let source = bgra(4, 2, |x, y| {
            if (x + y) % 2 == 0 {
                [0, 0, 0, 255]
            } else {
                [255, 255, 255, 255]
            }
        });
        let out = downscale_bgra_to_bgr(&source, 2);
        assert_eq!((out.width, out.height, out.channels), (2, 1, 3));
        assert!(out.data.as_slice().iter().all(|&v| v == 128));
    }

    #[test]
    fn keeps_channel_order_and_size_when_not_scaling() {
        let source = bgra(3, 2, |x, _| [x as u8, 10, 20, 255]);
        let out = downscale_bgra_to_bgr(&source, 1600);
        assert_eq!((out.width, out.height), (3, 2));
        assert_eq!(
            &out.data.as_slice()[..9],
            &[0, 10, 20, 1, 10, 20, 2, 10, 20]
        );
    }

    #[test]
    fn handles_sizes_that_dont_divide_evenly() {
        let source = bgra(1921, 1081, |_, _| [40, 80, 120, 255]);
        let out = downscale_bgra_to_bgr(&source, 1600);
        assert_eq!((out.width, out.height), (1600, 900));
        assert!(out.data.as_slice().chunks(3).all(|px| px == [40, 80, 120]));
    }

    #[test]
    fn makes_grey_copies_for_ocr() {
        // Pure red, green and blue map to their luma weights; white stays white.
        let source = bgra(4, 1, |x, _| match x {
            0 => [0, 0, 255, 255],
            1 => [0, 255, 0, 255],
            2 => [255, 0, 0, 255],
            _ => [255, 255, 255, 255],
        });
        let grey = downscale_bgra_to_gray(&source, 1600);
        assert_eq!((grey.width, grey.height, grey.channels), (4, 1, 1));
        assert_eq!(grey.data.as_slice(), &[76, 150, 29, 255]);
    }

    #[test]
    fn crops_and_clamps() {
        let source = bgra(4, 3, |x, y| [x as u8, y as u8, 0, 255]);
        let part = crop(&source, 1, 1, 3, 3);
        assert_eq!((part.width, part.height, part.channels), (2, 2, 4));
        assert_eq!(&part.data.as_slice()[..8], &[1, 1, 0, 255, 2, 1, 0, 255]);
        let clamped = crop(&source, 3, 2, 10, 10);
        assert_eq!((clamped.width, clamped.height), (1, 1));
        let empty = crop(&source, 5, 5, 9, 9);
        assert_eq!((empty.width, empty.height), (0, 0));
    }

    #[test]
    fn spots_black_frames() {
        assert!(looks_blank(&bgra(64, 64, |_, _| [0, 0, 0, 255])));
        assert!(!looks_blank(&bgra(64, 64, |x, y| if x == 10 && y == 0 {
            [255, 255, 255, 255]
        } else {
            [0, 0, 0, 255]
        })));
        assert!(!looks_blank(&bgra(64, 64, |_, _| [30, 30, 30, 255])));
    }
}

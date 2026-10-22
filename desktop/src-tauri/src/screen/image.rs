//! Pure pixel work on captured frames: downscaling for upload and spotting blank captures.

use super::secret::SecretBytes;

/// Longest side of the image we send. Enough to read UI text; small enough to upload quickly.
pub const MAX_LONG_SIDE: u32 = 1600;

/// A frame of tightly packed pixels.
#[derive(Debug)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    /// Bytes per pixel: 4 for BGRA, 3 for BGR.
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
    debug_assert_eq!(source.channels, 4);
    let (out_w, out_h) = fit_within(source.width, source.height, max_side);
    let mut data = SecretBytes::zeroed(out_w as usize * out_h as usize * 3);
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
            let at = (oy as usize * out_w as usize + ox as usize) * 3;
            for c in 0..3 {
                out[at + c] = ((sum[c] + count / 2) / count) as u8;
            }
        }
    }
    Pixels {
        width: out_w,
        height: out_h,
        channels: 3,
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

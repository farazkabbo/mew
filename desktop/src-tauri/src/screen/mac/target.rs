//! Coordinate and target snapshots. Quartz uses global top-left **points**, not capture pixels.
//! Keep display-local pixels paired with a display ID; mixed-scale desktops have no single
//! global physical-pixel coordinate space. No function in this module acquires screen pixels.

#[cfg(target_os = "macos")]
#[path = "target/native.rs"]
mod native;
#[cfg(target_os = "macos")]
pub use native::*;

/// Global Quartz/AppKit points or display-local pixels, according to the API signature.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Option<Self> {
        ([x, y, width, height, x + width, y + height]
            .iter()
            .all(|v| v.is_finite())
            && width > 0.
            && height > 0.)
            .then_some(Self {
                x,
                y,
                width,
                height,
            })
    }
    pub fn contains(self, p: Point) -> bool {
        p.x >= self.x && p.y >= self.y && p.x < self.x + self.width && p.y < self.y + self.height
    }
    /// Convert a rectangle between Quartz top-left and AppKit bottom-left global points.
    /// `primary_height` is the main display's height in points, never its pixel height.
    pub fn to_appkit(self, primary_height: f64) -> Option<Self> {
        if !primary_height.is_finite() || primary_height <= 0. {
            return None;
        }
        Self::new(
            self.x,
            primary_height - self.y - self.height,
            self.width,
            self.height,
        )
    }
}

/// Display-local pixel bounds suitable for cropping a frame with the same dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Display {
    pub id: u32,
    pub points: Rect,
    pub pixel_width: u32,
    pub pixel_height: u32,
}
impl Display {
    pub fn new(id: u32, points: Rect, pixel_width: u32, pixel_height: u32) -> Option<Self> {
        Rect::new(points.x, points.y, points.width, points.height)?;
        (id != 0
            && pixel_width > 0
            && pixel_height > 0
            && (f64::from(pixel_width) / points.width).is_finite()
            && (f64::from(pixel_height) / points.height).is_finite())
        .then_some(Self {
            id,
            points,
            pixel_width,
            pixel_height,
        })
    }
    pub fn scale_x(self) -> f64 {
        f64::from(self.pixel_width) / self.points.width
    }
    pub fn scale_y(self) -> f64 {
        f64::from(self.pixel_height) / self.points.height
    }
    pub fn point_to_pixel(self, point: Point) -> Option<Point> {
        self.points.contains(point).then(|| Point {
            x: (point.x - self.points.x) * self.scale_x(),
            y: (point.y - self.points.y) * self.scale_y(),
        })
    }
    pub fn pixel_to_point(self, pixel: Point) -> Option<Point> {
        if !Rect::new(
            0.,
            0.,
            f64::from(self.pixel_width),
            f64::from(self.pixel_height),
        )?
        .contains(pixel)
        {
            return None;
        }
        Some(Point {
            x: self.points.x + pixel.x / self.scale_x(),
            y: self.points.y + pixel.y / self.scale_y(),
        })
    }
    /// Crop only when wholly on this display. Windows spanning displays need the capture
    /// filter's own scale and content rect instead; silently clipping would select wrong data.
    pub fn pixel_crop(self, crop: Rect) -> Option<PixelRect> {
        Rect::new(crop.x, crop.y, crop.width, crop.height)?;
        if crop.x < self.points.x
            || crop.y < self.points.y
            || crop.x + crop.width > self.points.x + self.points.width
            || crop.y + crop.height > self.points.y + self.points.height
        {
            return None;
        }
        Some(PixelRect {
            left: ((crop.x - self.points.x) * self.scale_x()).floor() as u32,
            top: ((crop.y - self.points.y) * self.scale_y()).floor() as u32,
            right: (((crop.x + crop.width - self.points.x) * self.scale_x()).ceil() as u32)
                .min(self.pixel_width),
            bottom: (((crop.y + crop.height - self.points.y) * self.scale_y()).ceil() as u32)
                .min(self.pixel_height),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> Display {
        Display::new(
            7,
            Rect::new(-1440., -200., 1440., 900.).unwrap(),
            2880,
            1800,
        )
        .unwrap()
    }

    #[test]
    fn retina_conversion_keeps_negative_origin_in_points() {
        let d = display();
        assert_eq!(
            d.point_to_pixel(Point {
                x: -1400.,
                y: -180.
            }),
            Some(Point { x: 80., y: 40. })
        );
        assert_eq!(
            d.pixel_to_point(Point { x: 80., y: 40. }),
            Some(Point {
                x: -1400.,
                y: -180.
            })
        );
    }

    #[test]
    fn appkit_flips_against_primary_not_secondary_height() {
        let quartz = display().points;
        let appkit = quartz.to_appkit(982.).unwrap();
        assert_eq!(appkit, Rect::new(-1440., 282., 1440., 900.).unwrap());
        assert_eq!(appkit.to_appkit(982.), Some(quartz));
    }

    #[test]
    fn crop_rounds_outwards_and_refuses_cross_display_crop() {
        let d = display();
        let crop = Rect::new(-1439.8, -199.8, 10.1, 10.1).unwrap();
        assert_eq!(
            d.pixel_crop(crop),
            Some(PixelRect {
                left: 0,
                top: 0,
                right: 21,
                bottom: 21
            })
        );
        assert_eq!(d.pixel_crop(Rect::new(-1441., 0., 10., 10.).unwrap()), None);
    }

    #[test]
    fn mixed_scales_use_display_local_values_and_half_open_edges() {
        let left = display();
        let right = Display::new(8, Rect::new(0., 0., 1920., 1080.).unwrap(), 1920, 1080).unwrap();
        assert!(!left.points.contains(Point { x: 0., y: 0. }));
        assert_eq!(
            right.point_to_pixel(Point { x: 40., y: 20. }),
            Some(Point { x: 40., y: 20. })
        );
        assert_eq!(left.pixel_to_point(Point { x: 2880., y: 0. }), None);
    }

    #[test]
    fn invalid_or_nonfinite_geometry_is_refused() {
        assert!(Rect::new(f64::NAN, 0., 1., 1.).is_none());
        assert!(Rect::new(0., 0., 0., 1.).is_none());
        assert!(Rect::new(f64::MAX, 0., f64::MAX, 1.).is_none());
        assert!(Display::new(1, display().points, 0, 1800).is_none());
        assert!(display()
            .point_to_pixel(Point {
                x: f64::INFINITY,
                y: 0.
            })
            .is_none());
    }

    #[test]
    fn anisotropic_scale_is_explicit() {
        let d = Display::new(1, Rect::new(0., 0., 100., 100.).unwrap(), 200, 300).unwrap();
        assert_eq!(
            d.point_to_pixel(Point { x: 20., y: 10. }),
            Some(Point { x: 40., y: 30. })
        );
    }
}

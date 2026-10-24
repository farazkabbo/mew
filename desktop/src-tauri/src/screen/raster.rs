//! Drawing the student's marks onto the focus image the model sees (Circle & Ask, S3.2 §3.4):
//! each mark as a thick line in the student's colour, and its number beside it, so the model
//! sees exactly what was circled and can say "mark 1…". Only this copy gets them: the saved image
//! stays clean, with the marks as strokes. Pure pixel work on BGRA images, tested.

use super::image::Pixels;

/// The student's ink: graphite blue (brief §2.2), clearly unlike the tutor's violet.
pub const STUDENT_INK: [u8; 3] = [0x3b, 0x5b, 0x8c];

/// Draws a polyline (`points` in the image's pixels) `width` pixels thick.
pub fn draw_polyline(image: &mut Pixels, points: &[(f32, f32)], width: f32, rgb: [u8; 3]) {
    let radius = (width / 2.0).max(0.5);
    match points {
        [] => {}
        [only] => disc(image, *only, radius, rgb),
        _ => {
            for pair in points.windows(2) {
                segment(image, pair[0], pair[1], radius, rgb);
            }
        }
    }
}

/// Writes a digit (1–9) with its top-left corner at `at`, `cell` pixels per font pixel, on a
/// white square so it reads over any content.
pub fn draw_number(image: &mut Pixels, number: u8, at: (f32, f32), cell: f32, rgb: [u8; 3]) {
    let Some(rows) = DIGITS.get(usize::from(number.clamp(1, 9)) - 1) else {
        return;
    };
    let cell = cell.max(1.0);
    let (x0, y0) = (at.0.round() as i64, at.1.round() as i64);
    let size = (7.0 * cell).round() as i64;
    fill_rect(
        image,
        x0 - cell as i64,
        y0 - cell as i64,
        size + 2 * cell as i64,
        size + 2 * cell as i64,
        [255, 255, 255],
    );
    for (row, bits) in rows.iter().enumerate() {
        for col in 0..5 {
            if bits & (0b10000 >> col) != 0 {
                let x = x0 + ((col as f32 + 1.0) * cell).round() as i64;
                let y = y0 + (row as f32 * cell).round() as i64;
                fill_rect(image, x, y, cell.ceil() as i64, cell.ceil() as i64, rgb);
            }
        }
    }
}

/// 5×7 pixel digits 1–9, a row per byte (high bit = left).
const DIGITS: [[u8; 7]; 9] = [
    [
        0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
    ],
    [
        0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
    ],
    [
        0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
    ],
    [
        0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
    ],
    [
        0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
    ],
];

fn segment(image: &mut Pixels, a: (f32, f32), b: (f32, f32), radius: f32, rgb: [u8; 3]) {
    let length = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
    let steps = (length / (radius * 0.5).max(0.5)).ceil().max(1.0) as usize;
    for i in 0..=steps {
        let t = i as f32 / steps as f32;
        disc(
            image,
            (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t),
            radius,
            rgb,
        );
    }
}

fn disc(image: &mut Pixels, (cx, cy): (f32, f32), radius: f32, rgb: [u8; 3]) {
    let r = radius.ceil() as i64;
    let (cx_i, cy_i) = (cx.round() as i64, cy.round() as i64);
    for y in cy_i - r..=cy_i + r {
        for x in cx_i - r..=cx_i + r {
            let (dx, dy) = (x as f32 - cx, y as f32 - cy);
            if dx * dx + dy * dy <= radius * radius {
                put(image, x, y, rgb);
            }
        }
    }
}

fn fill_rect(image: &mut Pixels, x: i64, y: i64, w: i64, h: i64, rgb: [u8; 3]) {
    for py in y..y + h {
        for px in x..x + w {
            put(image, px, py, rgb);
        }
    }
}

/// Sets one BGRA pixel (outside the image: nothing).
fn put(image: &mut Pixels, x: i64, y: i64, [r, g, b]: [u8; 3]) {
    if x < 0 || y < 0 || x >= i64::from(image.width) || y >= i64::from(image.height) {
        return;
    }
    let channels = image.channels as usize;
    let at = y as usize * image.stride() + x as usize * channels;
    let data = image.data.as_mut_slice();
    if let Some(pixel) = data.get_mut(at..at + channels.min(3)) {
        pixel.copy_from_slice(&[b, g, r][..pixel.len()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::secret::SecretBytes;

    fn white(width: u32, height: u32) -> Pixels {
        Pixels {
            width,
            height,
            channels: 4,
            data: SecretBytes::from_vec(vec![255; (width * height * 4) as usize]),
        }
    }

    fn rgb_at(image: &Pixels, x: u32, y: u32) -> [u8; 3] {
        let at = (y as usize) * image.stride() + (x as usize) * 4;
        let p = &image.data.as_slice()[at..at + 3];
        [p[2], p[1], p[0]]
    }

    #[test]
    fn draws_a_thick_line_in_the_students_colour() {
        let mut image = white(40, 20);
        draw_polyline(&mut image, &[(5.0, 10.0), (35.0, 10.0)], 4.0, STUDENT_INK);
        assert_eq!(rgb_at(&image, 20, 10), STUDENT_INK);
        assert_eq!(rgb_at(&image, 20, 11), STUDENT_INK);
        assert_eq!(rgb_at(&image, 20, 16), [255, 255, 255]);
        assert_eq!(rgb_at(&image, 2, 10), [255, 255, 255]);
    }

    #[test]
    fn stays_inside_the_image() {
        let mut image = white(10, 10);
        draw_polyline(
            &mut image,
            &[(-50.0, -50.0), (60.0, 60.0)],
            6.0,
            STUDENT_INK,
        );
        assert_eq!(rgb_at(&image, 5, 5), STUDENT_INK);
        // A number running off the edge is cut, never written past the image.
        draw_number(&mut image, 3, (8.0, 8.0), 3.0, STUDENT_INK);
        assert_eq!(image.data.len(), 10 * 10 * 4);
    }

    #[test]
    fn writes_a_number_on_a_white_square() {
        let mut image = white(30, 30);
        // Fill with black first, to see the white square.
        image.data.as_mut_slice().fill(0);
        draw_number(&mut image, 1, (10.0, 10.0), 2.0, STUDENT_INK);
        // "1": the stem's column (col 2 → x = 10 + 3·2) is inked; the square around is white.
        assert_eq!(rgb_at(&image, 16, 14), STUDENT_INK);
        assert_eq!(rgb_at(&image, 11, 20), [255, 255, 255]);
        assert_eq!(rgb_at(&image, 1, 1), [0, 0, 0]);
    }
}

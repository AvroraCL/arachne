//! Coverage and premultiplied color for affine vector layers.

#[repr(C)]
pub struct Shape {
    raster: usize,
    tile: usize,
    left: usize,
    bottom: usize,
    cos: f64,
    sin: f64,
    cx: f64,
    cy: f64,
    scale_x: f64,
    scale_y: f64,
    half_width: f64,
    half_height: f64,
    radius: f64,
    antialias: f64,
    stroke_width: f64,
    fill: [f32; 3],
    stroke: [f32; 3],
    filled: bool,
    rectangle: bool,
}

impl Shape {
    fn distance(&self, x: f64, y: f64) -> f64 {
        if self.rectangle {
            let x = x.abs() - self.half_width + self.radius;
            let y = y.abs() - self.half_height + self.radius;
            let positive_x = x.max(0.0);
            let positive_y = y.max(0.0);
            let outside = if positive_x == 0.0 || positive_y == 0.0 {
                positive_x + positive_y
            } else {
                positive_x.hypot(positive_y)
            };
            x.max(y).min(0.0) + outside - self.radius
        } else {
            let x = x / self.half_width;
            let y = y / self.half_height;
            (x * x + y * y - 1.0)
                / (2.0 * (x / self.half_width).hypot(y / self.half_height)).max(1e-8)
        }
    }

    fn pixel(&self, u: f64, v: f64) -> [f32; 4] {
        let x = (self.cos * u + self.sin * v) / self.scale_x;
        let y = (-self.sin * u + self.cos * v) / self.scale_y;
        let distance = self.distance(x, y);
        let outer = (0.5 - distance / self.antialias).clamp(0.0, 1.0) as f32;
        let inner = if self.stroke_width != 0.0 {
            (0.5 - (distance + self.stroke_width) / self.antialias).clamp(0.0, 1.0) as f32
        } else {
            outer
        };
        let outline = outer - inner;
        let fill = if self.filled { inner } else { 0.0 };
        [
            self.fill[0] * fill + self.stroke[0] * outline,
            self.fill[1] * fill + self.stroke[1] * outline,
            self.fill[2] * fill + self.stroke[2] * outline,
            outline + fill,
        ]
    }
}

/// # Safety
/// The shape and output buffers are valid and aligned. Outputs are
/// independent and have tile height * tile width elements.
#[no_mangle]
pub unsafe extern "C" fn arachne_raster_shape_v1(
    shape: *const Shape,
    row_start: usize,
    row_end: usize,
    col_start: usize,
    col_end: usize,
    ids: *mut isize,
    pixels: *mut [f32; 4],
) -> usize {
    use std::slice::from_raw_parts_mut;
    let len = (row_end - row_start) * (col_end - col_start);
    let (shape, ids, pixels) = unsafe {
        (&*shape, from_raw_parts_mut(ids, len), from_raw_parts_mut(pixels, len))
    };

    let raster = shape.raster as f64;
    let mut occupied = 0;
    for row in row_start..row_end {
        let v = 1.0 - ((row + shape.bottom) as f64 + 0.5) / raster - shape.cy;
        for col in col_start..col_end {
            let u = ((col + shape.left) as f64 + 0.5) / raster - shape.cx;
            let pixel = shape.pixel(u, v);
            if pixel[3] > 0.0 {
                ids[occupied] = (row * shape.tile + col) as isize;
                pixels[occupied] = pixel;
                occupied += 1;
            }
        }
    }
    occupied
}

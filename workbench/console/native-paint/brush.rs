use std::slice::{from_raw_parts, from_raw_parts_mut};

#[repr(C)]
pub struct Brush {
    width: usize,
    height: usize,
    raster: usize,
    left: usize,
    bottom: usize,
    clip_left: isize,
    clip_bottom: isize,
    clip_right: isize,
    clip_top: isize,
    footprint: f64,
    softness: f64,
    flow: f64,
    roundness: f64,
    cos: f64,
    sin: f64,
    grain: f64,
}

#[repr(C)]
pub struct ImageView {
    width: usize,
    height: usize,
}

struct Image<'a> {
    view: &'a ImageView,
    pixels: &'a [f32],
}

impl Image<'_> {
    fn tip(&self, x: f32, y: f32) -> f32 {
        let ImageView { width, height } = *self.view;
        let side = width.max(height) as f32;
        let u = (x * side + width as f32 - 1.0) * 0.5;
        let v = (y * side + height as f32 - 1.0) * 0.5;
        let left = u.floor() as isize;
        let top = v.floor() as isize;
        let fx = u as f64 - left as f64;
        let fy = v as f64 - top as f64;
        let mut coverage = 0.0_f32;
        for (column, wx) in [(left, 1.0 - fx), (left + 1, fx)] {
            for (row, wy) in [(top, 1.0 - fy), (top + 1, fy)] {
                if row >= 0 && row < height as isize && column >= 0 && column < width as isize {
                    let value = self.pixels[row as usize * width + column as usize] as f64;
                    // NumPy casts back to float32 separately after each tap.
                    coverage = (f64::from(coverage) + value * wx * wy) as f32;
                }
            }
        }
        coverage
    }

    fn grain(&self, column: usize, row: usize, raster: usize, depth: f32) -> f32 {
        if !self.pixels.is_empty() {
            let x = ((column as f64 + 0.5) * 4096.0 / raster as f64) as usize % self.view.width;
            let y = ((raster as f64 - row as f64 - 0.5) * 4096.0 / raster as f64) as usize % self.view.height;
            return 1.0 - depth * (1.0 - self.pixels[y * self.view.width + x]);
        }
        let scale = 1024.0 / raster as f64;
        let a = ((column as f64 + 0.5) * scale) as u32;
        let b = ((row as f64 + 0.5) * scale) as u32;
        let hash = a.wrapping_mul(2246822519) ^ b.wrapping_mul(3266489917);
        let hash = (hash ^ (hash >> 15)).wrapping_mul(668265263);
        1.0 - depth * ((hash ^ (hash >> 13)) & 255) as f32 / 255.0
    }
}

fn stamp(brush: &Brush, weights: &mut [f32], tip: &Image<'_>, texture: &Image<'_>, dab: [f64; 4]) {
    let [u, v, radius, strength] = dab;
    let pad = radius * brush.footprint;
    let raster = brush.raster as f64;
    let col0 = (((u - pad) * raster).floor() as isize).max(brush.left as isize).max(brush.clip_left);
    let col1 = (((u + pad) * raster).ceil() as isize).min((brush.left + brush.width) as isize).min(brush.clip_right);
    let row0 = (((v - pad) * raster).floor() as isize).max(brush.bottom as isize).max(brush.clip_bottom);
    let row1 = (((v + pad) * raster).ceil() as isize).min((brush.bottom + brush.height) as isize).min(brush.clip_top);
    if col0 >= col1 || row0 >= row1 {
        return;
    }
    let angle_cos = brush.cos as f32;
    let angle_sin = brush.sin as f32;
    let x_origin = u as f32;
    let y_origin = v as f32;
    let roundness = brush.roundness as f32;
    let radius_f32 = radius as f32;
    let tip_height = (radius * brush.roundness) as f32;
    let raster_f32 = raster as f32;
    let gain = (brush.flow * strength) as f32;
    let softness = brush.softness as f32;
    let grain = brush.grain as f32;
    for row in row0 as usize..row1 as usize {
        let y = (row as f32 + 0.5) / raster_f32 - y_origin;
        let start = (row - brush.bottom) * brush.width;
        let row_weights = &mut weights[start..start + brush.width];
        for column in col0 as usize..col1 as usize {
            let x = (column as f32 + 0.5) / raster_f32 - x_origin;
            let mut coverage = if !tip.pixels.is_empty() {
                tip.tip((angle_cos * x - angle_sin * y) / radius_f32,
                        -(angle_sin * x + angle_cos * y) / tip_height)
            } else {
                let distance = if brush.roundness < 1.0 {
                    (angle_cos * x - angle_sin * y).hypot((angle_sin * x + angle_cos * y) / roundness)
                } else {
                    x.hypot(y)
                } / radius_f32;
                ((1.0 - distance) / softness).clamp(0.0, 1.0)
            };
            if grain != 0.0 {
                coverage *= texture.grain(column, row, brush.raster, grain);
            }
            let weight = &mut row_weights[column - brush.left];
            *weight += (1.0 - *weight) * coverage * gain;
        }
    }
}

/// # Safety
/// The caller retains the contiguous arrays for this call. Dabs hold four
/// f64s per row. Tip and texture arrays fit their read-only views. Weights
/// holds width * height writable float32s, disjoint from the inputs.
#[no_mangle]
pub unsafe extern "C" fn arachne_accumulate_brush_v1(
    brush: &Brush,
    dabs: *const [f64; 4],
    count: usize,
    tip_view: &ImageView,
    tip: *const f32,
    texture_view: &ImageView,
    texture: *const f32,
    weights: *mut f32,
) {
    let (dabs, tip, texture, weights) = unsafe {
        (
            from_raw_parts(dabs, count),
            Image { view: tip_view, pixels: from_raw_parts(tip, tip_view.width * tip_view.height) },
            Image { view: texture_view, pixels: from_raw_parts(texture, texture_view.width * texture_view.height) },
            from_raw_parts_mut(weights, brush.width * brush.height),
        )
    };
    for &dab in dabs {
        stamp(brush, weights, &tip, &texture, dab);
    }
}

//! Bilinear sampling of a sparse, premultiplied paint selection.

use crate::pixel_index::lower_bound;
use std::slice::{from_raw_parts, from_raw_parts_mut};

#[repr(C)]
pub struct PaintFrame {
    width: usize,
    height: usize,
    raster_width: usize,
    raster_height: usize,
    left: usize,
    bottom: usize,
}

#[repr(C)]
pub struct PaintPlane {
    alpha: *const f32,
    pixels: *const f32,
    components: usize,
    out_alpha: *mut f32,
    out_pixels: *mut f32,
}

struct PlaneBuffers<'a> {
    alpha: &'a [f32],
    pixels: &'a [f32],
    components: usize,
    out_alpha: &'a mut [f32],
    out_pixels: &'a mut [f32],
}

impl PlaneBuffers<'_> {
    fn sample(&mut self, destination: usize, taps: &[(usize, f32)]) {
        let mut alpha = 0.0;
        let start = destination * self.components;
        let output = &mut self.out_pixels[start..start + self.components];
        output.fill(0.0);
        for &(source, weight) in taps {
            alpha += self.alpha[source] * weight;
            let first = source * self.components;
            for (value, &input) in output.iter_mut().zip(&self.pixels[first..first + self.components]) {
                *value += input * weight;
            }
        }
        self.out_alpha[destination] = alpha;
    }
}

/// # Safety
/// The sorted texels, selection flags and optional coverage have source_len
/// entries. u, v and occupied have count entries. Each plane reads source_len
/// alpha values and source_len * components premultiplied values, and writes
/// count alpha values and count * components values. All mutable buffers are
/// disjoint and all borrowed buffers are aligned and retained during the call.
#[no_mangle]
pub unsafe extern "C" fn arachne_sample_paint_selection_v1(
    frame: *const PaintFrame,
    texels: *const i32,
    selected: *const u8,
    coverage: *const f32,
    source_len: usize,
    u: *const f64,
    v: *const f64,
    count: usize,
    planes: *const PaintPlane,
    plane_count: usize,
    occupied: *mut u8,
) {
    let (frame, texels, selected, coverage, u, v, planes, occupied) = unsafe {
        (
            &*frame,
            from_raw_parts(texels, source_len),
            from_raw_parts(selected, source_len),
            (!coverage.is_null()).then(|| from_raw_parts(coverage, source_len)),
            from_raw_parts(u, count),
            from_raw_parts(v, count),
            from_raw_parts(planes, plane_count),
            from_raw_parts_mut(occupied, count),
        )
    };
    let mut buffers: Vec<_> = planes
        .iter()
        .map(|plane| unsafe {
            PlaneBuffers {
                alpha: from_raw_parts(plane.alpha, source_len),
                pixels: from_raw_parts(plane.pixels, source_len * plane.components),
                components: plane.components,
                out_alpha: from_raw_parts_mut(plane.out_alpha, count),
                out_pixels: from_raw_parts_mut(plane.out_pixels, count * plane.components),
            }
        })
        .collect();

    let mut cursors = [[0; 2]; 2];
    for (index, flag) in occupied.iter_mut().enumerate() {
        let x = u[index] * frame.raster_width as f64 - 0.5 - frame.left as f64;
        let y = (1.0 - v[index]) * frame.raster_height as f64 - 0.5 - frame.bottom as f64;
        let (col, row) = (x.floor() as isize, y.floor() as isize);
        let (fx, fy) = (x - col as f64, y - row as f64);
        let mut taps = [(0, 0.0); 4];
        let mut count = 0;
        // Columns are the outer loop in the authored compositor. Keep that
        // accumulation order and round each contribution to f32 first.
        for (dx, wx) in [1.0 - fx, fx].into_iter().enumerate() {
            let x = col.saturating_add(dx as isize) as usize;
            if x >= frame.width {
                continue;
            }
            for (dy, wy) in [1.0 - fy, fy].into_iter().enumerate() {
                let y = row.saturating_add(dy as isize) as usize;
                let weight = wx * wy;
                if y >= frame.height || !(weight > 1e-6) {
                    continue;
                }
                let key = (y * frame.width + x) as i32;
                let cursor = &mut cursors[dx][dy];
                *cursor = lower_bound(texels, key, *cursor);
                if texels.get(*cursor) == Some(&key) && selected[*cursor] != 0 {
                    let weight = weight as f32 * coverage.map_or(1.0, |values| values[*cursor]);
                    taps[count] = (*cursor, weight);
                    count += 1;
                }
            }
        }
        *flag = (count > 0) as u8;
        for plane in &mut buffers {
            plane.sample(index, &taps[..count]);
        }
    }
}

//! Apply and sample sparse document masks without materializing index gathers.

use crate::pixel_index::lower_bound;
use std::slice::{from_raw_parts, from_raw_parts_mut};

struct Mask<'a> {
    ids: &'a [i32],
    alpha: &'a [f32],
    value: &'a [f32],
}

impl Mask<'_> {
    fn lookup(&self, key: i32, previous: &mut usize) -> Option<(f32, f32)> {
        *previous = lower_bound(self.ids, key, *previous);
        let index = *previous;
        if self.ids.get(index) == Some(&key) {
            Some((self.alpha[index], self.value[index]))
        } else {
            None
        }
    }
}

/// # Safety
/// The authored mask buffers contain mask_len values and IDs in sorted
/// order. The borrowed target IDs and writable values contain count
/// elements and do not overlap each other or the mask.
#[no_mangle]
pub unsafe extern "C" fn arachne_apply_sparse_mask_v1(
    ids: *const i32,
    alpha: *const f32,
    value: *const f32,
    mask_len: usize,
    queries: *const i32,
    output: *mut f32,
    count: usize,
) {
    let (mask, queries, output) = unsafe {
        (
            Mask {
                ids: from_raw_parts(ids, mask_len),
                alpha: from_raw_parts(alpha, mask_len),
                value: from_raw_parts(value, mask_len),
            },
            from_raw_parts(queries, count),
            from_raw_parts_mut(output, count),
        )
    };
    let mut previous = 0;
    for (&query, base) in queries.iter().zip(output) {
        if let Some((alpha, value)) = mask.lookup(query, &mut previous) {
            *base = *base * (1.0 - alpha) + value;
        }
    }
}

/// # Safety
/// The three authored buffers share mask_len and sorted IDs. Coordinates
/// and independent writable outputs have count elements. The finite UV
/// inputs are normalized against the raster, with a possibly cropped
/// source of size * size whose local origin is offset by left and bottom.
#[no_mangle]
pub unsafe extern "C" fn arachne_sample_sparse_mask_v1(
    ids: *const i32,
    alpha: *const f32,
    value: *const f32,
    mask_len: usize,
    size: usize,
    raster: usize,
    left: usize,
    bottom: usize,
    u: *const f64,
    v: *const f64,
    count: usize,
    out_alpha: *mut f32,
    out_value: *mut f32,
) {
    let (mask, us, vs, out_alpha, out_value) = unsafe {
        (
            Mask {
                ids: from_raw_parts(ids, mask_len),
                alpha: from_raw_parts(alpha, mask_len),
                value: from_raw_parts(value, mask_len),
            },
            from_raw_parts(u, count),
            from_raw_parts(v, count),
            from_raw_parts_mut(out_alpha, count),
            from_raw_parts_mut(out_value, count),
        )
    };
    let mut cursors = [[0; 2]; 2];
    for index in 0..count {
        let x = us[index] * raster as f64 - 0.5 - left as f64;
        let y = (1.0 - vs[index]) * raster as f64 - 0.5 - bottom as f64;
        let (col, row) = (x.floor() as isize, y.floor() as isize);
        let (fx, fy) = (x - col as f64, y - row as f64);
        let mut opacity = 0.0_f32;
        let mut coverage = 0.0_f32;
        for (dy, wy) in [1.0 - fy, fy].into_iter().enumerate() {
            let y = (row + dy as isize) as usize;
            if y >= size {
                continue;
            }
            for (dx, wx) in [1.0 - fx, fx].into_iter().enumerate() {
                let x = (col + dx as isize) as usize;
                if x >= size {
                    continue;
                }
                let key = (y * size + x) as i32;
                if let Some((a,b)) = mask.lookup(key, &mut cursors[dy][dx]) {
                    opacity = (f64::from(opacity) + f64::from(a) * wx * wy) as f32;
                    coverage = (f64::from(coverage) + f64::from(b) * wx * wy) as f32;
                }
            }
        }
        out_alpha[index] = opacity;
        out_value[index] = coverage;
    }
}

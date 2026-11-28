//! Convert between straight bytes and linear premultiplied document pixels.

const BUCKETS: usize = 4096;

fn srgb_byte(value: f32, codes: &[u8; BUCKETS + 1], boundaries: &[f32; 256]) -> u8 {
    let value = value.max(0.0).min(1.0);
    let bucket = (value * BUCKETS as f32) as usize;
    let code = codes[bucket];
    code + (value >= boundaries[code as usize]) as u8
}

/// Encode a contiguous batch using quantization boundaries from the reference
/// f32 transfer function. Any bucket crosses at most one 8-bit boundary.
///
/// # Safety
/// The input and output each contain count RGBA pixels and do not overlap.
/// The two lookup buffers are readable for their fixed lengths. Code 255
/// has an infinite next boundary and the transfer maps to 0 through 255.
#[no_mangle]
pub unsafe extern "C" fn arachne_encode_srgb_v1(
    pixels: *const [f32; 4],
    count: usize,
    codes: *const [u8; BUCKETS + 1],
    boundaries: *const [f32; 256],
    output: *mut [u8; 4],
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (pixels, codes, boundaries, output) = unsafe {
        (
            from_raw_parts(pixels, count),
            &*codes,
            &*boundaries,
            from_raw_parts_mut(output, count),
        )
    };
    for (pixel, destination) in pixels.iter().zip(output) {
        let [r, g, b, alpha] = *pixel;
        *destination = if alpha > 0.0 {
            [
                srgb_byte(r / alpha, codes, boundaries),
                srgb_byte(g / alpha, codes, boundaries),
                srgb_byte(b / alpha, codes, boundaries),
                (alpha.min(1.0) * 255.0).round_ties_even() as u8,
            ]
        } else {
            [0; 4]
        };
    }
}

/// Decode RGBA bytes using the selected working space's transfer table.
/// Rows may be written in reverse order for the compositor's UV raster.
///
/// # Safety
/// Input and output contain width * height pixels and do not overlap. Width
/// is positive. The color and alpha tables each contain all 256 byte values.
#[no_mangle]
pub unsafe extern "C" fn arachne_decode_rgba_v1(
    pixels: *const [u8; 4],
    width: usize,
    height: usize,
    color: *const [f32; 256],
    alpha: *const [f32; 256],
    reverse_rows: bool,
    output: *mut [f32; 4],
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (pixels, color, alpha, output) = unsafe {
        (
            from_raw_parts(pixels, width * height),
            &*color,
            &*alpha,
            from_raw_parts_mut(output, width * height),
        )
    };

    for (y, target) in output.chunks_exact_mut(width).enumerate() {
        let y = if reverse_rows { height - 1 - y } else { y };
        let source = &pixels[y * width..(y + 1) * width];
        for (&[r, g, b, a], destination) in source.iter().zip(target) {
            let a = alpha[a as usize];
            *destination = [
                color[r as usize] * a,
                color[g as usize] * a,
                color[b as usize] * a,
                a,
            ];
        }
    }
}

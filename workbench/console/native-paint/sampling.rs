//! Bilinear sampling of premultiplied RGBA sources for editable transforms.

fn sample_axis(coordinate: f64, size: usize) -> (usize, usize, f64) {
    let source = (coordinate * size as f64 - 0.5).clamp(0.0, (size - 1) as f64);
    let near = source as usize;
    (near, (near + 1).min(size - 1), source - near as f64)
}

/// Sample a premultiplied RGBA source at top-left-origin normalized points.
///
/// # Safety
/// The source has width * height pixels and positive dimensions. Both input
/// coordinate arrays and both independent outputs have count elements. The
/// caller retains all aligned buffers and coordinates are finite.
#[no_mangle]
pub unsafe extern "C" fn arachne_sample_bilinear_v1(
    image: *const [f32; 4],
    width: usize,
    height: usize,
    u: *const f64,
    v: *const f64,
    count: usize,
    output: *mut [f32; 4],
    occupied: *mut u8,
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (image, u, v, output, occupied) = unsafe {
        (
            from_raw_parts(image, width * height),
            from_raw_parts(u, count),
            from_raw_parts(v, count),
            from_raw_parts_mut(output, count),
            from_raw_parts_mut(occupied, count),
        )
    };
    for index in 0..count {
        let (x0, x1, x) = sample_axis(u[index], width);
        let (y0, y1, y) = sample_axis(v[index], height);
        let lo = &image[y0 * width..(y0 + 1) * width];
        let hi = &image[y1 * width..(y1 + 1) * width];
        for channel in 0..4 {
            let top = f64::from(lo[x0][channel]) * (1.0 - x) + f64::from(lo[x1][channel]) * x;
            let bottom = f64::from(hi[x0][channel]) * (1.0 - x) + f64::from(hi[x1][channel]) * x;
            let value = top * (1.0 - y) + bottom * y;
            output[index][channel] = value as f32;
            if channel == 3 {
                occupied[index] = (value > 0.0) as u8;
            }
        }
    }
}

fn affine_axis(center: f64, size: usize) -> (usize, usize, f64) {
    let coordinate = center - 0.5;
    let near = coordinate.floor() as isize;
    (
        near.max(0) as usize,
        ((near + 1) as usize).min(size - 1),
        coordinate - near as f64,
    )
}

/// Apply an inverse affine transform to a packed premultiplied RGBA image.
/// The result uses the compositor's bottom-to-top row order.
/// Uses the fused arithmetic of the macOS arm64 Pillow wheel.
///
/// # Safety
/// The source and the disjoint output hold the specified pixel counts, their
/// dimensions are positive, and the six affine coefficients are finite.
/// The output has rows * out_width pixels, with bottom_start + rows at most
/// out_height.
#[no_mangle]
pub unsafe extern "C" fn arachne_sample_affine_v1(
    image: *const [f32; 4],
    width: usize,
    height: usize,
    coefficients: *const [f64; 6],
    out_width: usize,
    out_height: usize,
    bottom_start: usize,
    rows: usize,
    output: *mut [f32; 4],
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (image, [a, b, c, d, e, f], output) = unsafe {
        (
            from_raw_parts(image, width * height),
            *coefficients,
            from_raw_parts_mut(output, out_width * rows),
        )
    };
    let top_start = out_height - bottom_start - rows;
    for (out_y, row) in output.rchunks_exact_mut(out_width).enumerate() {
        let y = (top_start + out_y) as f64 + 0.5;
        for (out_x, pixel) in row.iter_mut().enumerate() {
            let x = out_x as f64 + 0.5;
            let source_x = a.mul_add(x, b * y) + c;
            let source_y = d.mul_add(x, e * y) + f;
            if !(0.0..width as f64).contains(&source_x) || !(0.0..height as f64).contains(&source_y) {
                *pixel = [0.0; 4];
                continue;
            }
            let (left, right, dx) = affine_axis(source_x, width);
            let (top, bottom, dy) = affine_axis(source_y, height);
            let (p00, p01) = (image[top * width + left], image[top * width + right]);
            let (p10, p11) = (image[bottom * width + left], image[bottom * width + right]);
            for channel in 0..4 {
                // The legacy affine sampler takes each horizontal difference in
                // source precision and carries the interpolation in f64.
                let hi = f64::from(p01[channel] - p00[channel]).mul_add(dx, f64::from(p00[channel]));
                let lo = f64::from(p11[channel] - p10[channel]).mul_add(dx, f64::from(p10[channel]));
                pixel[channel] = (lo - hi).mul_add(dy, hi) as f32;
            }
        }
    }
}

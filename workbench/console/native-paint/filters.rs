//! Extended box passes shared by Gaussian adjustments and feathered masks.

struct BoxPass {
    padding: usize,
    width: usize,
    edge: f32,
    divisor: f64,
    samples: Vec<f32>,
    totals: Vec<f64>,
}

impl BoxPass {
    fn lines(
        &mut self,
        pixels: &mut [f32],
        start: usize,
        stride: usize,
        length: usize,
        lanes: usize,
    ) {
        let rows = length + 2 * self.padding;
        let samples = &mut self.samples[..rows * lanes];
        let totals = &mut self.totals[..(rows + 1) * lanes];
        if stride == lanes {
            let live_start = self.padding * lanes;
            let live_end = live_start + length * lanes;
            samples[live_start..live_end].copy_from_slice(&pixels[start..start + length * lanes]);
            for row in samples[..live_start].chunks_exact_mut(lanes) {
                row.copy_from_slice(&pixels[start..start + lanes]);
            }
            let last = start + (length - 1) * lanes;
            for row in samples[live_end..].chunks_exact_mut(lanes) {
                row.copy_from_slice(&pixels[last..last + lanes]);
            }
        } else {
            for (index, row) in samples.chunks_exact_mut(lanes).enumerate() {
                let source = start + index.saturating_sub(self.padding).min(length - 1) * stride;
                row.copy_from_slice(&pixels[source..source + lanes]);
            }
        }

        // Preserve the reference's prefix order, including repeated edge
        // samples. The outer taps round to f32 before joining the f64 sum.
        totals[..lanes].fill(0.0);
        if lanes == 1 {
            let mut total = 0.0;
            for (&value, out) in samples.iter().zip(&mut totals[1..]) {
                total += f64::from(value);
                *out = total;
            }
        } else {
            for (index, row) in samples.chunks_exact(lanes).enumerate() {
                let (previous, next) = totals.split_at_mut((index + 1) * lanes);
                let previous = &previous[index * lanes..];
                for ((out, &total), &value) in next[..lanes].iter_mut().zip(previous).zip(row) {
                    *out = total + f64::from(value);
                }
            }
        }

        for row in 0..length {
            let out = start + row * stride;
            let near = row * lanes;
            let far = (row + self.width + 1) * lanes;
            let after_near = &totals[near + lanes..near + 2 * lanes];
            let after_core = &totals[far..far + lanes];
            let outer_near = &samples[near..near + lanes];
            let outer_far = &samples[far..far + lanes];
            for lane in 0..lanes {
                let core = after_core[lane] - after_near[lane];
                let edge = (outer_near[lane] + outer_far[lane]) * self.edge;
                pixels[out + lane] = ((core + f64::from(edge)) / self.divisor) as f32;
            }
        }
    }
}

fn blur(pixels: &mut [f32], height: usize, width: usize, channels: usize, half: usize, edge: f64) {
    let padding = half + 1;
    let box_width = 2 * half + 1;
    let row_length = width * channels;
    let strip = (32 * channels).min(row_length);
    let scratch_size = ((height + 2 * padding) * strip).max((width + 2 * padding) * channels);
    let mut pass = BoxPass {
        padding,
        width: box_width,
        edge: edge as f32,
        divisor: box_width as f64 + 2.0 * edge,
        samples: vec![0.0; scratch_size],
        totals: vec![0.0; scratch_size + strip],
    };
    for _ in 0..3 {
        if height > 1 {
            for start in (0..row_length).step_by(strip) {
                pass.lines(pixels, start, row_length, height, strip.min(row_length - start));
            }
        }
        if width > 1 {
            for row in 0..height {
                pass.lines(pixels, row * row_length, channels, width, channels);
            }
        }
    }
}

/// Blur in place using three vertical/horizontal extended box passes.
///
/// # Safety
/// The pointer is aligned and writable for height * width * channels floats.
/// Dimensions are positive and all padded scratch sizes fit in memory.
#[no_mangle]
pub unsafe extern "C" fn arachne_gaussian_blur_v1(
    pixels: *mut f32,
    height: usize,
    width: usize,
    channels: usize,
    half: usize,
    edge: f64,
) {
    let pixels = unsafe { std::slice::from_raw_parts_mut(pixels, height * width * channels) };
    blur(pixels, height, width, channels, half, edge);
}

fn include_row<T: PartialOrd + Default + Copy>(
    row: &[T],
    stride: usize,
    y: usize,
    bounds: &mut [usize; 4],
) {
    let mut samples = row.iter().step_by(stride);
    if let Some(left) = samples.clone().position(|&value| value > T::default()) {
        let right = samples.rposition(|&value| value > T::default()).unwrap() + 1;
        bounds[0] = bounds[0].min(y);
        bounds[1] = y + 1;
        bounds[2] = bounds[2].min(left);
        bounds[3] = bounds[3].max(right);
    }
}

/// Find the occupied rectangle in a normalized document-alpha plane.
///
/// # Safety
/// Each of height input rows contains width alpha values separated by a
/// stride of 1 or 4 elements. The row and pixel strides are in elements.
/// The independent output is writable for four usize values.
#[no_mangle]
pub unsafe extern "C" fn arachne_alpha_bounds_v1(
    alpha: *const std::ffi::c_void,
    height: usize,
    width: usize,
    row_stride: usize,
    pixel_stride: usize,
    is_byte: bool,
    output: *mut [usize; 4],
) {
    use std::slice::from_raw_parts;
    let mut bounds = [height, 0, width, 0];
    let length = (width - 1) * pixel_stride + 1;
    if is_byte {
        let alpha = alpha.cast::<u8>();
        for y in 0..height {
            let row = unsafe { from_raw_parts(alpha.add(y * row_stride), length) };
            include_row(row, pixel_stride, y, &mut bounds);
        }
    } else {
        let alpha = alpha.cast::<f32>();
        for y in 0..height {
            let row = unsafe { from_raw_parts(alpha.add(y * row_stride), length) };
            include_row(row, pixel_stride, y, &mut bounds);
        }
    }
    unsafe { *output = bounds; }
}

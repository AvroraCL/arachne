//! Premultiplied compositing for common drawing-layer modes.

const NORMAL: u8 = 0;
const MULTIPLY: u8 = 1;
const SCREEN: u8 = 2;
const OVERLAY: u8 = 3;

fn blend<const MODE: u8>(back: f32, source: f32) -> f32 {
    match MODE {
        NORMAL => source,
        MULTIPLY => back * source,
        SCREEN => back + source - back * source,
        OVERLAY if back <= 0.5 => 2.0 * back * source,
        OVERLAY => 1.0 - 2.0 * (1.0 - back) * (1.0 - source),
        _ => unreachable!(),
    }
}

fn composite<const MODE: u8>(
    back: &mut [f32; 4],
    source: &[f32; 4],
    opacity: f32,
    clipped: bool,
) {
    let back_alpha = back[3];
    let source_alpha = source[3] * opacity;
    let remaining = 1.0 - source_alpha;
    if MODE == NORMAL && !clipped {
        for channel in 0..3 {
            back[channel] = back[channel] * remaining + source[channel] * opacity;
        }
    } else {
        for channel in 0..3 {
            let ink = if source[3] > 0.0 { source[channel] / source[3] } else { 0.0 };
            let base = if back_alpha > 0.0 { back[channel] / back_alpha } else { 0.0 };
            let mixed = blend::<MODE>(base, ink);
            if clipped {
                back[channel] += (mixed * back_alpha - back[channel]) * source_alpha;
            } else {
                let premult = source_alpha * ((1.0 - back_alpha) * ink + back_alpha * mixed);
                back[channel] = back[channel] * remaining + premult;
            }
        }
    }
    if !clipped {
        back[3] = source_alpha + back_alpha * remaining;
    }
}

fn tile<const MODE: u8>(
    target: &mut [[f32; 4]],
    ids: &[isize],
    source: &[[f32; 4]],
    opacity: f32,
    weights: Option<&[f32]>,
    clipped: bool,
) {
    if let Some(weights) = weights {
        for ((&id, pixel), &weight) in ids.iter().zip(source).zip(weights) {
            composite::<MODE>(&mut target[id as usize], pixel, weight, clipped);
        }
    } else {
        for (&id, pixel) in ids.iter().zip(source) {
            composite::<MODE>(&mut target[id as usize], pixel, opacity, clipped);
        }
    }
}

/// # Safety
/// The target is aligned and writable for target_len pixels and does not
/// overlap its inputs. IDs are distinct, valid target indices. Other arrays
/// have count elements. Mask may be null for a constant opacity.
#[no_mangle]
pub unsafe extern "C" fn arachne_composite_tile_v1(
    target: *mut [f32; 4],
    target_len: usize,
    ids: *const isize,
    source: *const [f32; 4],
    count: usize,
    opacity: f32,
    mask: *const f32,
    mode: u8,
    clipped: bool,
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (target, ids, source) = unsafe {
        (
            from_raw_parts_mut(target, target_len),
            from_raw_parts(ids, count),
            from_raw_parts(source, count),
        )
    };
    let weights = if mask.is_null() { None } else { Some(unsafe { from_raw_parts(mask, count) }) };
    match mode {
        NORMAL => tile::<NORMAL>(target, ids, source, opacity, weights, clipped),
        MULTIPLY => tile::<MULTIPLY>(target, ids, source, opacity, weights, clipped),
        SCREEN => tile::<SCREEN>(target, ids, source, opacity, weights, clipped),
        OVERLAY => tile::<OVERLAY>(target, ids, source, opacity, weights, clipped),
        _ => unreachable!(),
    }
}

//! Apply one stroke's opacity to a sparse premultiplied paint channel.

fn apply<const CHANNELS: usize>(
    alpha: &mut [f32],
    channel: &mut [f32],
    ids: &[isize],
    coverage: &[f32],
    value: &[f32],
    erase: bool,
    lock_alpha: bool,
) {
    for (&id, &weight) in ids.iter().zip(coverage) {
        let index = id as usize;
        let remaining = 1.0 - weight;
        let destination = &mut channel[index * CHANNELS..(index + 1) * CHANNELS];
        if lock_alpha {
            let amount = alpha[index] * weight;
            for (stored, &ink) in destination.iter_mut().zip(value) {
                *stored = *stored * remaining + amount * ink;
            }
        } else if erase {
            for stored in destination {
                *stored *= remaining;
            }
            alpha[index] *= remaining;
        } else {
            for (stored, &ink) in destination.iter_mut().zip(value) {
                *stored = *stored * remaining + weight * ink;
            }
            alpha[index] = alpha[index] * remaining + weight;
        }
    }
}

/// # Safety
/// The independent writable buffers contain target_len alpha values and
/// target_len * channels premultiplied values. IDs are distinct, in bounds,
/// and have a corresponding weight. Value has either one or three channels.
#[no_mangle]
pub unsafe extern "C" fn arachne_apply_paint_channel_v1(
    alpha: *mut f32,
    channel: *mut f32,
    target_len: usize,
    channels: usize,
    ids: *const isize,
    coverage: *const f32,
    count: usize,
    value: *const f32,
    erase: bool,
    lock_alpha: bool,
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (alpha, channel, ids, coverage, value) = unsafe {
        (
            from_raw_parts_mut(alpha, target_len),
            from_raw_parts_mut(channel, target_len * channels),
            from_raw_parts(ids, count),
            from_raw_parts(coverage, count),
            from_raw_parts(value, channels),
        )
    };
    match channels {
        1 => apply::<1>(alpha, channel, ids, coverage, value, erase, lock_alpha),
        3 => apply::<3>(alpha, channel, ids, coverage, value, erase, lock_alpha),
        _ => unreachable!(),
    }
}

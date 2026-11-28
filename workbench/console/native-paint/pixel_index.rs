//! Lower bounds for batches of pixel IDs, which commonly arrive in scan order.

pub(crate) fn lower_bound(table: &[i32], key: i32, current: usize) -> usize {
    if current > 0 && table[current - 1] >= key {
        table[..current].partition_point(|&value| value < key)
    } else if current < table.len() && table[current] < key {
        let tail = &table[current + 1..];
        let mut span = 1;
        while span <= tail.len() && tail[span - 1] < key {
            span *= 2;
        }
        let start = (span / 2).min(tail.len());
        let end = span.min(tail.len());
        current + 1 + start + tail[start..end].partition_point(|&value| value < key)
    } else {
        current
    }
}

fn lower_bounds(table: &[i32], queries: &[i32], indices: &mut [usize]) {
    let mut current = 0;
    for (&key, position) in queries.iter().zip(indices) {
        current = lower_bound(table, key, current);
        *position = current;
    }
}

/// Resolve one batch of insertion indices in a sorted pixel table.
///
/// # Safety
/// All buffers are aligned and valid for their declared lengths. The result
/// holds query_len elements and does not overlap either input.
#[no_mangle]
pub unsafe extern "C" fn arachne_pixel_lower_bounds_v1(
    table: *const i32,
    table_len: usize,
    queries: *const i32,
    query_len: usize,
    indices: *mut usize,
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (table, queries, indices) = unsafe {
        (
            from_raw_parts(table, table_len),
            from_raw_parts(queries, query_len),
            from_raw_parts_mut(indices, query_len),
        )
    };
    lower_bounds(table, queries, indices);
}

#[repr(C)]
pub struct PixelBatch {
    ids: *const i32,
    len: usize,
}

/// Fill a bitmap and return the number of distinct pixel IDs.
///
/// # Safety
/// Each input batch is readable for its declared length and holds IDs
/// within the bitmap. The bitmap is initialized to zero and is writable
/// for word_count words. None of the input arrays overlaps it.
#[no_mangle]
pub unsafe extern "C" fn arachne_mark_pixel_union_v1(
    batches: *const PixelBatch,
    batch_count: usize,
    bitmap: *mut u64,
    word_count: usize,
) -> usize {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (batches, bitmap) = unsafe {
        (from_raw_parts(batches, batch_count), from_raw_parts_mut(bitmap, word_count))
    };
    let mut count = 0;
    for batch in batches {
        let ids = unsafe { from_raw_parts(batch.ids, batch.len) };
        for &id in ids {
            let id = id as usize;
            let mask = 1_u64 << (id % 64);
            let word = &mut bitmap[id / 64];
            count += (*word & mask == 0) as usize;
            *word |= mask;
        }
    }
    count
}

/// Write the distinct IDs in ascending order.
///
/// # Safety
/// Both buffers are valid for their declared lengths and do not overlap.
/// The number of set bits is output_len and all indices fit in i32.
#[no_mangle]
pub unsafe extern "C" fn arachne_read_pixel_union_v1(
    bitmap: *const u64,
    word_count: usize,
    output: *mut i32,
    output_len: usize,
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};
    let (bitmap, output) = unsafe {
        (from_raw_parts(bitmap, word_count), from_raw_parts_mut(output, output_len))
    };
    let mut next = output.iter_mut();
    for (index, &word) in bitmap.iter().enumerate() {
        let mut remaining = word;
        while remaining != 0 {
            *next.next().unwrap() = (index * 64 + remaining.trailing_zeros() as usize) as i32;
            remaining &= remaining - 1;
        }
    }
}

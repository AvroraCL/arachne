//! Scanline flood fill for the magic wand and contiguous paint bucket.

use std::ops::Range;
use std::slice::{from_raw_parts, from_raw_parts_mut};

fn visit_row(
    matching: &[u8],
    reached: &mut [u8],
    width: usize,
    row: usize,
    span: Range<usize>,
    pending: &mut Vec<(usize, Range<usize>)>,
) {
    let offset = row * width;
    let matching = &matching[offset..offset + width];
    let reached = &mut reached[offset..offset + width];
    let mut column = span.start;
    while column < span.end {
        if matching[column] == 0 || reached[column] != 0 {
            column += 1;
            continue;
        }

        // A visited run was marked from end to end, so an unvisited
        // matching pixel cannot be part of a previously reached run.
        let mut left = column;
        while left > 0 && matching[left - 1] != 0 {
            left -= 1;
        }
        let mut right = column + 1;
        while right < width && matching[right] != 0 {
            right += 1;
        }
        reached[left..right].fill(1);
        pending.push((row, left..right));
        column = right;
    }
}

fn connected_area(
    matching: &[u8],
    width: usize,
    height: usize,
    row: usize,
    column: usize,
    reached: &mut [u8],
) {
    let mut pending = Vec::new();
    visit_row(matching, reached, width, row, column..column + 1, &mut pending);

    // Only overlapping columns connect adjacent rows. Diagonal contact does
    // not extend a contiguous selection.
    while let Some((row, span)) = pending.pop() {
        if row > 0 {
            visit_row(matching, reached, width, row - 1, span.clone(), &mut pending);
        }
        if row + 1 < height {
            visit_row(matching, reached, width, row + 1, span, &mut pending);
        }
    }
}

/// # Safety
/// The caller supplies two non-overlapping buffers of width * height bytes.
/// The seed is inside the image and the output is initialized to zero.
#[no_mangle]
pub unsafe extern "C" fn arachne_connected_area_v1(
    matching: *const u8,
    width: usize,
    height: usize,
    row: usize,
    column: usize,
    reached: *mut u8,
) {
    let count = width * height;
    // The Python binding validates the seed and owns both contiguous buffers.
    let (matching, reached) = unsafe {
        (from_raw_parts(matching, count), from_raw_parts_mut(reached, count))
    };
    connected_area(matching, width, height, row, column, reached);
}

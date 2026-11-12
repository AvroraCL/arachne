"""Spatial filters for linear premultiplied drawing-document pixels."""
import math

import numpy as np


def gaussian_box(radius):
    # Three extended box passes approximate a Gaussian. Fractional outer taps
    # match the requested variance and keep small radii smooth in live previews.
    variance = radius * radius / 3
    half = int((math.sqrt(1 + 12 * variance) - 1) / 2)
    width = 2 * half + 1
    inner_variance = half * (half + 1) / 3
    edge = width * (variance - inner_variance) / (2 * ((half + 1) ** 2 - variance))
    return half, min(1, max(0, edge))


def alpha_bounds(alpha, padding):
    rows = np.flatnonzero(alpha.max(axis=1) > 0)
    if not len(rows):
        return None
    columns = np.flatnonzero(alpha.max(axis=0) > 0)
    return (max(0, rows[0] - padding), min(alpha.shape[0], rows[-1] + padding + 1),
            max(0, columns[0] - padding), min(alpha.shape[1], columns[-1] + padding + 1))


def blur_gaussian(pixels, half, edge):
    padding = half + 1
    width = 2 * half + 1
    for _ in range(3):
        for axis in (0, 1):
            lines = np.moveaxis(pixels, axis, 0)
            length = len(lines)
            if length < 2:
                continue
            # Process independent scan lines in strips to keep scratch memory
            # small. Clamping at the canvas edge preserves solid backgrounds.
            for start in range(0, lines.shape[1], 32):
                strip = lines[:, start:start + 32]
                samples = np.pad(strip, ((padding, padding), (0, 0), (0, 0)), mode='edge')
                totals = np.cumsum(samples, axis=0, dtype=np.float64)
                core = totals[width:width + length] - totals[:length]
                outer = samples[:length] + samples[width + 1:width + 1 + length]
                strip[:] = (core + edge * outer) / (width + 2 * edge)

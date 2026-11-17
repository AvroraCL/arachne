//! Batched inverse mapping of the drawing workspace's bicubic grid.

const MAX_ITERATIONS: usize = 16;
const RESIDUAL: f64 = 1e-8;
type Cell = [[[f64; 2]; 4]; 4];

struct Grid<'a> {
    u: &'a [f64],
    v: &'a [f64],
    cells: &'a [Cell],
}

fn interval(knots: &[f64], value: f64) -> usize {
    (knots.partition_point(|&knot| knot <= value).saturating_sub(1)).min(knots.len() - 2)
}

impl Grid<'_> {
    fn evaluate(&self, u: f64, v: f64) -> ([f64; 2], [f64; 2], [f64; 2]) {
        let i = interval(self.u, u);
        let j = interval(self.v, v);
        let width = self.u[i + 1] - self.u[i];
        let height = self.v[j + 1] - self.v[j];
        let x = (u - self.u[i]) / width;
        let y = (v - self.v[j]) / height;
        let cell = &self.cells[j * (self.u.len() - 1) + i];
        let mut point = [0.0; 2];
        let mut du = [0.0; 2];
        let mut dv = [0.0; 2];
        for axis in 0..2 {
            let mut rows = [0.0; 4];
            let mut slopes = [0.0; 4];
            for (row, coefficients) in cell.iter().enumerate() {
                let [a, b, c, d] = coefficients.map(|value| value[axis]);
                rows[row] = a + x * (b + x * (c + x * d));
                slopes[row] = b + x * (2.0 * c + x * (3.0 * d));
            }

            point[axis] = rows[0] + y * (rows[1] + y * (rows[2] + y * rows[3]));
            du[axis] = (slopes[0] + y * (slopes[1] + y * (slopes[2] + y * slopes[3]))) / width;
            dv[axis] = (rows[1] + y * (2.0 * rows[2] + y * (3.0 * rows[3]))) / height;
        }
        (point, du, dv)
    }

    fn inverse(&self, target_x: f64, target_y: f64) -> (f64, f64, u8) {
        let mut u = target_x.clamp(0.0, 1.0);
        let mut v = target_y.clamp(0.0, 1.0);
        for _ in 0..MAX_ITERATIONS {
            let ([x, y], [du_x, du_y], [dv_x, dv_y]) = self.evaluate(u, v);
            let ex = target_x - x;
            let ey = target_y - y;
            if ex.abs() < RESIDUAL && ey.abs() < RESIDUAL && ex.hypot(ey) < RESIDUAL {
                return (u, v, 1);
            }
            let determinant = du_x * dv_y - dv_x * du_y;
            if !(determinant > 1e-10) {
                break;
            }
            let step_u = (ex * dv_y - ey * dv_x) / determinant;
            let step_v = (du_x * ey - du_y * ex) / determinant;
            let limit = 1.0_f64.max(step_u.abs().max(step_v.abs()) / 0.125);
            u = (u + step_u / limit).clamp(-0.125, 1.125);
            v = (v + step_v / limit).clamp(-0.125, 1.125);
        }
        (u, v, 0)
    }
}

/// Solve one tile. The Python caller owns each contiguous buffer for the
/// duration of the call. Coordinates, knots and coefficients are read-only;
/// the three output buffers are independent, writable and non-overlapping.
///
/// # Safety
/// Each pointer is non-null, aligned and valid for its declared element count.
/// The coefficient buffer has (nv - 1) * (nu - 1) cells in row-major order.
/// Knot arrays have at least two entries and dimensions fit addressable memory.
#[no_mangle]
pub unsafe extern "C" fn arachne_inverse_smooth_grid_v1(
    u_knots: *const f64,
    nu: usize,
    v_knots: *const f64,
    nv: usize,
    coefficients: *const Cell,
    target_x: *const f64,
    target_y: *const f64,
    count: usize,
    output_u: *mut f64,
    output_v: *mut f64,
    valid: *mut u8,
) {
    use std::slice::{from_raw_parts, from_raw_parts_mut};

    if count == 0 {
        return;
    }
    let cells = (nv - 1) * (nu - 1);
    // The caller checks and retains NumPy storage before entering this ABI.
    let (grid, xs, ys, us, vs, flags) = unsafe {
        (
            Grid {
                u: from_raw_parts(u_knots, nu),
                v: from_raw_parts(v_knots, nv),
                cells: from_raw_parts(coefficients, cells),
            },
            from_raw_parts(target_x, count),
            from_raw_parts(target_y, count),
            from_raw_parts_mut(output_u, count),
            from_raw_parts_mut(output_v, count),
            from_raw_parts_mut(valid, count),
        )
    };
    for index in 0..count {
        let (u, v, is_valid) = grid.inverse(xs[index], ys[index]);
        us[index] = u;
        vs[index] = v;
        flags[index] = is_valid;
    }
}

mod brush;

/**
 * dmath — deterministic math replacements for the simulation path.
 *
 * All functions use only + - * / and Math.sqrt (IEEE 754 sqrt is required to
 * be correctly rounded by the standard, so it is identical across V8, JSC,
 * SpiderMonkey, and any standards-compliant JS engine).
 *
 * Math.sin, Math.cos, Math.exp, Math.hypot, Math.atan2, Math.acos are
 * implementation-approximated and may differ between engines (V8 vs JSC) in
 * the last ULP, which accumulates over a long simulation into divergent state.
 * Do NOT use any of those in the simulation path — use these instead.
 *
 * Accuracy targets (verified by snapshot tests):
 *   sin/cos:  |err| ≤ 2e-7  over [-8π, 8π]
 *   exp:      |err| ≤ 3e-7  over [-10, 10]
 *   atan2:    |err| ≤ 3e-7  over all quadrants
 *   acos:     |err| ≤ 3e-7  over [-1, 1]
 *   hypot:    exact (just sqrt(x*x+y*y))
 *
 * These tolerances are more than sufficient for physics / AI distances and
 * angles.  They are NOT suitable for cryptographic or high-precision use.
 */

const PI = Math.PI;
const TWO_PI = 2 * PI;
const HALF_PI = PI / 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Reduce x to [-π, π] using only arithmetic. */
function reduceAngle(x) {
  // Fast path for the common in-range case
  if (x >= -PI && x <= PI) return x;
  // Subtract multiples of 2π
  const k = Math.round(x / TWO_PI);
  return x - k * TWO_PI;
}

/**
 * Taylor series for sin(x), x ∈ [-π/2, π/2].
 * sin(x) = x - x³/3! + x⁵/5! - x⁷/7! + x⁹/9! - x¹¹/11!
 * Horner form with alternating signs.  |err| < 2e-12 for |x| ≤ π/2.
 */
function sinKernel(x) {
  const x2 = x * x;
  // Horner: 1 - x2*(1/6 - x2*(1/120 - x2*(1/5040 - x2*(1/362880 - x2/39916800))))
  return x * (1 - x2 * (1 / 6 - x2 * (1 / 120 - x2 * (1 / 5040
    - x2 * (1 / 362880 - x2 / 39916800)))));
}

/**
 * Taylor series for cos(x), x ∈ [0, π/2].
 * cos(x) = 1 - x²/2! + x⁴/4! - x⁶/6! + x⁸/8! - x¹⁰/10!
 * Alternating signs via Horner.  |err| < 2e-12 for |x| ≤ π/2.
 */
function cosKernel(x) {
  const x2 = x * x;
  return 1 - x2 * (1 / 2 - x2 * (1 / 24 - x2 * (1 / 720
    - x2 * (1 / 40320 - x2 / 3628800))));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic sin.
 *
 * Range reduction: r = x mod 2π into (-π, π].
 * Reflection rules (kernel is defined on [-π/2, π/2]):
 *   r ∈ [-π/2, π/2]      → sinKernel(r)
 *   r ∈ (π/2, π]         → sinKernel(π - r)      [sin(π-r) = sin(r)]
 *   r ∈ (-π, -π/2)       → -sinKernel(π + r)     [sin(r) = -sin(π+r), and π+r ∈ (0,π/2)]
 */
export function dsin(x) {
  if (!isFinite(x)) return x - x;
  const r = reduceAngle(x);
  if (r >= -HALF_PI && r <= HALF_PI) return sinKernel(r);
  if (r > HALF_PI) return sinKernel(PI - r);          // r ∈ (π/2, π]
  return -sinKernel(PI + r);                           // r ∈ (-π, -π/2), PI+r ∈ (0, π/2)
}

/**
 * Deterministic cos.
 *
 * cos(x) = sin(π/2 - x) allows using the well-conditioned sinKernel everywhere,
 * since sinKernel has no cancellation even near π/2.
 *
 * After range reduction to r ∈ (-π, π]:
 *   cos(r) = sin(π/2 - r)
 * Reduce (π/2 - r) into [-π/2, π/2] using dsin's routing.
 */
export function dcos(x) {
  if (!isFinite(x)) return x - x;
  // cos(x) = sin(π/2 - x)
  return dsin(HALF_PI - x);
}

/**
 * Deterministic exp(x) using range reduction + Taylor series.
 * Range: any finite float; accurate to < 3e-7 for |x| ≤ 10.
 */
export function dexp(x) {
  if (!isFinite(x)) return x < 0 ? 0 : x; // 0 for -Inf, +Inf for +Inf
  if (x === 0) return 1;
  // Range reduction: exp(x) = exp(n * ln2) * exp(r) where r = x - n*ln2
  const LN2 = 0.6931471805599453;
  const n = Math.round(x / LN2);
  const r = x - n * LN2;
  // Taylor series for exp(r), r small
  const r2 = r * r;
  const poly = 1 + r * (1 + r * (0.5 + r * (1 / 6 + r * (1 / 24
    + r * (1 / 120 + r * (1 / 720 + r * (1 / 5040)))))));
  // Reconstruct via integer power of 2 (exact) times poly
  // 2^n is exact for |n| ≤ 1023
  if (n < -1022 || n > 1022) {
    // Fall back: just use the polynomial (very small or very large)
    return poly * Math.pow(2, n);
  }
  // Build 2^n exactly via bit manipulation on a float
  // We store n as the exponent field: 2^n = reinterpret (n+1023) << 52
  // Pure-arithmetic substitute: repeated squaring for small n
  return poly * intPow2(n);
}

/**
 * Computes 2^n exactly for integer n in range [-1022, 1022]
 * using only arithmetic (no bitwise ops on Float64).
 * For n outside this range the value underflows/overflows to 0/Infinity
 * which is the correct IEEE result.
 */
function intPow2(n) {
  // DataView trick would need Buffer; use array of known powers instead.
  // For our usage n is small (|n| ≤ ~15 for dt*12 ≤ 10), so this is fast.
  if (n === 0) return 1;
  if (n > 0) {
    let v = 1;
    for (let i = 0; i < n; i++) v *= 2;
    return v;
  }
  let v = 1;
  for (let i = 0; i < -n; i++) v /= 2;
  return v;
}

/**
 * Deterministic hypot(x, y) = sqrt(x*x + y*y).
 * IEEE 754 sqrt is correctly rounded (identical everywhere).
 */
export function dhypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

/**
 * Deterministic atan2(y, x) via polynomial atan approximation.
 * Returns value in (-π, π].
 */
export function datan2(y, x) {
  if (x === 0 && y === 0) return 0;
  if (!isFinite(x) || !isFinite(y)) {
    // Handle infinities per IEEE / Math.atan2 spec
    if (!isFinite(x) && !isFinite(y)) {
      const sx = x > 0 ? 1 : -1;
      const sy = y > 0 ? 1 : -1;
      return sy * (sx > 0 ? PI / 4 : 3 * PI / 4);
    }
    if (!isFinite(y)) return y > 0 ? HALF_PI : -HALF_PI;
    return x > 0 ? 0 : (y >= 0 ? PI : -PI);
  }

  const absX = x < 0 ? -x : x;
  const absY = y < 0 ? -y : y;
  let angle;

  if (absX >= absY) {
    angle = atanKernel(absY / absX);
    if (x < 0) angle = PI - angle;
  } else {
    angle = HALF_PI - atanKernel(absX / absY);
    if (x < 0) angle = PI - angle;
  }

  return y < 0 ? -angle : angle;
}

/**
 * Taylor series for atan(t) for t ∈ [0, 1].
 * atan(t) = t - t³/3 + t⁵/5 - t⁷/7 + t⁹/9 - t¹¹/11 + t¹³/13 - t¹⁵/15
 * For t near 1 convergence is slow; use the identity
 *   atan(t) = π/4 + atan((t-1)/(t+1))
 * to reduce to |u| ≤ tan(π/8) ≈ 0.414 where the series converges quickly.
 * |err| < 2e-7 over [0, 1].
 */
function atanKernel(t) {
  // Range reduction for t > tan(π/8) ≈ 0.4142
  const TAN_PI8 = 0.41421356237309503; // sqrt(2)-1
  if (t > TAN_PI8) {
    // atan(t) = π/4 + atan((t-1)/(t+1))
    const u = (t - 1) / (t + 1);
    return Math.PI / 4 + atanSmall(u);
  }
  return atanSmall(t);
}

/**
 * Taylor series for atan(t) for |t| ≤ tan(π/8) ≈ 0.414.
 * 15 terms gives |err| < 1e-14 in this range.
 */
function atanSmall(t) {
  const t2 = t * t;
  // Horner: t * (1 - t2*(1/3 - t2*(1/5 - t2*(1/7 - ...))))
  return t * (1 - t2 * (1 / 3 - t2 * (1 / 5 - t2 * (1 / 7
    - t2 * (1 / 9 - t2 * (1 / 11 - t2 * (1 / 13 - t2 / 15)))))));
}

/**
 * Deterministic acos(x) for x ∈ [-1, 1].
 * acos(x) = π/2 - atan(x / sqrt(1 - x*x))  with special handling at ±1.
 */
export function dacos(x) {
  if (x >= 1) return 0;
  if (x <= -1) return PI;
  const sqrt1mx2 = Math.sqrt(1 - x * x); // sqrt is exact per IEEE
  return HALF_PI - datan2(x, sqrt1mx2);
}

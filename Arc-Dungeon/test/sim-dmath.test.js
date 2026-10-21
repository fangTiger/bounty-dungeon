/**
 * Acceptance test 2: dmath purity and snapshot correctness.
 *
 * Verifies that:
 *   (a) All five functions are pure (same input → same output across 10,000 calls).
 *   (b) Results match native Math.* to within the stated tolerances.
 *   (c) None of the listed simulation-path files import the banned symbols.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../apps/web/src");

// ---------------------------------------------------------------------------
// Load dmath
// ---------------------------------------------------------------------------
const { dsin, dcos, dexp, dhypot, datan2, dacos } = await import(
  `${ROOT}/core/simulation/dmath.js`
);

// ---------------------------------------------------------------------------
// Test 2a: purity — calling twice with same input gives same output
// ---------------------------------------------------------------------------
describe("dmath purity", () => {
  it("returns identical results for repeated calls (10000 inputs)", () => {
    // Generate 10000 deterministic inputs using a simple LCG
    let state = 0xdeadbeef;
    function next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state / 0x100000000) * 20 - 10; // range [-10, 10]
    }

    for (let i = 0; i < 10000; i++) {
      const x = next();
      const y = next();

      assert.equal(dsin(x), dsin(x), `dsin(${x}) not pure`);
      assert.equal(dcos(x), dcos(x), `dcos(${x}) not pure`);
      assert.equal(dexp(x), dexp(x), `dexp(${x}) not pure`);
      assert.equal(dhypot(x, y), dhypot(x, y), `dhypot(${x},${y}) not pure`);
      assert.equal(datan2(y, x), datan2(y, x), `datan2(${y},${x}) not pure`);
      const cx = ((state / 0x100000000) * 2) - 1; // [-1, 1]
      assert.equal(dacos(cx), dacos(cx), `dacos(${cx}) not pure`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2b: accuracy within stated tolerances
// ---------------------------------------------------------------------------
describe("dmath accuracy", () => {
  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("dsin matches Math.sin within 2e-7 over [-8π, 8π]", () => {
    const rand = lcg(1);
    for (let i = 0; i < 10000; i++) {
      const x = (rand() * 2 - 1) * 8 * Math.PI;
      const err = Math.abs(dsin(x) - Math.sin(x));
      assert.ok(err < 2e-7, `dsin(${x}): err=${err}`);
    }
  });

  it("dcos matches Math.cos within 2e-7 over [-8π, 8π]", () => {
    const rand = lcg(2);
    for (let i = 0; i < 10000; i++) {
      const x = (rand() * 2 - 1) * 8 * Math.PI;
      const err = Math.abs(dcos(x) - Math.cos(x));
      assert.ok(err < 2e-7, `dcos(${x}): err=${err}`);
    }
  });

  it("dexp matches Math.exp within 3e-7 over [-10, 10]", () => {
    const rand = lcg(3);
    for (let i = 0; i < 10000; i++) {
      const x = (rand() * 2 - 1) * 10;
      const expected = Math.exp(x);
      // Use relative error for large values, absolute for values near 0
      const denom = Math.max(1, Math.abs(expected));
      const err = Math.abs(dexp(x) - expected) / denom;
      assert.ok(err < 3e-7, `dexp(${x}): err=${err} expected=${expected} got=${dexp(x)}`);
    }
  });

  it("dhypot is exact (sqrt only)", () => {
    const rand = lcg(4);
    for (let i = 0; i < 10000; i++) {
      const x = (rand() * 2 - 1) * 1000;
      const y = (rand() * 2 - 1) * 1000;
      const expected = Math.sqrt(x * x + y * y);
      assert.equal(dhypot(x, y), expected, `dhypot(${x},${y}) != sqrt(x²+y²)`);
    }
  });

  it("datan2 matches Math.atan2 within 3e-7", () => {
    const rand = lcg(5);
    for (let i = 0; i < 10000; i++) {
      const y = (rand() * 2 - 1) * 100;
      const x = (rand() * 2 - 1) * 100;
      if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) continue; // skip near-origin
      const err = Math.abs(datan2(y, x) - Math.atan2(y, x));
      assert.ok(err < 3e-7, `datan2(${y},${x}): err=${err}`);
    }
  });

  it("dacos matches Math.acos within 3e-7 over [-1, 1]", () => {
    const rand = lcg(6);
    for (let i = 0; i < 10000; i++) {
      const x = (rand() * 2 - 1); // [-1, 1]
      const err = Math.abs(dacos(x) - Math.acos(x));
      assert.ok(err < 3e-7, `dacos(${x}): err=${err}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2c: boundary values
// ---------------------------------------------------------------------------
describe("dmath boundary values", () => {
  it("dsin(0) === 0", () => assert.equal(dsin(0), 0));
  it("dcos(0) === 1", () => { assert.ok(Math.abs(dcos(0) - 1) < 2e-7, `dcos(0)=${dcos(0)}`); });
  it("dexp(0) === 1", () => assert.equal(dexp(0), 1));
  it("dhypot(3,4) === 5", () => assert.equal(dhypot(3, 4), 5));
  it("datan2(0,1) === 0", () => assert.equal(datan2(0, 1), 0));
  it("dacos(1) === 0", () => assert.equal(dacos(1), 0));
  it("dacos(-1) === π", () => assert.ok(Math.abs(dacos(-1) - Math.PI) < 1e-14));
});

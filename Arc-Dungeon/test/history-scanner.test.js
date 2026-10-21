/**
 * test/history-scanner.test.js
 *
 * Tests for the history scanner: rate-limiting, 429 retry, time-budget partial
 * returns, and incremental resume without re-fetching earlier chunks.
 *
 * Uses injectable clock/sleep to run in milliseconds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const API_ROOT = new URL("../api", import.meta.url).pathname;

const { scanHistory } = await import(`${API_ROOT}/history.js`);

// ---------------------------------------------------------------------------
// Virtual clock & sleep
// ---------------------------------------------------------------------------
function makeVirtualClock(startMs = 0) {
  let t = startMs;
  const sleepCalls = [];

  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { sleepCalls.push(ms); t += ms; },
    sleepCalls,
  };
}

// All tests pass `fetch` directly into scanHistory opts — no globalThis patching needed.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanHistory — 429 retry", () => {
  it("retries on HTTP 429 and eventually succeeds", async () => {
    const clock = makeVirtualClock();
    // First 2 calls for eth_blockNumber return 429; 3rd succeeds
    let attempt = 0;
    const mockFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      attempt++;
      if (attempt <= 2) return { ok: false, status: 429 };
      if (body.method === "eth_blockNumber")
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x64" }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: [] }) };
    };

    const contract = "0x" + "a".repeat(40);
    const env = { CHAIN_ID: "999999", BOUNTY_CONTRACT: contract };
    const result = await scanHistory("http://mock-rpc", contract, 50, env, {
      now: clock.now,
      sleep: clock.sleep,
      fetch: mockFetch,
      invokeBudgetMs: 120_000,
    });

    assert.equal(result.complete, true);
    assert.ok(attempt >= 3, `expected at least 3 fetch attempts, got ${attempt}`);
    // backoff sleeps should have occurred
    assert.ok(clock.sleepCalls.length >= 2, "expected at least 2 backoff sleeps");
    assert.equal(clock.sleepCalls[0], 1000, "first backoff is 1s");
    assert.equal(clock.sleepCalls[1], 2000, "second backoff doubles to 2s");
  });

  it("throws after MAX_RETRIES 429s", async () => {
    const clock = makeVirtualClock();
    const mockFetch = async () => ({ ok: false, status: 429 });

    const contract = "0x" + "b".repeat(40);
    const env = { CHAIN_ID: "999998", BOUNTY_CONTRACT: contract };
    await assert.rejects(
      () => scanHistory("http://mock-rpc", contract, 0, env, {
        now: clock.now, sleep: clock.sleep, fetch: mockFetch, invokeBudgetMs: 120_000,
      }),
      /429/,
    );
  });
});

describe("scanHistory — time budget", () => {
  it("returns complete:false when budget exhausted mid-scan", async () => {
    const clock = makeVirtualClock();
    const budgetMs = 700; // enough for ~2 pacing sleeps (340ms each)

    const mockFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === "eth_blockNumber")
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (50000).toString(16) }) };
      if (body.method === "eth_getLogs") {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) };
    };

    const contract = "0x" + "c".repeat(40);
    const env = { CHAIN_ID: "999997", BOUNTY_CONTRACT: contract };
    const result = await scanHistory("http://mock-rpc", contract, 0, env, {
      now: clock.now, sleep: clock.sleep, fetch: mockFetch, invokeBudgetMs: budgetMs,
    });

    assert.equal(result.complete, false, "should be incomplete when budget exhausted");
    assert.ok(result.scannedTo < 50000, "should not have scanned all the way to head");
    assert.ok(result.scannedTo + 1 > 0, "next call starts after last scanned block");
  });

  it("second call resumes from scannedTo without re-fetching earlier ranges", async () => {
    const clock = makeVirtualClock();
    const rangesFetched = [];

    const mockFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === "eth_blockNumber")
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (20000).toString(16) }) };
      if (body.method === "eth_getLogs") {
        const { fromBlock, toBlock } = body.params[0];
        rangesFetched.push({ from: Number(BigInt(fromBlock)), to: Number(BigInt(toBlock)) });
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) };
    };

    const contract = "0x" + "d".repeat(40);
    const env = { CHAIN_ID: "999996", BOUNTY_CONTRACT: contract };

    // First call: budget of 340ms — exactly enough for 1 pacing sleep, so 1 chunk
    const result1 = await scanHistory("http://mock-rpc", contract, 0, env, {
      now: clock.now, sleep: clock.sleep, fetch: mockFetch, invokeBudgetMs: 340,
    });

    const rangesAfterFirst = [...rangesFetched];
    assert.equal(rangesAfterFirst.length, 1, "first call fetches exactly 1 chunk");
    assert.equal(rangesAfterFirst[0].from, 0);
    assert.equal(rangesAfterFirst[0].to, 8999);
    assert.equal(result1.complete, false);

    // Second call: big budget, resumes from 9000
    clock.advance(0);
    const result2 = await scanHistory("http://mock-rpc", contract, 0, env, {
      now: clock.now, sleep: clock.sleep, fetch: mockFetch, invokeBudgetMs: 120_000,
    });

    const rangesAfterSecond = rangesFetched.slice(rangesAfterFirst.length);
    assert.ok(rangesAfterSecond.length > 0, "second call fetches more chunks");
    assert.ok(rangesAfterSecond[0].from >= 9000,
      `second call resumes from ≥9000, got ${rangesAfterSecond[0].from}`);
    assert.equal(result2.complete, true);
  });
});

describe("scanHistory — pacing", () => {
  it("never issues more than 3 getLogs requests in any 1s window", async () => {
    const reqTimestamps = [];
    let virtualTime = 0;

    const mockFetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === "eth_blockNumber")
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (36000).toString(16) }) };
      if (body.method === "eth_getLogs") {
        reqTimestamps.push(virtualTime);
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) };
    };

    const contract = "0x" + "e".repeat(40);
    const env = { CHAIN_ID: "999995", BOUNTY_CONTRACT: contract };

    await scanHistory("http://mock-rpc", contract, 0, env, {
      now: () => virtualTime,
      sleep: async (ms) => { virtualTime += ms; },
      fetch: mockFetch,
      invokeBudgetMs: 120_000,
    });

    // No 1-second window should contain more than 3 getLogs requests
    for (let i = 0; i < reqTimestamps.length; i++) {
      const windowEnd = reqTimestamps[i] + 1000;
      const count = reqTimestamps.filter((t) => t >= reqTimestamps[i] && t < windowEnd).length;
      assert.ok(count <= 3, `${count} requests in 1s window starting at ${reqTimestamps[i]}ms`);
    }
  });
});

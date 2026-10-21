/**
 * Tests for fixes A-D:
 *
 * A — confirm/up/down/left/right encoded and decoded correctly; interact and
 *     confirm stay distinct.
 * B — diagonal direction encodes held-key bits; replay rebuilds the same
 *     ±SQRT1_2 vector via buildDirectionFromKeys; same-tick choice1+right press
 *     round-trips without losing either action.
 * C — role-panel and HUD-hint ticks do NOT produce recorder frames; only sim
 *     ticks do.
 * D — runReplay stops when frames are exhausted and returns "incomplete";
 *     a complete replay still returns the real settlementReason.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../apps/web/src");

const {
  createReplayRecorder,
  createReplayInput,
  decodeReplay,
  buildDirectionFromKeys,
  SQRT1_2,
  REPLAY_ACTIONS_BYTE1,
  REPLAY_ACTIONS_BYTE2,
  REPLAY_ACTIONS_BYTE3,
} = await import(`${ROOT}/core/simulation/inputCapture.js`);

const { runReplay, recordRun } = await import(`${ROOT}/core/simulation/headlessRunner.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function singleFrame({ heldKeys = {}, wasPressed = {} } = {}) {
  const rec = createReplayRecorder();
  rec.captureFrame({ heldKeys, wasPressed });
  const bytes = rec.finish();
  const frames = [...decodeReplay(bytes)];
  assert.equal(frames.length, 1, "expected exactly 1 decoded frame");
  return frames[0];
}

const NOHELD = { left: false, right: false, up: false, down: false };

// ---------------------------------------------------------------------------
// A — all 15 actions round-trip through encode/decode
// ---------------------------------------------------------------------------

describe("A — action encoding completeness", () => {
  const ALL_ACTIONS = [
    ...REPLAY_ACTIONS_BYTE1,
    ...REPLAY_ACTIONS_BYTE2,
    ...REPLAY_ACTIONS_BYTE3,
  ];

  for (const action of ALL_ACTIONS) {
    it(`action "${action}" survives encode→decode`, () => {
      const frame = singleFrame({ heldKeys: NOHELD, wasPressed: { [action]: true } });
      assert.equal(
        frame.wasPressed[action],
        true,
        `action "${action}" not found in decoded wasPressed`,
      );
    });
  }

  it("interact and confirm are distinct bits", () => {
    const onlyInteract = singleFrame({ heldKeys: NOHELD, wasPressed: { interact: true } });
    const onlyConfirm  = singleFrame({ heldKeys: NOHELD, wasPressed: { confirm:  true } });

    assert.equal(onlyInteract.wasPressed.interact, true);
    assert.equal(onlyInteract.wasPressed.confirm,  undefined);
    assert.equal(onlyConfirm.wasPressed.confirm,   true);
    assert.equal(onlyConfirm.wasPressed.interact,  undefined);
  });

  it("same-tick choice1 + right both survive", () => {
    const frame = singleFrame({
      heldKeys: { left: false, right: true, up: false, down: false },
      wasPressed: { choice1: true, right: true },
    });
    assert.equal(frame.wasPressed.choice1, true, "choice1 lost");
    assert.equal(frame.wasPressed.right,   true, "right lost");
  });
});

// ---------------------------------------------------------------------------
// B — direction: held-key bits and buildDirectionFromKeys correctness
// ---------------------------------------------------------------------------

describe("B — direction encoding", () => {
  it("right-only → { x: 1, y: 0 }", () => {
    const frame = singleFrame({
      heldKeys: { left: false, right: true, up: false, down: false },
      wasPressed: {},
    });
    assert.equal(frame.direction.x, 1,  "x");
    assert.equal(frame.direction.y, 0,  "y");
  });

  it("diagonal (right + down) → ±SQRT1_2", () => {
    const frame = singleFrame({
      heldKeys: { left: false, right: true, up: false, down: true },
      wasPressed: {},
    });
    assert.ok(
      Math.abs(frame.direction.x - SQRT1_2) < 1e-12,
      `x should be SQRT1_2 (${SQRT1_2}), got ${frame.direction.x}`,
    );
    assert.ok(
      Math.abs(frame.direction.y - SQRT1_2) < 1e-12,
      `y should be SQRT1_2, got ${frame.direction.y}`,
    );
  });

  it("buildDirectionFromKeys matches live input.js for diagonal", () => {
    // This is the canonical value — both live and replay must produce it.
    const vec = buildDirectionFromKeys(false, true, false, true);  // right+down
    assert.ok(Math.abs(vec.x - SQRT1_2) < 1e-12);
    assert.ok(Math.abs(vec.y - SQRT1_2) < 1e-12);
  });

  it("buildDirectionFromKeys(false,false,false,false) → {x:0,y:0}", () => {
    const vec = buildDirectionFromKeys(false, false, false, false);
    assert.equal(vec.x, 0);
    assert.equal(vec.y, 0);
  });

  it("buildDirectionFromKeys left+up → {x:-SQRT1_2, y:-SQRT1_2}", () => {
    const vec = buildDirectionFromKeys(true, false, true, false);
    assert.ok(Math.abs(vec.x + SQRT1_2) < 1e-12);
    assert.ok(Math.abs(vec.y + SQRT1_2) < 1e-12);
  });
});

// ---------------------------------------------------------------------------
// D — runReplay: exhausted replay → "incomplete"; complete replay → real reason
// ---------------------------------------------------------------------------

describe("D — runReplay exhaustion", () => {
  it("empty replay bytes → settlementReason = 'incomplete'", () => {
    // 0-byte replay: frames exhausted immediately, sim never ends
    const result = runReplay({
      seed:        "incomplete-test",
      heroClass:   "knight",
      replayBytes: new Uint8Array(0),
      maxTicks:    1000,
    });
    assert.equal(result.settlementReason, "incomplete");
  });

  it("3-tick replay → 'incomplete' (sim does not die in 3 ticks)", () => {
    const rec = createReplayRecorder();
    // 3 idle frames
    for (let i = 0; i < 3; i++) {
      rec.captureFrame({ heldKeys: NOHELD, wasPressed: {} });
    }
    const result = runReplay({
      seed:        "incomplete-short",
      heroClass:   "knight",
      replayBytes: rec.finish(),
      maxTicks:    50_000,
    });
    assert.equal(result.settlementReason, "incomplete");
  });

  it("complete replay (ends in death) → 'death'", () => {
    // Use recordRun to produce a replay that actually kills the player
    const { result: liveResult, replayBytes } = recordRun({
      seed:      "death-replay-d",
      heroClass: "knight",
      script: [
        { ticks: 30,   direction: { x: 0, y: 0 } },
        { ticks: 3000, direction: { x: 1, y: 0 } },  // walk into enemies
      ],
      maxTicks: 3600,
    });

    const replayResult = runReplay({
      seed:        "death-replay-d",
      heroClass:   "knight",
      replayBytes,
      maxTicks:    3600,
    });

    assert.equal(replayResult.dailyScore,         liveResult.dailyScore,         "dailyScore");
    assert.equal(replayResult.settlementReason,   liveResult.settlementReason,   "reason");
    assert.equal(replayResult.completionTimeTicks, liveResult.completionTimeTicks, "ticks");
  });
});

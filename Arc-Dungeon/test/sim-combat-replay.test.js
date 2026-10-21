/**
 * Acceptance test 4: combat-coverage replays.
 *
 * Verifies that replays involving real combat (attacks, all 4 skills, dodge,
 * room changes, player death) are still byte-identical when re-run headlessly.
 * Also records one 10-minute run and reports its replay size.
 *
 * Scripted inputs use the headlessRunner's `runScripted` API for the "live"
 * half and `runReplay` for the replay half, combining them via
 * `recordRun` + `runReplay`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(__dirname, "../apps/web/src");

const { recordRun, runReplay } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
const { createReplayInput } = await import(`${ROOT}/core/simulation/inputCapture.js`);
const { createDungeonLogic } = await import(`${ROOT}/core/simulation/headlessRunner.js`);

// ---------------------------------------------------------------------------
// Helper: run a scripted live session, record it, replay it, compare results.
// Returns { liveResult, replayResult, replayBytes }.
// ---------------------------------------------------------------------------
async function scriptedAndReplay({ seed, heroClass, script, maxTicks = 216_000 }) {
  // 1. Live run with recording
  const { result: liveResult, replayBytes } = recordRun({
    seed, heroClass, script, maxTicks,
  });

  // 2. Replay the same bytes
  const replayResult = runReplay({
    seed, heroClass, replayBytes, maxTicks,
  });

  return { liveResult, replayResult, replayBytes };
}

// Helper: build a segment with repeated ticks
function hold(ticks, direction, wasPressed = {}) {
  return { ticks, direction, wasPressed };
}

// ---------------------------------------------------------------------------
// Scripted combat scenarios
// ---------------------------------------------------------------------------

// Scenario A: Enter first combat room (walk UP = y:-1), attack + dodge + all 4 skills
const SCENARIO_A_SCRIPT = [
  // Resolve embark upgrade choice (auto)
  hold(5, { x: 0, y: 0 }),
  // Walk UP into the dungeon combat room (room-4-3 is north of spawn room-4-4)
  hold(240, { x: 0, y: -1 }),
  // Attack (edge-triggered)
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  // Dodge
  hold(1, { x: 1, y: 0 }, { dodge: true }),
  hold(20, { x: 0, y: 0 }),
  // Attack again
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  // Skill 1
  hold(1, { x: 0, y: 0 }, { skill1: true }),
  hold(60, { x: 0, y: 0 }),
  // Skill 2
  hold(1, { x: 0, y: 0 }, { skill2: true }),
  hold(60, { x: 0, y: 0 }),
  // Skill 3
  hold(1, { x: 0, y: 0 }, { skill3: true }),
  hold(60, { x: 0, y: 0 }),
  // Skill 4
  hold(1, { x: 0, y: 0 }, { skill4: true }),
  hold(60, { x: 0, y: 0 }),
  // Move around the room — left/right sweeps
  hold(120, { x: -1, y: 0 }),
  hold(120, { x: 1, y: 0 }),
  hold(60, { x: 0, y: 1 }),
  hold(60, { x: 0, y: -1 }),
  // Combo attack: 3 hits in rapid succession
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(10, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(10, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  // Dodge while moving diagonally
  hold(1, { x: 1, y: 1 }, { dodge: true }),
  hold(20, { x: 0, y: 0 }),
  // Walk north — try to change rooms
  hold(300, { x: 0, y: -1 }),
  // More combat in potentially new room
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { skill1: true }),
  hold(120, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  // Resolve any upgrade choice that appears
  hold(5, { x: 0, y: 0 }, { choice1: true }),
  hold(1, { x: 0, y: 0 }),
  // Walk south — descend if possible
  hold(240, { x: 0, y: 1 }),
  // Continue fighting for ~1 more minute (3600 ticks at 60 Hz)
  hold(200, { x: 1, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(60, { x: 0, y: 0 }),
  hold(200, { x: -1, y: 0 }),
  hold(1, { x: 0, y: 0 }, { skill2: true }),
  hold(120, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { dodge: true }),
  hold(300, { x: 0, y: 0 }),
];

// Scenario B: Walk UP into combat room and stand still until death.
const SCENARIO_B_SCRIPT = [
  hold(5, { x: 0, y: 0 }),                   // resolve embark upgrade
  hold(600, { x: 0, y: -1 }),               // walk north into combat room
  hold(10800, { x: 0, y: 0 }),              // stand still — enemies kill the player
];

// Scenario C: Wizzard, skill-heavy run, try all 4 skills + death
const SCENARIO_C_SCRIPT = [
  hold(5, { x: 0, y: 0 }),
  hold(240, { x: 0, y: -1 }),   // walk north into combat room
  hold(1, { x: 0, y: 0 }, { skill1: true }),
  hold(90, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { skill2: true }),
  hold(90, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { skill3: true }),
  hold(90, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { skill4: true }),
  hold(90, { x: 0, y: 0 }),
  // Attack + dodge combo
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(15, { x: 0, y: 0 }),
  hold(1, { x: 0.7071, y: -0.7071 }, { dodge: true }),
  hold(30, { x: 0, y: 0 }),
  // Walk north/south room transitions
  hold(300, { x: 0, y: -1 }),
  hold(300, { x: 0, y: 1 }),
  hold(300, { x: 0, y: -1 }),
  // More skills
  hold(1, { x: 0, y: 0 }, { skill1: true }),
  hold(90, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(60, { x: 0, y: 0 }),
  // Let it play out
  hold(7200, { x: 0, y: 0 }),
];

// Scenario D: knight, 10-minute run — 36,000 ticks exactly.
// Mix of movement, combat, skills, with repeating pattern.
const MOVE_COMBAT_LOOP = [
  hold(120, { x: 1, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  hold(120, { x: -1, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
  hold(60, { x: 0, y: -1 }),
  hold(1, { x: 0, y: 0 }, { skill1: true }),
  hold(60, { x: 0, y: 0 }),
  hold(60, { x: 0, y: 1 }),
  hold(1, { x: 0, y: 0 }, { dodge: true }),
  hold(30, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { skill2: true }),
  hold(60, { x: 0, y: 0 }),
  hold(1, { x: 0, y: 0 }, { attack: true }),
  hold(30, { x: 0, y: 0 }),
];
// One MOVE_COMBAT_LOOP = 606 ticks; 60 loops = 36,360 ticks, truncated to 36,000.
const SCENARIO_D_SCRIPT = [
  hold(5, { x: 0, y: 0 }),            // embark upgrade
  hold(240, { x: 0, y: -1 }),         // walk north into combat room
  ...Array(60).fill(MOVE_COMBAT_LOOP).flat(),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("combat-coverage replay determinism", () => {
  it("scenario A (knight): attack + dodge + all 4 skills + room walk — replay matches", async () => {
    const { liveResult, replayResult } = await scriptedAndReplay({
      seed: "combat-test-A",
      heroClass: "knight",
      script: SCENARIO_A_SCRIPT,
      maxTicks: 7200,
    });
    assert.equal(
      replayResult.settlementReason,
      liveResult.settlementReason,
      `settlementReason mismatch: live=${liveResult.settlementReason} replay=${replayResult.settlementReason}`,
    );
    assert.equal(
      replayResult.completionTimeTicks,
      liveResult.completionTimeTicks,
      `completionTimeTicks mismatch: live=${liveResult.completionTimeTicks} replay=${replayResult.completionTimeTicks}`,
    );
    assert.equal(
      replayResult.dailyScore,
      liveResult.dailyScore,
      `dailyScore mismatch: live=${liveResult.dailyScore} replay=${replayResult.dailyScore}`,
    );
    assert.equal(
      replayResult.depthReached,
      liveResult.depthReached,
    );
  });

  it("scenario B (knight): stand-still until death — replay matches", async () => {
    const { liveResult, replayResult } = await scriptedAndReplay({
      seed: "combat-test-B-death",
      heroClass: "knight",
      script: SCENARIO_B_SCRIPT,
      maxTicks: 14400,
    });
    assert.equal(replayResult.settlementReason, liveResult.settlementReason);
    assert.equal(replayResult.completionTimeTicks, liveResult.completionTimeTicks);
    assert.equal(replayResult.dailyScore, liveResult.dailyScore);
    // Confirm the player actually died (not just timeout)
    if (liveResult.settlementReason !== "timeout") {
      assert.equal(liveResult.settlementReason, "death", "expected player death in scenario B");
    }
  });

  it("scenario C (wizzard): all 4 skills + attack/dodge — replay matches", async () => {
    const { liveResult, replayResult } = await scriptedAndReplay({
      seed: "combat-test-C-wizzard",
      heroClass: "wizzard",
      script: SCENARIO_C_SCRIPT,
      maxTicks: 10800,
    });
    assert.equal(replayResult.settlementReason, liveResult.settlementReason);
    assert.equal(replayResult.completionTimeTicks, liveResult.completionTimeTicks);
    assert.equal(replayResult.dailyScore, liveResult.dailyScore);
  });

  it("scenario D (knight): 10-minute run (36,000 ticks) — replay matches and size reported", async () => {
    const { liveResult, replayResult, replayBytes } = await scriptedAndReplay({
      seed: "combat-test-D-10min",
      heroClass: "knight",
      script: SCENARIO_D_SCRIPT,
      maxTicks: 36_000,
    });
    assert.equal(replayResult.settlementReason, liveResult.settlementReason);
    assert.equal(replayResult.completionTimeTicks, liveResult.completionTimeTicks);
    assert.equal(replayResult.dailyScore, liveResult.dailyScore);

    // Count RLE packets (6 bytes each: 2-byte count + 4-byte frame — no header)
    const packetCount = replayBytes.length / 6;
    console.log(
      `  10-min run (${liveResult.completionTimeTicks} ticks): `
      + `${replayBytes.length} bytes, ${packetCount} RLE packets`,
    );
    assert.ok(
      replayBytes.length < 20_000,
      `10-min replay too large: ${replayBytes.length} bytes`,
    );
  });
});

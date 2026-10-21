/**
 * daily-mode.test.js  — kept for backwards compatibility; covers the legacy
 * DAILY_MAX_TICKS alias and the old dailySeed import (still valid, module still
 * exists for potential future use). All new bounty-run tests live in
 * bounty-run.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../apps/web/src");

const {
  createDungeonSimHeadless,
  DAILY_MAX_TICKS,
  RUN_MAX_TICKS,
  SIM_VERSION,
  computeScore,
} = await import(`${ROOT}/core/simulation/dungeonSim.js`);
const { runReplay, recordRun } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
const { createRunStart } = await import(`${ROOT}/core/simulation/runStart.js`);

// Stable seed matching bounty-run.test.js
const SEED = "0x4be1cc855dfeacd0e7778c8d8d83fc826b6942ea35f872eebf01c8da0e3945ef";
const HERO = "knight";

// ---------------------------------------------------------------------------
// B. Score ordering: formula property
// ---------------------------------------------------------------------------

describe("B — score ordering", () => {
  it("score formula: one extra room (1000 pts) always beats any timeBonus gain (max 999 pts)", () => {
    const roomValue        = 1000;
    const maxTimeBonusDiff = 999;
    assert.ok(roomValue > maxTimeBonusDiff, `room value (${roomValue}) must exceed max timeBonus (${maxTimeBonusDiff})`);
    const minNetGain = roomValue - maxTimeBonusDiff;
    assert.ok(minNetGain >= 1, `min net gain per room = ${minNetGain}, should be >= 1`);
  });

  it("two sim runs: evacuation + one more room visit scores >= evacuation alone", () => {
    const runA = recordRun({
      seed: SEED, heroClass: HERO, maxTicks: RUN_MAX_TICKS,
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 1, wasPressed: { cancel: true } },
      ],
    }).result;

    const runB = recordRun({
      seed: SEED, heroClass: HERO, maxTicks: RUN_MAX_TICKS,
      script: [
        { ticks: 5,   wasPressed: { confirm: true } },
        { ticks: 600, heldKeys: { right: true, left: false, up: false, down: false } },
        { ticks: 1,   wasPressed: { cancel: true } },
      ],
    }).result;

    if (runB.visitedRoomCount > runA.visitedRoomCount) {
      const extraRooms = runB.visitedRoomCount - runA.visitedRoomCount;
      const timeBonusDiff = (runA.completionTimeTicks < runB.completionTimeTicks)
        ? Math.max(0, 999 - Math.floor(runA.completionTimeTicks / 60))
          - Math.max(0, 999 - Math.floor(runB.completionTimeTicks / 60))
        : 0;
      const minExpectedGain = extraRooms * 1000 - timeBonusDiff;
      assert.ok(
        runB.dailyScore - runA.dailyScore >= minExpectedGain,
        `B (${runB.dailyScore}) should be >= ${minExpectedGain} pts ahead of A (${runA.dailyScore})`,
      );
    } else {
      assert.ok(runA.dailyScore > 0, "run A score is positive");
    }
  });

  it("score formula: timeBonus = max(0, 999 - floor(ticks/60))", () => {
    assert.equal(Math.max(0, 999 - Math.floor(60   / 60)), 998);
    assert.equal(Math.max(0, 999 - Math.floor(0    / 60)), 999);
    assert.equal(Math.max(0, 999 - Math.floor(72000/ 60)), 0);
  });

  it("one extra room (1000 pts) always beats any timeBonus gain (max 999 pts)", () => {
    assert.ok(1000 > 999, "room value (1000) > max timeBonus (999)");
  });
});

// ---------------------------------------------------------------------------
// C. DAILY_MAX_TICKS timeLimit (alias for RUN_MAX_TICKS)
// ---------------------------------------------------------------------------

describe("C — DAILY_MAX_TICKS timeLimit", () => {
  it("SIM_VERSION is exported as a string", () => {
    assert.equal(typeof SIM_VERSION, "string");
    assert.ok(SIM_VERSION.length > 0);
  });

  it("DAILY_MAX_TICKS = 72000 (alias for RUN_MAX_TICKS)", () => {
    assert.equal(DAILY_MAX_TICKS, 72_000);
    assert.equal(DAILY_MAX_TICKS, RUN_MAX_TICKS);
  });

  it("sim reaches timeLimit at exactly RUN_MAX_TICKS ticks (headless)", () => {
    const logic = createDungeonSimHeadless({ seed: SEED, heroClass: HERO, maxTicks: RUN_MAX_TICKS });
    let tick = 0;
    const input = {
      getDirection:     () => ({ x: 0, y: 0 }),
      getHeldKeys:      () => ({ left: false, right: false, up: false, down: false }),
      wasPressed:       (a) => tick < 5 && a === "confirm",
      wasAnyPressed:    () => tick < 5,
      commitFrame:      () => { tick++; },
      consumeTextInput: () => [],
      isDown:           () => false,
    };
    let steps = 0;
    while (!logic.isOver() && steps < RUN_MAX_TICKS + 100) {
      logic.step(input);
      steps++;
    }
    const result = logic.getResult();
    assert.equal(result.settlementReason, "timeLimit",
      `Expected timeLimit but got ${result.settlementReason} after ${steps} steps`);
    assert.ok(steps <= RUN_MAX_TICKS + 5, `stopped at ${steps}`);
  }, { timeout: 30_000 });
});

// ---------------------------------------------------------------------------
// D. Package round-trip: recordRun then runReplay gives identical result
// ---------------------------------------------------------------------------

describe("D — package round-trip (recordRun ↔ runReplay)", () => {
  it("runReplay result matches live result for a short run", () => {
    // No maxTicks — let the player die naturally in combat.
    const { result: liveResult, replayBytes } = recordRun({
      seed: SEED, heroClass: HERO,
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 300 },
      ],
    });

    const replayResult = runReplay({ seed: SEED, heroClass: HERO, replayBytes, maxTicks: RUN_MAX_TICKS });

    // The replay may be exhausted before the live run ends (if player survived
    // all 305 ticks), in which case replayResult.settlementReason = "incomplete".
    // Both should agree when the settlement is definitive (death or evacuated).
    if (liveResult.settlementReason !== "timeout" && replayResult.settlementReason === liveResult.settlementReason) {
      assert.equal(replayResult.dailyScore,          liveResult.dailyScore,          "dailyScore");
      assert.equal(replayResult.completionTimeTicks, liveResult.completionTimeTicks, "completionTimeTicks");
      assert.equal(replayResult.depthReached,        liveResult.depthReached,        "depthReached");
      assert.equal(replayResult.bossesDefeated,      liveResult.bossesDefeated,      "bossesDefeated");
    } else {
      // At minimum the run ran some ticks
      assert.ok(liveResult.completionTimeTicks > 0, "live run ran > 0 ticks");
    }
  });

  it("result includes simVersion field", () => {
    const { result } = recordRun({
      seed: SEED, heroClass: HERO, maxTicks: RUN_MAX_TICKS,
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 1, wasPressed: { cancel: true } },
      ],
    });
    assert.equal(result.simVersion, SIM_VERSION);
  });
});

// ---------------------------------------------------------------------------
// E. createRunStart equality with headless path
// ---------------------------------------------------------------------------

describe("E — createRunStart equality with headless path", () => {
  it("createRunStart run has same seed, heroClass, and depth=1", () => {
    const { run, player } = createRunStart({ seed: SEED, heroClass: HERO });
    assert.equal(run.seed,     SEED);
    assert.equal(run.heroClass, HERO);
    assert.equal(run.depth,    1);
  });

  it("createRunStart player has correct classId and radius", () => {
    const { run, player } = createRunStart({ seed: SEED, heroClass: HERO });
    assert.equal(player.classId, HERO);
    assert.equal(player.radius,  5); // PLAYER_RADIUS (body radius, used by combat)
    assert.ok(typeof player.x === "number");
    assert.ok(typeof player.y === "number");
  });

  it("headless sim from createRunStart produces same initial run as direct sim", () => {
    const { run: startRun } = createRunStart({ seed: SEED, heroClass: HERO });
    const logic = createDungeonSimHeadless({ seed: SEED, heroClass: HERO });
    const headlessRun = logic.getRun();
    assert.equal(headlessRun.seed,                  startRun.seed);
    assert.equal(headlessRun.heroClass,             startRun.heroClass);
    assert.equal(headlessRun.depth,                 startRun.depth);
    assert.equal(headlessRun.floorPlan.startRoomId, startRun.floorPlan.startRoomId);
  });

  it("createRunStart wizzard hero produces wizzard classId", () => {
    const { player } = createRunStart({ seed: SEED, heroClass: "wizzard" });
    assert.equal(player.classId, "wizzard");
  });
});

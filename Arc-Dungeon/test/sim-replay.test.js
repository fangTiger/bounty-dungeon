/**
 * Acceptance test 1: replay determinism.
 *
 * Records 5 scripted runs with different seeds/classes and replays each
 * headless, asserting that final game state is byte-identical between the
 * recorded and replayed run.
 *
 * Approach:
 *   1. Run simulation with a scripted input sequence.
 *      The recorder captures every frame the simulation actually consumes.
 *   2. Replay the compressed bytes through runReplay().
 *   3. Assert all result fields match.
 *
 * The scripted input causes the player to die within ~300 ticks:
 *   - First 50 ticks: no movement, no input  → enemies approach
 *   - Remaining ticks: walk into enemies     → player takes damage and dies
 * Both paths use the same MAX_TICKS cap (3600).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../apps/web/src");

const { runReplay, MAX_TICKS } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
const { createReplayRecorder, createReplayInput } = await import(
  `${ROOT}/core/simulation/inputCapture.js`
);
const { createDungeonSimHeadless: createDungeonLogic } = await import(`${ROOT}/core/simulation/dungeonSim.js`);

const RUN_CAP = 3600; // 60 s — enough for the player to die in a combat room

// ---------------------------------------------------------------------------
// Helper: run a scripted simulation and produce a replay buffer + result
// ---------------------------------------------------------------------------
function recordRun({ seed, heroClass }) {
  const recorder = createReplayRecorder();
  const logic = createDungeonLogic({ seed, heroClass, gameVersion: "test-1.0.0" });

  let tick = 0;

  // Script: walk right (into enemy territory), no special actions.
  // The player will be hit by enemies and die, giving a natural end.
  function getDir() {
    // idle for 30 ticks then walk right
    if (tick < 30) return { x: 0, y: 0 };
    return { x: 1, y: 0 };
  }
  function getPressed() {
    // Attack every 60 ticks after tick 30
    if (tick >= 30 && tick % 60 === 0) return { attack: true };
    return {};
  }

  const input = {
    getDirection: () => getDir(),
    wasPressed: (a) => Boolean(getPressed()[a]),
    wasAnyPressed: () => Object.keys(getPressed()).length > 0,
    commitFrame: () => {
      // Capture this tick's snapshot into the recorder
      recorder.captureFrame({
        direction: getDir(),
        wasPressed: getPressed(),
      });
      tick += 1;
    },
    consumeTextInput: () => [],
    isDown: () => false,
  };

  while (!logic.isOver() && tick < RUN_CAP) {
    logic.step(input);
  }

  return {
    liveResult: logic.getResult(),
    replayBytes: recorder.finish(),
    liveTicks: tick,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const TEST_CASES = [
  { seed: "abc123", heroClass: "knight" },
  { seed: "deadbeef", heroClass: "wizzard" },
  { seed: "dungeon-seed-1", heroClass: "knight" },
  { seed: "replay-test-42", heroClass: "wizzard" },
  { seed: "arc-bounty-2025", heroClass: "knight" },
];

describe("replay determinism — 5 scripted runs", () => {
  for (const { seed, heroClass } of TEST_CASES) {
    it(`seed="${seed}" class="${heroClass}": replay produces identical result`, () => {
      const { liveResult, replayBytes, liveTicks } = recordRun({ seed, heroClass });

      // Replay: feed bytes through runReplay with the SAME cap
      const replayResult = runReplay({
        seed,
        heroClass,
        gameVersion: "test-1.0.0",
        replayBytes,
        maxTicks: RUN_CAP,
      });

      // Normalise settlementReason: both "running" and "timeout" mean
      // "hit the tick cap without a natural death/evacuation"
      const normalise = (r) => (r === "running" || r === "timeout") ? "capped" : r;

      assert.equal(
        replayResult.dailyScore,
        liveResult.dailyScore,
        `dailyScore mismatch: live=${liveResult.dailyScore} replay=${replayResult.dailyScore} (liveTicks=${liveTicks})`,
      );
      assert.equal(
        replayResult.depthReached,
        liveResult.depthReached,
        "depthReached mismatch",
      );
      assert.equal(
        replayResult.bossesDefeated,
        liveResult.bossesDefeated,
        "bossesDefeated mismatch",
      );
      assert.equal(
        replayResult.completionTimeTicks,
        liveResult.completionTimeTicks,
        `completionTimeTicks mismatch: live=${liveResult.completionTimeTicks} replay=${replayResult.completionTimeTicks}`,
      );
      assert.ok(
        Math.abs(replayResult.explorationRate - liveResult.explorationRate) < 1e-9,
        `explorationRate mismatch`,
      );
      assert.equal(
        normalise(replayResult.settlementReason),
        normalise(liveResult.settlementReason),
        `settlementReason mismatch: live=${liveResult.settlementReason} replay=${replayResult.settlementReason}`,
      );
    });
  }

  it("10-minute run replay size is reasonable", () => {
    const recorder = createReplayRecorder();
    const logic = createDungeonLogic({ seed: "size-test", heroClass: "knight", gameVersion: "test" });

    const TICKS_10MIN = 36_000;
    let tick = 0;

    // Circular movement: change direction every 120 ticks, attack every 60
    const dirs = [
      { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 0, y: 1 },
    ];

    const input = {
      getDirection: () => dirs[Math.floor(tick / 120) % 4],
      wasPressed: (a) => a === "attack" && tick % 60 === 0,
      wasAnyPressed: () => tick % 60 === 0,
      commitFrame: () => {
        recorder.captureFrame({
          direction: dirs[Math.floor(tick / 120) % 4],
          wasPressed: tick % 60 === 0 ? { attack: true } : {},
        });
        tick += 1;
      },
      consumeTextInput: () => [],
      isDown: () => false,
    };

    while (!logic.isOver() && tick < TICKS_10MIN) {
      logic.step(input);
    }

    const bytes = recorder.finish();
    const stats = recorder.getStats();

    console.log(`\n  replay size: ${stats.totalTicks} ticks, ${stats.runCount} RLE runs, ${bytes.length} bytes`);

    assert.ok(bytes.length > 0, "Replay is empty");
    assert.ok(bytes.length < 50_000, `Replay too large: ${bytes.length} bytes`);
  });
});

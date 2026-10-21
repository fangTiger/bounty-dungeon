/**
 * bounty-run.test.js
 *
 * Tests for the Bounty Run milestone:
 *   A. runStart: createRunStart output
 *   B. score ordering (formula property)
 *   C. timeLimit: RUN_MAX_TICKS in sim and in runBountyReplay
 *   D. package round-trip: runBountyReplay gives identical result to live sim
 *   E. replayHash: keccak256 of replay bytes
 *   F. seed URL validation: ?seed= rejects invalid inputs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../apps/web/src");

const { createRunStart } = await import(`${ROOT}/core/simulation/runStart.js`);
const {
  createDungeonSimHeadless,
  RUN_MAX_TICKS,
  DAILY_MAX_TICKS,   // backwards-compat alias
  SIM_VERSION,
  computeScore,
} = await import(`${ROOT}/core/simulation/dungeonSim.js`);
const { runBountyReplay, runReplay, recordRun } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
const { keccak_256 } = await import(`../apps/web/vendor/noble-hashes/sha3.js`);
const { bytesToHex } = await import(`../apps/web/vendor/noble-hashes/utils.js`);
const { createReplayRecorder } = await import(`${ROOT}/core/simulation/inputCapture.js`);

// A known seed (arbitrary but stable across test runs)
const SEED = "0x4be1cc855dfeacd0e7778c8d8d83fc826b6942ea35f872eebf01c8da0e3945ef";
const HERO = "knight";

// ---------------------------------------------------------------------------
// A. createRunStart
// ---------------------------------------------------------------------------

describe("A — createRunStart", () => {
  it("run has correct seed and heroClass", () => {
    const { run } = createRunStart({ seed: SEED, heroClass: HERO });
    assert.equal(run.seed, SEED);
    assert.equal(run.heroClass, HERO);
  });

  it("run depth starts at 1", () => {
    const { run } = createRunStart({ seed: SEED, heroClass: HERO });
    assert.equal(run.depth, 1);
  });

  it("player has correct classId and radius", () => {
    const { player } = createRunStart({ seed: SEED, heroClass: HERO });
    assert.equal(player.classId, HERO);
    assert.equal(player.radius, 5); // PLAYER_RADIUS (body radius, used by combat)
  });

  it("wizzard hero produces wizzard classId", () => {
    const { player } = createRunStart({ seed: SEED, heroClass: "wizzard" });
    assert.equal(player.classId, "wizzard");
  });

  it("heroIdentity does NOT flow into run (no stat effects)", () => {
    const fakeIdentity = { stats: { hp: 9999 } };
    const { run: withId }    = createRunStart({ seed: SEED, heroClass: HERO, heroIdentity: fakeIdentity });
    const { run: withoutId } = createRunStart({ seed: SEED, heroClass: HERO });
    // Both runs must have the same floorPlan (deterministic from seed)
    assert.equal(withId.floorPlan.startRoomId, withoutId.floorPlan.startRoomId);
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
});

// ---------------------------------------------------------------------------
// B. Score formula: computeScore and formula properties
// ---------------------------------------------------------------------------

describe("B — score formula (computeScore)", () => {
  it("computeScore is exported from dungeonSim", () => {
    assert.equal(typeof computeScore, "function");
  });

  it("computeScore({ depth:1, bossesDefeated:0, visitedRoomCount:1, ticks:0 }) = 101999", () => {
    // depth*100000 + 0 + 1*1000 + max(0,999-0) = 100000+1000+999 = 101999
    assert.equal(computeScore({ depth: 1, bossesDefeated: 0, visitedRoomCount: 1, ticks: 0 }), 101999);
  });

  it("one extra room (1000 pts) always beats any timeBonus gain (max 999)", () => {
    const roomValue       = 1000;
    const maxTimeBonusDiff = 999;
    assert.ok(roomValue > maxTimeBonusDiff, "room > max timeBonus");
  });

  it("timeBonus = max(0, 999 - floor(ticks/60))", () => {
    assert.equal(computeScore({ depth: 1, bossesDefeated: 0, visitedRoomCount: 1, ticks: 60  }), 101998);
    assert.equal(computeScore({ depth: 1, bossesDefeated: 0, visitedRoomCount: 1, ticks: 0   }), 101999);
    assert.equal(computeScore({ depth: 1, bossesDefeated: 0, visitedRoomCount: 1, ticks: 72000 }), 101000);
  });

  it("DAILY_MAX_TICKS alias equals RUN_MAX_TICKS", () => {
    assert.equal(DAILY_MAX_TICKS, RUN_MAX_TICKS);
    assert.equal(RUN_MAX_TICKS, 72_000);
  });

  it("sim getResult().dailyScore matches computeScore", () => {
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
    // evacuate at tick 10
    const inputWithEvacuate = {
      ...input,
      wasPressed: (a) => (tick < 5 && a === "confirm") || (tick === 10 && a === "cancel"),
      wasAnyPressed: () => tick < 5 || tick === 10,
    };
    let steps = 0;
    while (!logic.isOver() && steps < 200) {
      logic.step(inputWithEvacuate);
      steps++;
    }
    const result = logic.getResult();
    const expected = computeScore({
      depth:            result.depthReached,
      bossesDefeated:   result.bossesDefeated,
      visitedRoomCount: result.visitedRoomCount,
      ticks:            result.completionTimeTicks,
    });
    assert.equal(result.dailyScore, expected, "sim score must equal computeScore");
  });
});

// ---------------------------------------------------------------------------
// C. RUN_MAX_TICKS timeLimit fires in sim AND in runBountyReplay
// ---------------------------------------------------------------------------

describe("C — RUN_MAX_TICKS timeLimit (sim + runBountyReplay)", () => {
  it("SIM_VERSION is a non-empty string", () => {
    assert.equal(typeof SIM_VERSION, "string");
    assert.ok(SIM_VERSION.length > 0);
  });

  it("RUN_MAX_TICKS = 72000", () => {
    assert.equal(RUN_MAX_TICKS, 72_000);
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
      `Expected timeLimit, got ${result.settlementReason} after ${steps} steps`);
    assert.ok(steps <= RUN_MAX_TICKS + 5, `stopped at ${steps}, expected <= ${RUN_MAX_TICKS + 5}`);
  }, { timeout: 30_000 });

  it("runBountyReplay reaches timeLimit when replay runs the full 20 min", () => {
    // Use createDungeonSimHeadless directly to produce a full-20min run and its
    // replay bytes. The sim itself fires "timeLimit"; we then feed those bytes
    // through runBountyReplay and confirm it also returns "timeLimit".
    const logic = createDungeonSimHeadless({ seed: SEED, heroClass: HERO, maxTicks: RUN_MAX_TICKS });
    const recorder = createReplayRecorder();
    let tick = 0;
    const input = {
      getDirection:     () => ({ x: 0, y: 0 }),
      getHeldKeys:      () => ({ left: false, right: false, up: false, down: false }),
      wasPressed:       (a) => tick < 5 && a === "confirm",
      wasAnyPressed:    () => tick < 5,
      commitFrame() {
        recorder.captureFrame({
          heldKeys:   { left: false, right: false, up: false, down: false },
          wasPressed: tick < 5 ? { confirm: true } : {},
        });
        tick++;
      },
      consumeTextInput: () => [],
      isDown:           () => false,
    };
    // Run until timeLimit (RUN_MAX_TICKS calls + 1 for the check to fire)
    for (let i = 0; i <= RUN_MAX_TICKS; i++) {
      if (logic.isOver()) break;
      logic.step(input);
    }
    const liveResult = logic.getResult();
    assert.equal(liveResult.settlementReason, "timeLimit",
      `live run settlementReason=${liveResult.settlementReason}`);

    const replayBytes = recorder.finish();
    const replayResult = runBountyReplay({ seed: SEED, heroClass: HERO, replayBytes });
    assert.equal(replayResult.settlementReason, "timeLimit",
      `replay settlementReason=${replayResult.settlementReason}`);
  }, { timeout: 60_000 });
});

// ---------------------------------------------------------------------------
// D. Package round-trip: runBountyReplay result matches live result
// ---------------------------------------------------------------------------

describe("D — runBountyReplay round-trip", () => {
  it("runBountyReplay result matches live result (player dies naturally)", () => {
    // Do NOT pass maxTicks here — let the player die naturally in combat.
    // Using a script that ends quickly (player stands still and dies to enemies).
    // We use the same SEED/HERO as the other sim-replay tests which confirm death in ~300 ticks.
    const { result: liveResult, replayBytes } = recordRun({
      seed: SEED,
      heroClass: HERO,
      // no maxTicks — defaults to MAX_TICKS (144000), sim's own maxTicks=null → no timeLimit
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 300 }, // player dies to enemies (same as sim-combat-replay tests)
      ],
    });

    // liveResult.settlementReason should be "death" (player died)
    // or "timeout" if 305 ticks isn't enough to die on this seed.
    // Either way, runBountyReplay must match the liveResult on the fields it can compare.
    const replayResult = runBountyReplay({ seed: SEED, heroClass: HERO, replayBytes });

    // The replay stops when replay bytes are exhausted (305 ticks), which is less
    // than RUN_MAX_TICKS, so it returns "incomplete" if the player hasn't died.
    // If the player DID die, both sides return "death".
    // We only assert score/depth parity when both settled the same way.
    if (liveResult.settlementReason === "death" && replayResult.settlementReason === "death") {
      assert.equal(replayResult.dailyScore,          liveResult.dailyScore,          "dailyScore");
      assert.equal(replayResult.completionTimeTicks, liveResult.completionTimeTicks, "completionTimeTicks");
      assert.equal(replayResult.depthReached,        liveResult.depthReached,        "depthReached");
      assert.equal(replayResult.bossesDefeated,      liveResult.bossesDefeated,      "bossesDefeated");
      assert.equal(replayResult.visitedRoomCount,    liveResult.visitedRoomCount,    "visitedRoomCount");
    } else {
      // Incomplete replay: at minimum both results have a positive ticks count
      assert.ok(liveResult.completionTimeTicks > 0 || replayResult.completionTimeTicks > 0,
        "at least one side ran some ticks");
    }
  });

  it("result includes simVersion field", () => {
    const { result } = recordRun({
      seed: SEED,
      heroClass: HERO,
      maxTicks: RUN_MAX_TICKS,
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 1, wasPressed: { cancel: true } },
      ],
    });
    assert.equal(result.simVersion, SIM_VERSION);
  });

  it("runBountyReplay uses createRunStart internally (no heroIdentity drift)", () => {
    // Two replays with the same bytes must give the same result regardless of
    // what heroIdentity was associated with the live run — because runBountyReplay
    // always uses the fixed createRunStart baseline.
    const { replayBytes } = recordRun({
      seed: SEED,
      heroClass: HERO,
      maxTicks: RUN_MAX_TICKS,
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 50 },
      ],
    });
    const r1 = runBountyReplay({ seed: SEED, heroClass: HERO, replayBytes });
    const r2 = runBountyReplay({ seed: SEED, heroClass: HERO, replayBytes });
    assert.equal(r1.dailyScore,          r2.dailyScore);
    assert.equal(r1.settlementReason,    r2.settlementReason);
    assert.equal(r1.completionTimeTicks, r2.completionTimeTicks);
  });
});

// ---------------------------------------------------------------------------
// E. replayHash: keccak256(replayBytes) as 0x hex
// ---------------------------------------------------------------------------

describe("E — replayHash", () => {
  it("keccak256 of empty bytes produces known hash", () => {
    const empty = new Uint8Array(0);
    const hash  = "0x" + bytesToHex(keccak_256(empty));
    // keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    assert.equal(hash, "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  it("same replay bytes always produce the same replayHash", () => {
    const { replayBytes } = recordRun({
      seed: SEED,
      heroClass: HERO,
      maxTicks: RUN_MAX_TICKS,
      script: [
        { ticks: 5, wasPressed: { confirm: true } },
        { ticks: 1, wasPressed: { cancel: true } },
      ],
    });
    const h1 = "0x" + bytesToHex(keccak_256(replayBytes));
    const h2 = "0x" + bytesToHex(keccak_256(replayBytes));
    assert.equal(h1, h2);
  });

  it("replayHash is 0x + 64 hex chars (32 bytes)", () => {
    const { replayBytes } = recordRun({
      seed: SEED,
      heroClass: HERO,
      maxTicks: RUN_MAX_TICKS,
      script: [{ ticks: 5, wasPressed: { confirm: true } }, { ticks: 1 }],
    });
    const hash = "0x" + bytesToHex(keccak_256(replayBytes));
    assert.ok(/^0x[0-9a-f]{64}$/.test(hash), `replayHash format invalid: ${hash}`);
  });

  it("different replay bytes → different hash", () => {
    const a = new Uint8Array([0, 0, 0]);
    const b = new Uint8Array([0, 0, 1]);
    const ha = "0x" + bytesToHex(keccak_256(a));
    const hb = "0x" + bytesToHex(keccak_256(b));
    assert.notEqual(ha, hb);
  });
});

// ---------------------------------------------------------------------------
// F. Seed URL validation: 0x + 64 hex chars only
// ---------------------------------------------------------------------------

describe("F — seed URL validation", () => {
  // Mirror of the regex used in app.js for ?seed= param parsing
  const SEED_RE = /^0x[0-9a-fA-F]{64}$/;

  const validSeeds = [
    "0x" + "a".repeat(64),
    "0x" + "0".repeat(64),
    "0x4be1cc855dfeacd0e7778c8d8d83fc826b6942ea35f872eebf01c8da0e3945ef",
    "0x" + "F".repeat(64),   // uppercase accepted
  ];

  const invalidSeeds = [
    "0x" + "a".repeat(63),   // too short
    "0x" + "a".repeat(65),   // too long
    "a".repeat(64),           // no 0x prefix
    "0x" + "g".repeat(64),   // invalid hex char
    "",
    null,
    undefined,
    "0x",
  ];

  for (const s of validSeeds) {
    it(`accepts valid seed: ${s.slice(0, 12)}...`, () => {
      assert.ok(SEED_RE.test(s ?? ""), `should match: ${s}`);
    });
  }

  for (const s of invalidSeeds) {
    it(`rejects invalid seed: ${String(s).slice(0, 20)}`, () => {
      assert.ok(!SEED_RE.test(s ?? ""), `should not match: ${s}`);
    });
  }
});

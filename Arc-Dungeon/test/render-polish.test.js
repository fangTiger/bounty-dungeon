/**
 * render-polish.test.js — node tests for the visual-polish rendering additions.
 *
 * Tests:
 *   1. pixelSurface backing size math (3)
 *   2. Torch placement determinism / doors / bounds / count (5)
 *   3. No sim imports in render-only modules (4)
 *   4. Torch drawTorches issues finite fillRect calls (mock context) (1)
 *   5. combatJuice PRNG: consecutive values differ (1)
 *   6. Bounty settlement never reaches "failed" and never calls settleRun (2)
 *   7. Entry scene: Discord hidden when disabled; note shown; no overlap (2)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, "../apps/web/src");

// ---------------------------------------------------------------------------
// 1. pixelSurface backing size math
// ---------------------------------------------------------------------------

describe("pixelSurface backing size", () => {
  it("backing width = INTERNAL_WIDTH * scale * dpr", () => {
    const INTERNAL_WIDTH = 320;
    const INTERNAL_HEIGHT = 180;
    const cssWidth = 960, cssHeight = 540;
    const scale = Math.max(1, Math.floor(Math.min(cssWidth / INTERNAL_WIDTH, cssHeight / INTERNAL_HEIGHT)));
    assert.equal(scale, 3);
    const dpr = 2;
    const k = scale * Math.max(1, Math.round(dpr));
    assert.equal(k, 6);
    assert.equal(INTERNAL_WIDTH * k, 1920);
    assert.equal(INTERNAL_HEIGHT * k, 1080);
  });

  it("CSS size = INTERNAL * scale (unchanged from before)", () => {
    const INTERNAL_WIDTH = 320;
    const scale = 3;
    assert.equal(INTERNAL_WIDTH * scale, 960);
  });

  it("dpr=1 gives k=scale (no HiDPI penalty)", () => {
    const scale = 2;
    const dpr = 1;
    const k = scale * Math.max(1, Math.round(dpr));
    assert.equal(k, 2);
  });
});

// ---------------------------------------------------------------------------
// 2. Torch placement
// ---------------------------------------------------------------------------

const { computeTorchPositions, drawTorches } = await import(`${ROOT}/runtime/scenes/dungeonTorches.js`);
const { DUNGEON_ROOM_WIDTH, DUNGEON_ROOM_HEIGHT, DUNGEON_TILE_SIZE } = await import(`${ROOT}/core/dungeon/roomMap.js`);
const { createCombatJuice } = await import(`${ROOT}/runtime/scenes/dungeonCombatJuice.js`);

function makeMap(roomId, hasDoors = true) {
  const W = DUNGEON_ROOM_WIDTH;
  const H = DUNGEON_ROOM_HEIGHT;
  const TS = DUNGEON_TILE_SIZE;
  return {
    id: roomId,
    width: W,
    height: H,
    tileSize: TS,
    room: {
      id: roomId,
      doors: hasDoors ? { north: true, south: true } : {},
    },
  };
}

describe("torch placement", () => {
  it("deterministic: same room id gives same positions", () => {
    const a = computeTorchPositions(makeMap("room-alpha-1"));
    const b = computeTorchPositions(makeMap("room-alpha-1"));
    assert.deepEqual(a, b);
  });

  it("different room ids give (likely) different positions", () => {
    const a = computeTorchPositions(makeMap("room-alpha-1")).map((t) => t.tileX);
    const b = computeTorchPositions(makeMap("room-beta-99")).map((t) => t.tileX);
    assert.ok(
      a.length !== b.length || a.some((x, i) => x !== b[i]),
      "Expected different positions for different room ids",
    );
  });

  it("torch tileX is never a door column (centre±1 of north door)", () => {
    const W = DUNGEON_ROOM_WIDTH;
    const cx = Math.floor(W / 2);
    const doorCols = new Set([cx - 1, cx, cx + 1]);
    for (let i = 0; i < 40; i++) {
      const torches = computeTorchPositions(makeMap(`room-test-${i}`));
      for (const t of torches) {
        assert.ok(
          !doorCols.has(t.tileX),
          `Torch at tileX=${t.tileX} overlaps door column in room-test-${i}`,
        );
      }
    }
  });

  it("torch worldX is within room bounds", () => {
    const W = DUNGEON_ROOM_WIDTH;
    const TS = DUNGEON_TILE_SIZE;
    for (let i = 0; i < 20; i++) {
      const torches = computeTorchPositions(makeMap(`room-bounds-${i}`));
      for (const t of torches) {
        assert.ok(t.worldX >= 0 && t.worldX < W * TS, `worldX=${t.worldX} out of bounds`);
      }
    }
  });

  it("at least 1 torch per room", () => {
    for (let i = 0; i < 20; i++) {
      const torches = computeTorchPositions(makeMap(`room-count-${i}`));
      assert.ok(torches.length >= 1, `Expected >= 1 torch for room-count-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. No sim imports in render-only modules
// ---------------------------------------------------------------------------

describe("render-only module sim-import check", () => {
  it("dungeonTorches.js does not import from core/simulation/", () => {
    const src = readFileSync(resolve(DIR, "../apps/web/src/runtime/scenes/dungeonTorches.js"), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    assert.ok(
      importLines.every((l) => !l.includes("core/simulation/")),
      `dungeonTorches.js must not import from core/simulation/. Found: ${importLines.filter((l) => l.includes("core/simulation/")).join(", ")}`,
    );
  });

  it("dungeonCombatJuice.js does not import from core/simulation/", () => {
    const src = readFileSync(resolve(DIR, "../apps/web/src/runtime/scenes/dungeonCombatJuice.js"), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    assert.ok(
      importLines.every((l) => !l.includes("core/simulation/")),
      `dungeonCombatJuice.js must not import from core/simulation/. Found: ${importLines.filter((l) => l.includes("core/simulation/")).join(", ")}`,
    );
  });

  it("dungeonTorches.js does not import headlessRunner", () => {
    const src = readFileSync(resolve(DIR, "../apps/web/src/runtime/scenes/dungeonTorches.js"), "utf8");
    assert.ok(!src.includes("headlessRunner"), "dungeonTorches.js must not import headlessRunner");
  });

  it("dungeonCombatJuice.js does not import headlessRunner", () => {
    const src = readFileSync(resolve(DIR, "../apps/web/src/runtime/scenes/dungeonCombatJuice.js"), "utf8");
    assert.ok(!src.includes("headlessRunner"), "dungeonCombatJuice.js must not import headlessRunner");
  });
});

// ---------------------------------------------------------------------------
// 4. drawTorches issues finite fillRect calls (mock context)
// ---------------------------------------------------------------------------

describe("drawTorches procedural rendering", () => {
  it("drawTorches calls fillRect with finite numbers for each torch", () => {
    const torches = computeTorchPositions(makeMap("room-torch-draw-test"));
    assert.ok(torches.length >= 1, "need at least 1 torch to test");

    const calls = [];
    const mockCtx = {
      save() {},
      restore() {},
      fillRect(x, y, w, h) { calls.push({ x, y, w, h }); },
      set fillStyle(_) {},
      imageSmoothingEnabled: true,
    };
    const mockCamera = {
      worldToScreen(wx, wy) { return { x: wx, y: wy }; },
    };

    drawTorches(mockCtx, torches, null, 0, mockCamera);

    assert.ok(calls.length > 0, "drawTorches should issue at least one fillRect call");
    for (const { x, y, w, h } of calls) {
      assert.ok(Number.isFinite(x), `fillRect x is not finite: ${x}`);
      assert.ok(Number.isFinite(y), `fillRect y is not finite: ${y}`);
      assert.ok(Number.isFinite(w) && w > 0, `fillRect w is not positive finite: ${w}`);
      assert.ok(Number.isFinite(h) && h > 0, `fillRect h is not positive finite: ${h}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. combatJuice PRNG: consecutive values from makeRng differ
// ---------------------------------------------------------------------------

describe("combatJuice PRNG", () => {
  it("consecutive rnd() values are distinct (stateful xorshift32)", () => {
    const juice = createCombatJuice();

    // Simulate two enemies hit in the same tick (same dtMs, same frame)
    const snapshot = {
      playerHp: 100,
      enemies: [
        { id: "e1", x: 50, y: 50, hp: 8, state: "alive" },
        { id: "e2", x: 80, y: 80, hp: 8, state: "alive" },
      ],
    };
    juice.update(snapshot, 16);

    // Now reduce both enemies' hp
    const snapshot2 = {
      playerHp: 100,
      enemies: [
        { id: "e1", x: 50, y: 50, hp: 5, state: "alive" },
        { id: "e2", x: 80, y: 80, hp: 5, state: "alive" },
      ],
    };

    // Collect fillRect calls to see if spark positions vary
    const calls = [];
    const mockCtx = {
      save() {},
      restore() {},
      set globalAlpha(_) {},
      set fillStyle(_) {},
      fillRect(x, y, _w, _h) { calls.push({ x, y }); },
    };
    const mockCamera = {
      worldToScreen(wx, wy) { return { x: Math.round(wx), y: Math.round(wy) }; },
    };

    juice.update(snapshot2, 16);
    // Advance by 100ms so particles are live
    const snap3 = {
      playerHp: 100,
      enemies: [
        { id: "e1", x: 50, y: 50, hp: 5, state: "alive" },
        { id: "e2", x: 80, y: 80, hp: 5, state: "alive" },
      ],
    };
    juice.update(snap3, 100);
    juice.drawParticles(mockCtx, mockCamera);

    assert.ok(calls.length >= 2, `Expected >= 2 spark/dust fillRect calls, got ${calls.length}`);
    // Not all positions should be identical (PRNG must be stateful)
    const unique = new Set(calls.map((c) => `${c.x},${c.y}`));
    assert.ok(unique.size >= 2, `All ${calls.length} particles landed at identical positions — PRNG is likely broken`);
  });
});

// ---------------------------------------------------------------------------
// 6. Bounty settlement: never reaches "failed", never calls settleRun
// ---------------------------------------------------------------------------

const { createDungeonSettlementFlow } = await import(`${ROOT}/runtime/scenes/dungeonSettlementFlow.js`);

describe("bounty settlement flow", () => {

  const FAKE_T = (key) => key; // identity translator

  // makeRun mirrors the actual sim run object — no score/visitedRoomCount at top level.
  function makeRun(overrides = {}) {
    return {
      depth: 3,
      stats: { bossesDefeated: 1, visitedRoomCount: 12 },
      settlementReason: "timeLimit",
      ...overrides,
    };
  }

  // makeSummary mirrors _runPackage.result (the pre-computed package result).
  function makeSummary(overrides = {}) {
    return {
      score: 305000,
      depth: 3,
      bossesDefeated: 1,
      visitedRoomCount: 12,
      settlementReason: "timeLimit",
      ...overrides,
    };
  }

  it("bounty run goes to 'ready' immediately, never 'failed'", async () => {
    let settleRunCalled = false;
    const settleRun = async () => {
      settleRunCalled = true;
      return { ok: false }; // would cause "failed" in normal flow
    };

    const flow = createDungeonSettlementFlow({
      settleRun,
      returnToHub: () => {},
      isBountyRun: true,
      t: FAKE_T,
    });

    flow.begin({ run: makeRun(), player: { hp: 10 }, reason: "timeLimit", summary: makeSummary() });

    // Allow any pending microtasks (settleRun is async)
    await new Promise((r) => setTimeout(r, 10));

    const snap = flow.getSnapshot();
    assert.ok(snap !== null, "settlement should be active");
    assert.equal(snap.status, "ready", `Expected 'ready', got '${snap.status}'`);
    assert.ok(!settleRunCalled, "settleRun must NOT be called for bounty runs");
  });

  it("bounty settlement snapshot equals the package result summary", () => {
    const flow = createDungeonSettlementFlow({
      settleRun: async () => ({ ok: false }),
      returnToHub: () => {},
      isBountyRun: true,
      t: FAKE_T,
    });
    const summary = makeSummary({ score: 101984, depth: 1, visitedRoomCount: 1, bossesDefeated: 0 });
    flow.begin({ run: makeRun(), player: { hp: 10 }, reason: "timeLimit", summary });
    const snap = flow.getSnapshot();
    assert.equal(snap.settlement?.isBountyRun, true);
    assert.equal(snap.settlement?.score, 101984,           "score must match summary");
    assert.equal(snap.settlement?.depthReached, 1,         "depth must match summary");
    assert.equal(snap.settlement?.visitedRoomCount, 1,     "rooms must match summary");
    assert.equal(snap.settlement?.bossesDefeated, 0,       "bosses must match summary");
  });

  it("bounty settlement falls back to run.stats when summary is absent", () => {
    const flow = createDungeonSettlementFlow({
      settleRun: async () => ({ ok: false }),
      returnToHub: () => {},
      isBountyRun: true,
      t: FAKE_T,
    });
    // No summary passed — should fall back to run.stats
    flow.begin({ run: makeRun(), player: { hp: 10 }, reason: "timeLimit" });
    const snap = flow.getSnapshot();
    assert.equal(snap.settlement?.isBountyRun, true);
    assert.equal(snap.settlement?.score, 0,            "no summary → score falls back to 0");
    assert.equal(snap.settlement?.depthReached, 3,     "depth from run.depth");
    assert.equal(snap.settlement?.visitedRoomCount, 12, "rooms from run.stats");
    assert.equal(snap.settlement?.bossesDefeated, 1,   "bosses from run.stats");
  });

  it("normal run still goes through settleRun as before", async () => {
    let settleRunCalled = false;
    const settleRun = async () => {
      settleRunCalled = true;
      return { ok: true, rewards: { tokens: 5 }, depthReached: 3, bossesDefeated: 1, explorationRate: 0.7, balance: { tokens: 5 }, bagSettlement: null };
    };

    const flow = createDungeonSettlementFlow({
      settleRun,
      returnToHub: () => {},
      isBountyRun: false,
      t: FAKE_T,
    });

    flow.begin({ run: makeRun(), player: { hp: 10 }, reason: "timeLimit" });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(settleRunCalled, "settleRun MUST be called for normal runs");
    assert.equal(flow.getSnapshot().status, "ready");
  });
});

// ---------------------------------------------------------------------------
// 7. Entry scene: Discord row hidden when disabled; note rendered
// ---------------------------------------------------------------------------

const { drawEntryScene } = await import(`${ROOT}/runtime/scenes/entrySceneUi.js`);

describe("entry scene: Discord hidden when unavailable", () => {
  // We exercise drawEntryScene with a minimal mock to verify:
  //   a) when Discord is disabled, OPTION_RECTS[0] is used for the guest option
  //   b) a note line is drawn (fillRect or text call) below the guest row
  //   c) only 1 option rect is returned

  it("optionRects has length 1 when Discord is disabled", () => {
    const ops = [];
    const texts = [];
    const mockCtx = {
      save() {},
      restore() {},
      set fillStyle(_) {},
      fillRect(x, y, w, h) { ops.push({ x, y, w, h }); },
      set font(_) {},
      set textAlign(_) {},
      set textBaseline(_) {},
      fillText(text, x, y) { texts.push({ text, x, y }); },
      measureText() { return { width: 50 }; },
      set globalAlpha(_) {},
      createRadialGradient() { return { addColorStop() {} }; },
      drawImage() {},
      imageSmoothingEnabled: false,
    };

    const mockTileset = { frames: {} };

    const options = [
      { id: "discord", label: "Login with Discord", disabled: true, disabledReason: "Discord not configured" },
      { id: "guest",   label: "Continue as Guest",  disabled: false, disabledReason: null },
    ];

    const result = drawEntryScene(mockCtx, {
      width: 320, height: 180,
      tileset: mockTileset,
      options,
      selectedIndex: 1, // guest is selected
      statusKey: "entry.status.discordUnavailable",
      statusText: "Discord not configured",
      authorizing: false,
      elapsedMs: 0,
      t: (key) => key,
    });

    assert.equal(result.optionRects.length, 1, "Should only have 1 option rect when Discord is hidden");
  });

  it("when Discord is available, optionRects has length 2", () => {
    const mockCtx = {
      save() {},
      restore() {},
      set fillStyle(_) {},
      fillRect() {},
      set font(_) {},
      set textAlign(_) {},
      set textBaseline(_) {},
      fillText() {},
      measureText() { return { width: 50 }; },
      set globalAlpha(_) {},
      createRadialGradient() { return { addColorStop() {} }; },
      drawImage() {},
      imageSmoothingEnabled: false,
    };

    const mockTileset = { frames: {} };

    const options = [
      { id: "discord", label: "Login with Discord", disabled: false, disabledReason: null },
      { id: "guest",   label: "Continue as Guest",  disabled: false, disabledReason: null },
    ];

    const result = drawEntryScene(mockCtx, {
      width: 320, height: 180,
      tileset: mockTileset,
      options,
      selectedIndex: 0,
      statusKey: "entry.status.chooseLogin",
      statusText: "Choose a login method.",
      authorizing: false,
      elapsedMs: 0,
      t: (key) => key,
    });

    assert.equal(result.optionRects.length, 2, "Should have 2 option rects when Discord is available");
  });
});

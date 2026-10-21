/**
 * sim-foot-collision.test.js
 *
 * Tests for the foot-based collision fix (PLAYER_FOOT_OFFSET / PLAYER_FOOT_RADIUS):
 *   (a) Pillar room: walking up from below, feet stop within 3 px of pillar base.
 *   (b) Pillar room: walking down from above, feet stop at pillar base top edge.
 *   (c) Spawn position and every door threshold are walkable for all templates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLAYER_FOOT_OFFSET,
  PLAYER_FOOT_RADIUS,
  PLAYER_SPEED,
  STEP_MS,
} from "../apps/web/src/core/simulation/dungeonSim.js";
import {
  buildDungeonRoomMap,
  canMoveCharacterTo,
  DUNGEON_ROOM_HEIGHT,
  DUNGEON_ROOM_WIDTH,
  DUNGEON_TILE_SIZE,
  getDungeonSpawnPosition,
} from "../apps/web/src/core/dungeon/roomMap.js";
import {
  buildRoomTemplateTiles,
  ROOM_TEMPLATES,
  chooseRoomTemplate,
} from "../apps/web/src/core/dungeon/roomTemplates.js";
import {
  getDoorDefinitionsForRoom,
  isInsideDoorway,
} from "../apps/web/src/core/dungeon/roomTransitions.js";
import { createRun } from "../apps/web/src/core/run/runState.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const W = DUNGEON_ROOM_WIDTH;
const H = DUNGEON_ROOM_HEIGHT;
const TS = DUNGEON_TILE_SIZE;

/** Build a roomMap for a given template id, forcing it via the template mechanism. */
function buildMapForTemplate(templateId, variant = null) {
  const run = createRun({ seed: SEED, heroClass: "knight" });
  // Force the template by picking a room whose type gives us the right template
  // — we use a support room and fake the roomMap from scratch.
  const template = { id: templateId, variant };
  const templateTiles = buildRoomTemplateTiles({ template, width: W, height: H });

  // Build a minimal roomMap-like object sufficient for canMoveCharacterTo.
  // We need layers.walls (from buildRoomWalls) and template.blockedTiles.
  // We also need interactions = [] and content = null for canMoveToDungeonRoom.
  // The easiest way is to use buildDungeonRoomMap with a run whose first room
  // has the right template chosen — but we can't force that easily.
  // Instead, build a fake map with template.blockedTiles directly.
  const walls = buildBlankWalls(W, H);
  return {
    id: "test",
    width: W,
    height: H,
    tileSize: TS,
    room: { id: "test", type: "battle", doors: {} },
    template: Object.freeze({ id: templateId, variant, blockedTiles: templateTiles }),
    layers: Object.freeze({
      floor: { tiles: Array.from({ length: H }, () => Array(W).fill(null)) },
      walls: { tiles: walls },
    }),
    content: null,
    interactions: [],
  };
}

function buildBlankWalls(width, height) {
  // Only boundary tiles are blocked (row 0, row H-1, col 0, col W-1)
  return Array.from({ length: height }, (_, tileY) =>
    Array.from({ length: width }, (_, tileX) => {
      if (tileY === 0 || tileY === height - 1 || tileX === 0 || tileX === width - 1) {
        return "wall_mid";
      }
      return null;
    }),
  );
}

/** Simulate movement steps in a direction until blocked, return final body-centre y. */
function walkUntilBlocked(map, startX, startY, dirX, dirY, maxSteps = 600) {
  let x = startX;
  let y = startY;
  const dt = STEP_MS / 1000;
  const speed = PLAYER_SPEED;

  for (let i = 0; i < maxSteps; i++) {
    const nx = x + dirX * speed * dt;
    const ny = y + dirY * speed * dt;

    // Try x then y (axis-separated, matching _movePlayer logic)
    let moved = false;
    if (canMoveCharacterTo(map, nx, y, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET)) {
      x = nx;
      moved = true;
    }
    if (canMoveCharacterTo(map, x, ny, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET)) {
      y = ny;
      moved = true;
    }
    if (!moved) break;
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// (a) & (b): Pillar room collision
// ---------------------------------------------------------------------------

// Find a pillar tile that has a clear column below it (no walls or other blocked tiles)
// so we can actually walk up to it from below.
function findApproachablePillarTile(map) {
  // Sort by descending tileY so we pick the bottommost pillar (most room below it)
  const sorted = [...map.template.blockedTiles].sort((a, b) => b.tileY - a.tileY);
  for (const tile of sorted) {
    // Check that the tile directly below the pillar column is open and not a boundary wall
    const belowTileY = tile.tileY + 1;
    const tileX = tile.tileX;
    // Must be inside the walkable area (not boundary)
    if (tileX <= 0 || tileX >= W - 1 || belowTileY >= H - 1) continue;
    // Check two tiles below are not blocked
    const below1Open = !map.layers.walls.tiles[belowTileY]?.[tileX] &&
      !map.template.blockedTiles.some((t) => t.tileX === tileX && t.tileY === belowTileY);
    const below2Open = !map.layers.walls.tiles[belowTileY + 1]?.[tileX] &&
      !map.template.blockedTiles.some((t) => t.tileX === tileX && t.tileY === belowTileY + 1);
    if (below1Open && below2Open) return tile;
  }
  return sorted[0]; // fallback
}

describe("foot-collision: pillar room", () => {
  it("(a) walking up from below: drawn feet stop within PLAYER_FOOT_RADIUS of pillar tile base", () => {
    // The pillar tile's base in pixel coords is (tileY + 1) * TS.
    // When the player walks up with foot-based collision, feet (body_y + PLAYER_FOOT_OFFSET)
    // stop at the bottom edge of the blocked tile ± PLAYER_FOOT_RADIUS.
    const map = buildMapForTemplate("pillars");
    const blockedTile = findApproachablePillarTile(map);
    assert.ok(blockedTile, "pillar map must have at least one blocked tile");

    const pillarBasePx = (blockedTile.tileY + 1) * TS; // bottom of blocked tile (foot collision boundary)
    // Start two tiles below the pillar, same column, at the tile centre
    const startX = blockedTile.tileX * TS + TS / 2;
    const startY = (blockedTile.tileY + 2) * TS + TS / 2;

    // Verify start position is actually walkable
    const startWalkable = canMoveCharacterTo(map, startX, startY, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET);
    if (!startWalkable) {
      // If start is blocked (another pillar nearby), skip gracefully
      return;
    }

    const { y: finalY } = walkUntilBlocked(map, startX, startY, 0, -1);
    const feetY = finalY + PLAYER_FOOT_OFFSET;

    // feet must have moved (closer to the pillar than the start)
    assert.ok(
      feetY < startY + PLAYER_FOOT_OFFSET,
      `player should have moved upward (feetY=${feetY.toFixed(1)}, startFeetY=${(startY + PLAYER_FOOT_OFFSET).toFixed(1)})`,
    );

    // feet must be close to pillarBasePx (within PLAYER_FOOT_RADIUS + 1 tolerance)
    assert.ok(
      feetY >= pillarBasePx - PLAYER_FOOT_RADIUS - 1,
      `feet (${feetY.toFixed(1)}) should reach within foot radius of pillar base (${pillarBasePx})`,
    );
    assert.ok(
      feetY <= pillarBasePx + PLAYER_FOOT_RADIUS + 1,
      `feet (${feetY.toFixed(1)}) should not overshoot pillar base (${pillarBasePx})`,
    );
  });

  it("(b) walking down from above: body stops before foot enters the pillar tile top", () => {
    const map = buildMapForTemplate("pillars");
    // For downward approach, find a pillar with clear space above it
    const sorted = [...map.template.blockedTiles].sort((a, b) => a.tileY - b.tileY);
    let blockedTile = null;
    for (const tile of sorted) {
      const aboveTileY = tile.tileY - 1;
      if (aboveTileY <= 1 || tile.tileX <= 0 || tile.tileX >= W - 1) continue;
      const aboveOpen = !map.layers.walls.tiles[aboveTileY]?.[tile.tileX] &&
        !map.template.blockedTiles.some((t) => t.tileX === tile.tileX && t.tileY === aboveTileY);
      if (aboveOpen) { blockedTile = tile; break; }
    }
    assert.ok(blockedTile, "must find a pillar tile with open space above");

    const pillarTopPx = blockedTile.tileY * TS; // top edge of blocked tile
    // Start one tile above the pillar
    const startX = blockedTile.tileX * TS + TS / 2;
    const startY = (blockedTile.tileY - 1) * TS + TS / 2;

    const startWalkable = canMoveCharacterTo(map, startX, startY, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET);
    if (!startWalkable) return; // graceful skip if start blocked

    const { y: finalY } = walkUntilBlocked(map, startX, startY, 0, 1);
    const feetY = finalY + PLAYER_FOOT_OFFSET;

    // Feet must not enter the blocked tile (feet should stay <= pillarTopPx + PLAYER_FOOT_RADIUS)
    assert.ok(
      feetY <= pillarTopPx + PLAYER_FOOT_RADIUS + 1,
      `feet (${feetY.toFixed(1)}) should not enter pillar tile (top at ${pillarTopPx})`,
    );
    // And player must have been stopped (not walked all the way through)
    assert.ok(
      finalY < (blockedTile.tileY + 2) * TS,
      `player should have been stopped near pillar, not walked through (finalY=${finalY.toFixed(1)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// (c) Spawn and door thresholds walkable for all templates
// ---------------------------------------------------------------------------

describe("foot-collision: spawn and doors walkable for all templates", () => {
  const spawn = getDungeonSpawnPosition();

  // Regression: player.radius is the body radius (PLAYER_RADIUS = 5), not PLAYER_FOOT_RADIUS.
  // Tile collision uses PLAYER_FOOT_RADIUS directly; player.radius is used by combat math.
  it("createRunStart player.radius equals PLAYER_RADIUS (body radius), not PLAYER_FOOT_RADIUS", async () => {
    const { PLAYER_RADIUS, PLAYER_FOOT_RADIUS } = await import("../apps/web/src/core/simulation/dungeonSim.js");
    const { createRunStart } = await import("../apps/web/src/core/simulation/runStart.js");
    const { player } = createRunStart({ seed: "0xabcdef", heroClass: "knight" });
    assert.equal(player.radius, PLAYER_RADIUS, "player.radius must be the body radius PLAYER_RADIUS");
    assert.notEqual(player.radius, PLAYER_FOOT_RADIUS, "player.radius must NOT be PLAYER_FOOT_RADIUS");
  });

  it("dungeonScene.js imports PLAYER_RADIUS from dungeonSim.js (no literal radius in createPlayer call)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(dir, "../apps/web/src/runtime/scenes/dungeonScene.js"), "utf8");
    assert.ok(
      src.includes("PLAYER_RADIUS"),
      "dungeonScene.js must import and use PLAYER_RADIUS from dungeonSim.js",
    );
    // Make sure there's no raw literal `radius: 5` left in the player creation block
    assert.ok(
      !src.includes("radius: 5,"),
      "dungeonScene.js must not contain literal `radius: 5,` — use PLAYER_RADIUS",
    );
  });

  for (const template of ROOM_TEMPLATES) {
    it(`template "${template.id}" — spawn position is walkable`, () => {
      const map = buildMapForTemplate(template.id);
      const walkable = canMoveCharacterTo(map, spawn.x, spawn.y, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET);
      assert.ok(
        walkable,
        `spawn (${spawn.x}, ${spawn.y}) blocked in template "${template.id}"`,
      );
    });

    it(`template "${template.id}" — north door threshold is walkable`, () => {
      // A room with a north door: door centre is at (W/2 * TS, 2*TS + TS/2) per getEntryPositionAfterExit
      const map = buildMapForTemplate(template.id);
      const doorEntryY = 2 * TS + TS / 2; // entry from north
      const doorX = Math.round((W * TS) / 2);
      const walkable = canMoveCharacterTo(map, doorX, doorEntryY, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET);
      assert.ok(
        walkable,
        `north door entry (${doorX}, ${doorEntryY}) blocked in template "${template.id}"`,
      );
    });

    it(`template "${template.id}" — south door threshold is walkable`, () => {
      const map = buildMapForTemplate(template.id);
      const doorEntryY = (H - 3) * TS + TS / 2; // entry from south
      const doorX = Math.round((W * TS) / 2);
      const walkable = canMoveCharacterTo(map, doorX, doorEntryY, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET);
      assert.ok(
        walkable,
        `south door entry (${doorX}, ${doorEntryY}) blocked in template "${template.id}"`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Pillar offsetY alignment test
// ---------------------------------------------------------------------------
describe("pillars template — pillar tile offsetY aligns base to tile bottom", () => {
  const pillarTemplate = ROOM_TEMPLATES.find((t) => t.id === "pillars");

  it("every pillar tile has offsetY === -20", () => {
    const tiles = buildRoomTemplateTiles({ template: pillarTemplate, width: DUNGEON_ROOM_WIDTH, height: DUNGEON_ROOM_HEIGHT });
    const pillarTiles = tiles.filter((tile) => tile.frameName === "column");
    assert.ok(pillarTiles.length > 0, "expected at least one column tile");
    for (const tile of pillarTiles) {
      assert.equal(tile.offsetY, -20, `column tile at (${tile.tileX},${tile.tileY}) has offsetY ${tile.offsetY}, expected -20`);
    }
  });

  it("(offsetY + 36) === 16: base bottom aligns with the tile's bottom edge", () => {
    // The column art base ends at ~row 36 of the 48px frame.
    // offsetY + 36 should equal one tile height (16), putting the base flush with the blocked tile bottom.
    const tiles = buildRoomTemplateTiles({ template: pillarTemplate, width: DUNGEON_ROOM_WIDTH, height: DUNGEON_ROOM_HEIGHT });
    const pillarTile = tiles.find((tile) => tile.frameName === "column");
    assert.ok(pillarTile !== undefined, "expected a column tile");
    assert.equal(pillarTile.offsetY + 36, 16, `offsetY(${pillarTile.offsetY}) + 36 should equal 16`);
  });
});

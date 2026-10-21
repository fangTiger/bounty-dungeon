/**
 * dungeonTorches.js — render-only torch decorations for dungeon rooms.
 *
 * Torches are placed deterministically from the room id (no sim RNG consumed),
 * on top-wall tiles, never on door columns.  Each torch:
 *   - renders a wall_fountain_mid_red_anim sprite (3-frame animated warm flame)
 *   - contributes a flickering warm point light to the lighting pass
 *   - emits 1-2 tiny ember particles using a render-local PRNG
 *
 * HARD RULE: this module MUST NOT import from core/simulation/* or consume any
 * sim state beyond the room map (which is available after the sim tick).
 */

import { DUNGEON_ROOM_WIDTH, DUNGEON_TILE_SIZE } from "../../core/dungeon/roomMap.js";

// Torch animation: 3 frames cycled at 8 fps
const TORCH_FPS = 8;

// Light parameters — stronger so torches visibly illuminate wall + floor
const TORCH_RADIUS       = 44;
const TORCH_COLOR        = "#ff9a4d";
const TORCH_INTENSITY    = 0.50;
const TORCH_PULSE_SCALE  = 0.10;  // flicker amplitude

// Top wall row in tile coords (torches sit on the wall cap tiles at y=1)
const TORCH_TILE_Y = 1;
// How many torches per room (1-3, derived from room id)
const MAX_TORCHES = 3;

/** Door column x-tiles to avoid (centre two columns of the north wall). */
function getDoorColumns(roomWidth) {
  const cx = Math.floor(roomWidth / 2);
  return new Set([cx - 1, cx, cx + 1]);
}

/**
 * Tiny deterministic PRNG seeded with an integer.
 * lcg: next = (a*x + c) mod m  with Park-Miller constants.
 */
function makePrng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return function next() {
    s = Math.imul(1664525, s) + 1013904223 >>> 0;
    return s / 0x100000000;
  };
}

/** Hash a room-id string to a 32-bit integer (djb2). */
function hashRoomId(roomId) {
  let h = 5381;
  for (let i = 0; i < roomId.length; i++) {
    h = Math.imul(h, 33) ^ roomId.charCodeAt(i);
  }
  return h >>> 0;
}

/**
 * Compute torch tile positions for a given room map.
 * Returns an array of { tileX, worldX, worldY } (world coords = tile centre).
 */
export function computeTorchPositions(roomMap) {
  if (!roomMap?.room?.id) return [];

  const seed   = hashRoomId(roomMap.room.id);
  const rng    = makePrng(seed);
  const W      = roomMap.width ?? DUNGEON_ROOM_WIDTH;
  const TS     = roomMap.tileSize ?? DUNGEON_TILE_SIZE;
  const doors  = getDoorColumns(W);

  // Collect candidate x-tiles on the top wall (skip boundary cols 0 and W-1, skip door cols)
  const candidates = [];
  for (let tx = 2; tx < W - 2; tx++) {
    if (!doors.has(tx)) candidates.push(tx);
  }

  // Shuffle deterministically and take up to MAX_TORCHES, spaced >= 3 apart
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const count = 1 + Math.floor(rng() * MAX_TORCHES); // 1-3
  const chosen = [];
  for (const tx of candidates) {
    if (chosen.length >= count) break;
    if (chosen.every((c) => Math.abs(c - tx) >= 3)) {
      chosen.push(tx);
    }
  }

  return chosen.map((tileX) => ({
    tileX,
    worldX: tileX * TS + TS / 2,
    worldY: TORCH_TILE_Y * TS + TS / 2,
  }));
}

// ---------------------------------------------------------------------------
// Ember particle pool (render-local, NOT sim state)
// ---------------------------------------------------------------------------

/** Create a render-only ember particle system for the torches in a room. */
export function createTorchEmbers() {
  const particles = [];
  let prng = makePrng(0);

  function reset(roomSeed) {
    particles.length = 0;
    prng = makePrng(roomSeed ^ 0xf00dcafe);
  }

  function update(torches, dtMs) {
    // Age existing particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.ageMs += dtMs;
      p.x += p.vx * (dtMs / 1000);
      p.y += p.vy * (dtMs / 1000);
      p.vy -= 6 * (dtMs / 1000); // rise
      if (p.ageMs >= p.maxAgeMs) {
        particles.splice(i, 1);
      }
    }

    // Spawn new embers from each torch (1-2 per frame on average, capped)
    for (const torch of torches) {
      if (particles.length > 80) break;
      if (prng() < 0.08 * (dtMs / 16)) {
        particles.push({
          x: torch.worldX + (prng() - 0.5) * 4,
          y: torch.worldY - 2 + (prng() - 0.5) * 2,
          vx: (prng() - 0.5) * 8,
          vy: 12 + prng() * 8,
          ageMs: 0,
          maxAgeMs: 400 + prng() * 300,
          r: 1,
        });
      }
    }
  }

  function draw(context, camera) {
    if (!particles.length) return;
    context.save();
    for (const p of particles) {
      const t = p.ageMs / p.maxAgeMs;
      const alpha = (1 - t) * 0.85;
      const screen = camera.worldToScreen(p.x, p.y);
      context.globalAlpha = alpha;
      context.fillStyle = t < 0.5 ? "#ffcc66" : "#ff6622";
      context.fillRect(Math.round(screen.x), Math.round(screen.y), p.r, p.r);
    }
    context.restore();
  }

  return { reset, update, draw };
}

// ---------------------------------------------------------------------------
// Light contributions
// ---------------------------------------------------------------------------

/**
 * Build the dynamic light list for the torches in a room.
 * Call once per render frame.
 */
export function buildTorchLights(torches, elapsedMs) {
  const lights = [];
  const seconds = elapsedMs / 1000;

  for (let i = 0; i < torches.length; i++) {
    const torch = torches[i];
    // Each torch flickers with a slightly different phase
    const phase = i * 1.37 + torch.tileX * 0.23;
    const flicker = softFlicker(seconds + phase, 1.3, 2.7, 4.1);
    const radius    = TORCH_RADIUS    * (1 + flicker * TORCH_PULSE_SCALE);
    const intensity = TORCH_INTENSITY * (1 + flicker * TORCH_PULSE_SCALE * 1.4);

    lights.push({
      x: torch.worldX,
      y: torch.worldY,
      radius,
      color:    TORCH_COLOR,
      intensity,
    });
  }

  return lights;
}

function softFlicker(seconds, f1, f2, f3) {
  return (Math.sin(seconds * f1) + Math.sin(seconds * f2 + 1.4) * 0.5 + Math.sin(seconds * f3 + 0.2) * 0.24) / 1.74;
}

// ---------------------------------------------------------------------------
// Procedural pixel-art torch drawing
// ---------------------------------------------------------------------------

/**
 * Palette for the 3 flame animation frames (deep orange / orange / pale yellow core).
 * Each frame is drawn as a ~6×12 px shape: 2px bracket, 2px handle, 3 flame rows.
 */
const FLAME_FRAMES = [
  // frame 0 — deep orange
  { outer: "#c85a00", mid: "#e07020", tip: "#f5a030" },
  // frame 1 — orange
  { outer: "#e07020", mid: "#f5a030", tip: "#ffe070" },
  // frame 2 — pale yellow core (brightest)
  { outer: "#f5a030", mid: "#ffe070", tip: "#ffffff" },
];

const BRACKET_COLOR = "#2a2028";   // dark iron bracket
const HANDLE_COLOR  = "#5c3a1e";   // brown wood handle

/**
 * Draw procedural pixel-art wall torches.
 * Uses only fillRect — no drawImage, no atlas dependency.
 * Each torch is ~6×14 px in 320×180 logical space (crisp after the DPR scale).
 */
export function drawTorches(context, torches, _tileset, elapsedMs, camera) {
  if (!torches.length) return;

  const frameIndex = Math.floor(elapsedMs / (1000 / TORCH_FPS)) % FLAME_FRAMES.length;
  const flame      = FLAME_FRAMES[frameIndex];

  context.save();
  context.imageSmoothingEnabled = false;

  for (const torch of torches) {
    const screen = camera.worldToScreen(torch.worldX, torch.worldY);
    // Align to pixel grid in logical (320×180) space
    const bx = Math.round(screen.x) - 3;  // left edge of 6px wide sprite
    const by = Math.round(screen.y) - 5;  // top edge (wall face row)

    // ── Flame (rows 0-5, bottom-up from tip) ──────────────────────────────
    // row 0 (top tip) — 2px wide, centred
    p(context, flame.tip,   bx + 2, by,     2, 2);
    // row 1 — 4px wide
    p(context, flame.mid,   bx + 1, by + 2, 4, 2);
    // row 2 (base of flame) — 6px wide
    p(context, flame.outer, bx,     by + 4, 6, 2);

    // ── Handle / torch body ───────────────────────────────────────────────
    // 2px wide, 4px tall brown stick
    p(context, HANDLE_COLOR, bx + 2, by + 6, 2, 4);

    // ── Wall bracket ─────────────────────────────────────────────────────
    // horizontal arm: 4px wide, 1px tall at handle base
    p(context, BRACKET_COLOR, bx + 1, by + 10, 4, 1);
    // vertical pin: 1px wide, 3px tall against wall
    p(context, BRACKET_COLOR, bx + 5, by + 8,  1, 3);
  }

  context.restore();
}

/** Shorthand fillRect in logical coords */
function p(ctx, color, x, y, w, h) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

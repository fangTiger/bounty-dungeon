/**
 * inputCapture — per-tick input snapshot recording with RLE compression.
 *
 * ## Frame encoding (4 bytes / frame)
 *
 * Byte 0 — held direction keys (4 bits, independent)
 *   bit 0: left held
 *   bit 1: right held
 *   bit 2: up held
 *   bit 3: down held
 *   bits 4-7: reserved (0)
 *
 * Byte 1 — wasPressed action bitmask (edge-triggered)
 *   bit 0: attack
 *   bit 1: dodge
 *   bit 2: interact
 *   bit 3: cancel
 *   bit 4: skill1
 *   bit 5: skill2
 *   bit 6: skill3
 *   bit 7: skill4
 *
 * Byte 2 — wasPressed action bitmask (edge-triggered), continued
 *   bit 0: choice1
 *   bit 1: choice2
 *   bit 2: choice3
 *   bit 3: tabPanel
 *   bit 4: confirm
 *   bit 5: up   (wasPressed — for room-event / upgrade-choice navigation)
 *   bit 6: down (wasPressed)
 *   bit 7: reserved (0)
 *
 * Byte 3 — wasPressed action bitmask, continued
 *   bit 0: left  (wasPressed — upgrade-choice cursor)
 *   bit 1: right (wasPressed — upgrade-choice cursor)
 *   bits 2-7: reserved (0)
 *
 * ## Direction reconstruction
 *
 * Use buildDirectionFromKeys(heldLeft, heldRight, heldUp, heldDown) — the ONE
 * shared implementation.  runtime/input.js must import and call this too so
 * live and replay produce bit-identical vectors.
 *
 * ## RLE encoding
 *
 * Sequence of packets: [count: uint16 big-endian][b0][b1][b2][b3] = 6 bytes.
 * A 10-minute run at 60 Hz is 36 000 ticks; typical gameplay gives well under
 * 2 000 packets (~12 KB uncompressed replay).
 */

export const REPLAY_ACTIONS_BYTE1 = [
  "attack", "dodge", "interact", "cancel",
  "skill1", "skill2", "skill3", "skill4",
];

export const REPLAY_ACTIONS_BYTE2 = [
  "choice1", "choice2", "choice3", "tabPanel",
  "confirm", "up", "down",
];

export const REPLAY_ACTIONS_BYTE3 = [
  "left", "right",
];

// ---------------------------------------------------------------------------
// Shared direction builder — imported by both inputCapture.js and input.js
// ---------------------------------------------------------------------------

/**
 * Build a normalised direction vector from four boolean held-key states.
 * Diagonal: scale each component by 1/√2 using the same approximation as the
 * original runtime/input.js so behaviour is bit-identical.
 *
 * IMPORTANT: this is the single source of truth.  runtime/input.js must call
 * this function instead of inlining the diagonal calculation.
 */
export const SQRT1_2 = 0.7071067811865476; // Math.SQRT1_2, frozen constant

export function buildDirectionFromKeys(heldLeft, heldRight, heldUp, heldDown) {
  let x = 0;
  let y = 0;
  if (heldLeft)  x -= 1;
  if (heldRight) x += 1;
  if (heldUp)    y -= 1;
  if (heldDown)  y += 1;

  if (x !== 0 && y !== 0) {
    return { x: x * SQRT1_2, y: y * SQRT1_2 };
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Frame encode / decode
// ---------------------------------------------------------------------------

function encodeFrame(snapshot) {
  const dir  = snapshot.direction ?? { x: 0, y: 0 };
  const held = snapshot.heldKeys  ?? deriveHeldKeysFromDirection(dir);
  const wp   = snapshot.wasPressed ?? {};

  // Byte 0: held direction bits
  const b0 = (held.left  ? 0x01 : 0)
           | (held.right ? 0x02 : 0)
           | (held.up    ? 0x04 : 0)
           | (held.down  ? 0x08 : 0);

  // Byte 1
  let b1 = 0;
  for (let i = 0; i < REPLAY_ACTIONS_BYTE1.length; i++) {
    if (wp[REPLAY_ACTIONS_BYTE1[i]]) b1 |= (1 << i);
  }

  // Byte 2
  let b2 = 0;
  for (let i = 0; i < REPLAY_ACTIONS_BYTE2.length; i++) {
    if (wp[REPLAY_ACTIONS_BYTE2[i]]) b2 |= (1 << i);
  }

  // Byte 3
  let b3 = 0;
  for (let i = 0; i < REPLAY_ACTIONS_BYTE3.length; i++) {
    if (wp[REPLAY_ACTIONS_BYTE3[i]]) b3 |= (1 << i);
  }

  return [b0, b1, b2, b3];
}

/**
 * When a caller only supplies `direction` (no `heldKeys`), we reconstruct a
 * best-guess set of held keys.  This is used by the headlessRunner scripted
 * input path where direction vectors are specified directly.
 */
function deriveHeldKeysFromDirection(dir) {
  // Sign-based derivation — loses no information since buildDirectionFromKeys
  // produces exactly ±1 or ±SQRT1_2 components.
  return {
    left:  dir.x < -0.1,
    right: dir.x >  0.1,
    up:    dir.y < -0.1,
    down:  dir.y >  0.1,
  };
}

function framesEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Create a new recorder.  Call captureFrame() once per sim tick (immediately
 * before sim.update consumes input), then finish() to get the Uint8Array.
 *
 * The snapshot passed to captureFrame must carry:
 *   heldKeys: { left, right, up, down }  — boolean, current frame
 *   wasPressed: Record<action, true>      — edge-triggered actions this tick
 */
export function createReplayRecorder() {
  const runs = [];
  let totalTicks = 0;

  function captureFrame(snapshot) {
    const frame = encodeFrame(snapshot);
    totalTicks += 1;

    if (
      runs.length > 0 &&
      framesEqual(runs[runs.length - 1].frame, frame) &&
      runs[runs.length - 1].count < 65535
    ) {
      runs[runs.length - 1].count += 1;
    } else {
      runs.push({ frame, count: 1 });
    }
  }

  function finish() {
    // 6 bytes per run: 2-byte count + 4 frame bytes
    const buf = new Uint8Array(runs.length * 6);
    let offset = 0;
    for (const run of runs) {
      buf[offset++] = (run.count >> 8) & 0xff;
      buf[offset++] =  run.count       & 0xff;
      buf[offset++] = run.frame[0];
      buf[offset++] = run.frame[1];
      buf[offset++] = run.frame[2];
      buf[offset++] = run.frame[3];
    }
    return buf;
  }

  function getStats() {
    return { totalTicks, runCount: runs.length };
  }

  return { captureFrame, finish, getStats };
}

// ---------------------------------------------------------------------------
// Replay reading
// ---------------------------------------------------------------------------

/** Decode a compressed replay Uint8Array into a per-tick snapshot iterator. */
export function* decodeReplay(buf) {
  let offset = 0;
  while (offset + 5 < buf.length) {
    const count = (buf[offset] << 8) | buf[offset + 1];
    const b0 = buf[offset + 2];
    const b1 = buf[offset + 3];
    const b2 = buf[offset + 4];
    const b3 = buf[offset + 5];
    offset += 6;

    // Decode held direction bits
    const heldLeft  = Boolean(b0 & 0x01);
    const heldRight = Boolean(b0 & 0x02);
    const heldUp    = Boolean(b0 & 0x04);
    const heldDown  = Boolean(b0 & 0x08);

    const direction = buildDirectionFromKeys(heldLeft, heldRight, heldUp, heldDown);

    // Decode wasPressed
    const wasPressed = {};
    for (let i = 0; i < REPLAY_ACTIONS_BYTE1.length; i++) {
      if (b1 & (1 << i)) wasPressed[REPLAY_ACTIONS_BYTE1[i]] = true;
    }
    for (let i = 0; i < REPLAY_ACTIONS_BYTE2.length; i++) {
      if (b2 & (1 << i)) wasPressed[REPLAY_ACTIONS_BYTE2[i]] = true;
    }
    for (let i = 0; i < REPLAY_ACTIONS_BYTE3.length; i++) {
      if (b3 & (1 << i)) wasPressed[REPLAY_ACTIONS_BYTE3[i]] = true;
    }

    const snapshot = {
      direction,
      heldKeys: { left: heldLeft, right: heldRight, up: heldUp, down: heldDown },
      wasPressed,
    };

    for (let i = 0; i < count; i++) {
      yield snapshot;
    }
  }
}

/**
 * Build a replay-backed input adapter.
 * Returns the adapter plus a `isExhausted()` predicate so callers can detect
 * when all recorded frames have been consumed.
 */
export function createReplayInput(replayBytes) {
  const iter = decodeReplay(replayBytes);
  let current = { direction: { x: 0, y: 0 }, heldKeys: { left: false, right: false, up: false, down: false }, wasPressed: {} };
  let exhausted = false;

  function advance() {
    const next = iter.next();
    if (next.done) {
      exhausted = true;
      current = { direction: { x: 0, y: 0 }, heldKeys: { left: false, right: false, up: false, down: false }, wasPressed: {} };
    } else {
      current = next.value;
    }
  }

  function getDirection() { return current.direction; }
  function wasPressed(action) { return Boolean(current.wasPressed[action]); }
  function wasAnyPressed() { return Object.keys(current.wasPressed).length > 0; }
  function commitFrame() { advance(); }
  function consumeTextInput() { return []; }
  function isDown() { return false; }
  function isExhausted() { return exhausted; }

  // Prime the first frame
  advance();

  return { getDirection, wasPressed, wasAnyPressed, commitFrame, consumeTextInput, isDown, isExhausted };
}

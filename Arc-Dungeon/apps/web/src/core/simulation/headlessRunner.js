/**
 * headlessRunner — drives createDungeonLogic to completion from a replay.
 *
 * Given a replay Uint8Array (from createReplayRecorder().finish()), runs the
 * simulation tick-by-tick at fixed 60 Hz until the run ends or the tick
 * budget is exhausted, then returns the final RunResult.
 *
 * This is the function the verifier API will call.  It is synchronous and
 * has no I/O, so it can run inside a Vercel Node function or a Node test.
 *
 * The returned RunResult is the value that will be signed by the verifier
 * and submitted to the DungeonBounty contract.
 */

import { createDungeonSimHeadless, RUN_MAX_TICKS } from "./dungeonSim.js";
import { createRunStart } from "./runStart.js";
import {
  createReplayInput,
  createReplayRecorder,
  buildDirectionFromKeys,
  REPLAY_ACTIONS_BYTE1,
  REPLAY_ACTIONS_BYTE2,
  REPLAY_ACTIONS_BYTE3,
} from "./inputCapture.js";

// Backwards-compat aliases so existing tests importing createDungeonLogic still work.
export { createDungeonSimHeadless as createDungeonLogic } from "./dungeonSim.js";

/**
 * Maximum ticks allowed for one run (40 minutes at 60 Hz = 144,000 ticks).
 * Runs exceeding this are declared "timeout" and scored as-is.
 */
export const MAX_TICKS = 144_000;

/**
 * Run the simulation to completion.
 *
 * @param {object} opts
 * @param {string}        opts.seed         - run seed
 * @param {string}        opts.heroClass    - "knight" | "wizzard"
 * @param {string}        [opts.gameVersion]
 * @param {Uint8Array}    opts.replayBytes  - compressed replay from recorder
 * @param {number}        [opts.maxTicks]   - override tick budget (default MAX_TICKS)
 * @returns {RunResult}
 */
export function runReplay({ seed, heroClass, gameVersion = "0.0.0", replayBytes, maxTicks = MAX_TICKS }) {
  const logic = createDungeonSimHeadless({ seed, heroClass, gameVersion });
  const input = createReplayInput(replayBytes);

  let ticks = 0;
  // Stop when the sim ends naturally, the replay runs out, or we hit maxTicks.
  while (!logic.isOver() && !input.isExhausted() && ticks < maxTicks) {
    logic.step(input);
    ticks += 1;
  }

  const result = logic.getResult();

  if (!logic.isOver()) {
    // Replay ran out before the sim ended — the run is incomplete (truncated
    // recording), or we hit the tick budget.
    const reason = ticks >= maxTicks ? "timeout" : "incomplete";
    return { ...result, settlementReason: reason };
  }

  return result;
}

/**
 * Replay a bounty run using the canonical baseline from createRunStart.
 * This is the correct function for self-check and verifier use:
 *   - Uses createRunStart (same fixed baseline as the live browser path).
 *   - Enforces maxTicks = RUN_MAX_TICKS so a 20-minute run ends "timeLimit"
 *     on both the live side and the replay side.
 *
 * @param {object} opts
 * @param {string}     opts.seed
 * @param {string}     opts.heroClass
 * @param {string}     [opts.gameVersion]
 * @param {Uint8Array} opts.replayBytes
 * @returns {RunResult}
 */
export function runBountyReplay({ seed, heroClass, gameVersion = "0.0.0", replayBytes }) {
  const startState = createRunStart({ seed, heroClass });
  const logic = createDungeonSimHeadless({ seed, heroClass, gameVersion, maxTicks: RUN_MAX_TICKS, startState });
  const input = createReplayInput(replayBytes);

  let ticks = 0;
  while (!logic.isOver() && !input.isExhausted() && ticks < RUN_MAX_TICKS) {
    logic.step(input);
    ticks += 1;
  }

  const result = logic.getResult();
  if (!logic.isOver()) {
    const reason = ticks >= RUN_MAX_TICKS ? "timeLimit" : "incomplete";
    return { ...result, settlementReason: reason };
  }
  return result;
}

/**
 * Run a scripted simulation (no replay bytes needed) — useful for tests.
 *
 * @param {object} opts
 * @param {string}       opts.seed
 * @param {string}       opts.heroClass
 * @param {string}       [opts.gameVersion]
 * @param {InputScript}  opts.script       - array of frame descriptors (see below)
 * @param {number}       [opts.maxTicks]   - default MAX_TICKS
 *
 * An InputScript is an array of objects:
 *   { ticks: number, direction?: {x,y}, wasPressed?: Record<string,true> }
 * Frames with no matching script entry get direction {x:0,y:0}, no presses.
 *
 * @returns {RunResult}
 */
export function runScripted({ seed, heroClass, gameVersion = "0.0.0", script = [], maxTicks = MAX_TICKS }) {
  const logic = createDungeonSimHeadless({ seed, heroClass, gameVersion });
  const input = createScriptedInput(script);

  let ticks = 0;
  while (!logic.isOver() && ticks < maxTicks) {
    logic.step(input);
    ticks += 1;
  }

  const result = logic.getResult();
  if (!logic.isOver()) {
    return { ...result, settlementReason: "timeout" };
  }
  return result;
}

/**
 * Run a scripted simulation while recording the input stream, then return
 * both the final result and the compressed replay bytes.
 *
 * This is the test-harness counterpart to a live browser run: it drives the
 * simulation with a deterministic script AND records every tick so the replay
 * can be verified to reproduce the same outcome.
 *
 * @param {object} opts
 * @param {string}       opts.seed
 * @param {string}       opts.heroClass
 * @param {string}       [opts.gameVersion]
 * @param {InputScript}  opts.script
 * @param {number}       [opts.maxTicks]
 * @returns {{ result: RunResult, replayBytes: Uint8Array }}
 */
export function recordRun({ seed, heroClass, gameVersion = "0.0.0", script = [], maxTicks = MAX_TICKS }) {
  // Pass maxTicks into the sim so that RUN_MAX_TICKS bounty runs get
  // settlementReason "timeLimit" (from the sim itself) rather than "timeout"
  // (from the outer harness loop). The outer loop limit is maxTicks + 1 as a
  // safety net only; the sim will have already settled before that.
  const logic = createDungeonSimHeadless({ seed, heroClass, gameVersion, maxTicks });
  const recorder = createReplayRecorder();

  // Build the scripted input adapter; we intercept captureFrame before each step.
  const scriptedInput = createScriptedInput(script);

  // Wrap scriptedInput to capture the frame snapshot before commitFrame() consumes it
  const recordingInput = {
    getDirection:     () => scriptedInput.getDirection(),
    getHeldKeys:      () => scriptedInput.getHeldKeys(),
    wasPressed:       (action) => scriptedInput.wasPressed(action),
    wasAnyPressed:    () => scriptedInput.wasAnyPressed(),
    consumeTextInput: () => scriptedInput.consumeTextInput?.() ?? [],
    isDown:           (action) => scriptedInput.isDown?.(action) ?? false,
    commitFrame() {
      // Capture the current frame BEFORE advancing to the next
      recorder.captureFrame({
        heldKeys:   scriptedInput.getHeldKeys(),
        wasPressed: captureWasPressed(scriptedInput),
      });
      scriptedInput.commitFrame();
    },
  };

  let ticks = 0;
  while (!logic.isOver() && ticks < maxTicks) {
    logic.step(recordingInput);
    ticks += 1;
  }

  const result = logic.isOver()
    ? logic.getResult()
    : { ...logic.getResult(), settlementReason: "timeout" };

  return { result, replayBytes: recorder.finish() };
}

/** Extract the wasPressed snapshot from a scripted input at the current tick. */
function captureWasPressed(input) {
  const pressed = {};
  const ALL_ACTIONS = [
    ...REPLAY_ACTIONS_BYTE1,
    ...REPLAY_ACTIONS_BYTE2,
    ...REPLAY_ACTIONS_BYTE3,
  ];
  for (const action of ALL_ACTIONS) {
    if (input.wasPressed(action)) pressed[action] = true;
  }
  return pressed;
}

// ---------------------------------------------------------------------------
// Internal: scripted input adapter for tests
// ---------------------------------------------------------------------------

function createScriptedInput(script) {
  // Build a flat per-tick array for O(1) lookup
  // script entries: { ticks, direction?, heldKeys?, wasPressed? }
  const frames = [];
  for (const entry of script) {
    const count = entry.ticks ?? 1;
    const frame = {
      direction:  entry.direction  ?? { x: 0, y: 0 },
      heldKeys:   entry.heldKeys   ?? null,
      wasPressed: entry.wasPressed ?? {},
    };
    for (let i = 0; i < count; i++) {
      frames.push(frame);
    }
  }

  let tick = 0;

  function getDirection() {
    const f = frames[tick];
    if (!f) return { x: 0, y: 0 };
    // If explicit heldKeys supplied, rebuild direction from them (canonical path)
    if (f.heldKeys) {
      return buildDirectionFromKeys(f.heldKeys.left, f.heldKeys.right, f.heldKeys.up, f.heldKeys.down);
    }
    return f.direction;
  }

  function getHeldKeys() {
    const f = frames[tick];
    if (!f) return { left: false, right: false, up: false, down: false };
    if (f.heldKeys) return f.heldKeys;
    // Derive from direction vector
    const dir = f.direction;
    return {
      left:  dir.x < -0.1,
      right: dir.x >  0.1,
      up:    dir.y < -0.1,
      down:  dir.y >  0.1,
    };
  }

  function wasPressed(action) {
    return Boolean(frames[tick]?.wasPressed?.[action]);
  }

  function wasAnyPressed() {
    const wp = frames[tick]?.wasPressed;
    return wp ? Object.keys(wp).length > 0 : false;
  }

  function commitFrame() {
    tick += 1;
  }

  function consumeTextInput() { return []; }
  function isDown() { return false; }

  return { getDirection, getHeldKeys, wasPressed, wasAnyPressed, commitFrame, consumeTextInput, isDown };
}

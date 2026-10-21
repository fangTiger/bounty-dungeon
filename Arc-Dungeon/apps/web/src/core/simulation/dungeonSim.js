/**
 * dungeonSim — canonical headless state machine for one dungeon run.
 *
 * Contains ALL state-changing logic: movement, room transitions, combat,
 * room events, interact (stairs / event), pickups (via combat subsystem),
 * upgrade choices (full handleUpgradeChoiceInput semantics), descend, and
 * settlement. No Canvas, no DOM, no Date.now, no performance.now.
 *
 * Used by:
 *   - The live browser game (dungeonScene.js delegates update() here)
 *   - The headless runner / verifier (headlessRunner.js)
 *
 * Entry point:
 *   const sim = createDungeonSim({ run, player, getElapsedMs? });
 *   // inside game loop:
 *   sim.update(input, dt);
 *   // check settlement:
 *   if (sim.getState().settlementReason) { ... }
 *
 * An input object must implement:
 *   getDirection()       → { x: number, y: number }
 *   wasPressed(action)   → boolean  (edge-triggered)
 *   wasAnyPressed()      → boolean
 *   commitFrame()        → void     (called after all consumption)
 *   isDown?(action)      → boolean  (optional)
 *
 * For the headless / replay path use createDungeonSimHeadless() which also
 * creates the run, player and the STEP_MS clock internally.
 */

import { applyBuildBonusesToPlayer, createPlayer } from "../combat.js";
import { createRunStart } from "./runStart.js";
import {
  buildDungeonRoomMap,
  canMoveCharacterTo,
  canMoveToDungeonRoom,
  getDungeonInteractionNear,
  getDungeonSpawnPosition,
  DUNGEON_ROOM_HEIGHT,
  DUNGEON_ROOM_WIDTH,
  DUNGEON_TILE_SIZE,
} from "../dungeon/roomMap.js";
import { resolveStuckPosition } from "../dungeon/playerSafety.js";
import {
  getEntryPositionAfterExit,
  getExitDirectionForPosition,
  getNeighborRoomId,
  isInsideDoorway,
} from "../dungeon/roomTransitions.js";
import {
  beginUpgradeChoice,
  cancelPendingUpgradeChoice,
  canDescendFromCurrentRoom,
  choosePendingUpgrade,
  createRun,
  descend,
  enterRoom,
  explorationRate,
  isRunOver,
  movePendingUpgradeSelection,
} from "../run/runState.js";
import {
  applyRoomEventBuffsToPlayer,
  createRoomEventRng,
  resolveRoomEvent,
  rollRoomEvent,
} from "../run/roomEvents.js";
import { withDiscoveredStairsForRun } from "../ui/minimapReveal.js";
import { createDungeonCombat } from "../../runtime/scenes/dungeonCombat.js";
import {
  getFacing,
  normalizeHeroClass,
} from "../../runtime/scenes/dungeonScenePlayer.js";

// ---------------------------------------------------------------------------
// Constants (must match dungeonScene.js exactly for determinism)
// ---------------------------------------------------------------------------
export const PLAYER_RADIUS = 5;
/** Pixels below player body-centre (player.y) to the foot-centre used for
 *  tile collision.  Matches dungeonSprites footY = y + TILE_SIZE/2 (8px),
 *  but slightly less so the footprint sits just above the drawn sole. */
export const PLAYER_FOOT_OFFSET = 7;
/** Footprint radius for tile collision (smaller than body radius). */
export const PLAYER_FOOT_RADIUS = 3;
export const PLAYER_SPEED = 74;
export const INTERACTION_RANGE = 24;
export const STEP_MS = 1000 / 60;

/** Sim version string — bump when the state-machine changes in a way that
 *  breaks replay compatibility. */
export const SIM_VERSION = "2";

/** Maximum ticks for a bounty run (20 min × 60 Hz = 72 000).
 *  When reached, settlementReason is set to "timeLimit". */
export const RUN_MAX_TICKS = 72_000;
/** @deprecated use RUN_MAX_TICKS */
export const DAILY_MAX_TICKS = RUN_MAX_TICKS;

// ---------------------------------------------------------------------------
// Score formula — single canonical implementation used by getResult().
// ---------------------------------------------------------------------------
/**
 * Compute the bounty run score.
 *   score = depth * 100000 + bossesDefeated * 25000
 *         + visitedRoomCount * 1000 + timeBonus
 *   timeBonus = max(0, 999 - floor(ticks / 60))
 *
 * One extra room (1000 pts) always outweighs any timeBonus (max 999 pts).
 *
 * @param {object} p
 * @param {number} p.depth
 * @param {number} p.bossesDefeated
 * @param {number} p.visitedRoomCount
 * @param {number} p.ticks
 * @returns {number}
 */
export function computeScore({ depth, bossesDefeated, visitedRoomCount, ticks }) {
  const timeBonus = Math.max(0, 999 - Math.floor(ticks / 60));
  return depth * 100_000 + bossesDefeated * 25_000 + visitedRoomCount * 1_000 + timeBonus;
}

// ---------------------------------------------------------------------------
// Room-event state machine (pure, no DOM)
// ---------------------------------------------------------------------------
function createSimRoomEventFlow() {
  let event = null;
  let selectedIndex = 0;

  return {
    isOpen: () => Boolean(event),
    getEvent: () => event,
    getSelectedIndex: () => selectedIndex,

    open({ run, roomId }) {
      event = rollRoomEvent({ seed: run.seed, depth: run.depth, roomId });
      selectedIndex = 0;
    },

    close() {
      event = null;
      selectedIndex = 0;
    },

    /**
     * Process input for an open room-event panel.
     * Returns { handled, result } where result is the resolveRoomEvent
     * payload when the player confirmed a choice, or null otherwise.
     */
    update(input, { run, player }) {
      if (!event) return { handled: false, result: null };

      if (input.wasPressed("cancel")) {
        this.close();
        return { handled: true, result: null };
      }

      // Selection navigation
      if (input.wasPressed("up")) {
        const len = event.options.length;
        if (len > 0) selectedIndex = (selectedIndex - 1 + len) % len;
        return { handled: true, result: null };
      }
      if (input.wasPressed("down")) {
        const len = event.options.length;
        if (len > 0) selectedIndex = (selectedIndex + 1) % len;
        return { handled: true, result: null };
      }

      if (!input.wasPressed("confirm") && !input.wasPressed("interact")) {
        return { handled: true, result: null };
      }

      // Confirm: resolve the selected option
      const optionId = event.options[selectedIndex]?.id;
      if (!optionId) return { handled: true, result: null };

      const rng = createRoomEventRng({
        seed: run.seed,
        depth: run.depth,
        roomId: event.roomId,
      });
      const result = resolveRoomEvent({ run, player, event, optionId, rng });
      this.close();
      return { handled: true, result };
    },
  };
}

// ---------------------------------------------------------------------------
// Main factory — browser path (run + player supplied externally)
// ---------------------------------------------------------------------------

/**
 * Create the simulation state machine.
 *
 * @param {object} opts
 * @param {object}  opts.run        - initial run (from createRun or live setRun)
 * @param {object}  opts.player     - mutable player object (shared with renderer)
 * @param {function} [opts.onRunUpdate]   - called with (nextRun) after every run mutation
 * @param {function} [opts.onFeedback]    - called with (text) for UI feedback messages
 * @param {function} [opts.getElapsedMs]  - () => number; if not supplied sim tracks its own
 * @param {number}   [opts.maxTicks]      - if set, sim ends with "timeLimit" when tick >= maxTicks
 */
export function createDungeonSim({
  run: initialRun,
  player,
  onRunUpdate = null,
  onFeedback = null,
  getElapsedMs = null,
  maxTicks = null,
}) {
  let run = withDiscoveredStairsForRun(initialRun);
  let roomMap = buildDungeonRoomMap({ run });
  let elapsedMs = 0;
  let nearbyInteraction = null;
  let afterUpgradeChoice = null;
  let tickCount = 0;

  // Settlement state
  let settlementReason = null;

  const roomEventFlow = createSimRoomEventFlow();

  // Combat subsystem is shared with the renderer; it mutates player directly
  const combat = createDungeonCombat({
    player,
    getRun: () => run,
    getRoomMap: () => roomMap,
    updateRun: (nextRun) => _updateRun(nextRun),
  });
  combat.enterCurrentRoom();

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------
  function _currentElapsedMs() {
    return getElapsedMs ? getElapsedMs() : elapsedMs;
  }

  function _updateRun(nextRun, sourcePlayer = player) {
    run = withDiscoveredStairsForRun(nextRun);
    Object.assign(
      player,
      applyRoomEventBuffsToPlayer(
        applyBuildBonusesToPlayer(sourcePlayer, run.build?.bonuses),
        run,
      ),
    );
    roomMap = buildDungeonRoomMap({ run });
    onRunUpdate?.(run);
  }

  function _applyRoomEventResult(result) {
    _updateRun(result.run, result.player);
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------
  function _movePlayer(direction, dt) {
    const speed = PLAYER_SPEED * (player.movementMultiplier ?? 1);
    const nextX = player.x + direction.x * speed * dt;
    const nextY = player.y + direction.y * speed * dt;
    const roomIdBeforeMove = roomMap.id;
    let moved = false;

    if (_tryMoveTo(nextX, player.y)) moved = true;
    if (roomMap.id !== roomIdBeforeMove) return true;
    if (_tryMoveTo(player.x, nextY)) moved = true;
    return moved;
  }

  function _tryMoveTo(nextX, nextY) {
    // Use foot-centre for exit detection too: check at foot y.
    const exitDirection = getExitDirectionForPosition({
      x: nextX,
      y: nextY + PLAYER_FOOT_OFFSET,
      width: DUNGEON_ROOM_WIDTH,
      height: DUNGEON_ROOM_HEIGHT,
      tileSize: DUNGEON_TILE_SIZE,
      margin: PLAYER_FOOT_RADIUS,
    });

    if (exitDirection && _canExitThrough(exitDirection, nextX, nextY)) {
      _transitionToRoom(exitDirection);
      return true;
    }

    if (canMoveCharacterTo(roomMap, nextX, nextY, PLAYER_FOOT_RADIUS, PLAYER_FOOT_OFFSET)) {
      player.x = nextX;
      player.y = nextY;
      return true;
    }
    return false;
  }

  function _canExitThrough(exitDirection, x, y) {
    return (
      !combat.isRoomLocked() &&
      Boolean(roomMap.room.doors[exitDirection]) &&
      isInsideDoorway({
        direction: exitDirection,
        x,
        y: y + PLAYER_FOOT_OFFSET,
        width: DUNGEON_ROOM_WIDTH,
        height: DUNGEON_ROOM_HEIGHT,
        tileSize: DUNGEON_TILE_SIZE,
      })
    );
  }

  function _transitionToRoom(exitDirection) {
    const nextRoomId = getNeighborRoomId(run.floorPlan, roomMap.room, exitDirection);
    if (!nextRoomId) return;

    _updateRun(enterRoom(run, nextRoomId));
    const entry = getEntryPositionAfterExit({
      exitDirection,
      width: DUNGEON_ROOM_WIDTH,
      height: DUNGEON_ROOM_HEIGHT,
      tileSize: DUNGEON_TILE_SIZE,
    });
    player.x = entry.x;
    player.y = entry.y;
    combat.enterCurrentRoom();
    nearbyInteraction = null;
  }

  // -------------------------------------------------------------------------
  // Descend
  // -------------------------------------------------------------------------
  function _descendToNextFloor(sourceRun) {
    _updateRun(descend(sourceRun));
    const nextSpawn = getDungeonSpawnPosition();
    player.x = nextSpawn.x;
    player.y = nextSpawn.y;
    player.facing = { x: 0, y: 1 };
    player.facingName = "down";
    nearbyInteraction = null;
    combat.enterCurrentRoom();
  }

  // -------------------------------------------------------------------------
  // Upgrade choice input (full semantics, mirrors handleUpgradeChoiceInput)
  // -------------------------------------------------------------------------
  function _handleUpgradeChoiceInput(input) {
    const pendingChoice = run.build?.pendingChoice;
    if (!pendingChoice) return;

    if (input.wasPressed("cancel")) {
      _updateRun(cancelPendingUpgradeChoice(run));
      afterUpgradeChoice = null;
      return;
    }

    if (input.wasPressed("left") || input.wasPressed("up")) {
      _updateRun(movePendingUpgradeSelection(run, -1));
      return;
    }
    if (input.wasPressed("right") || input.wasPressed("down")) {
      _updateRun(movePendingUpgradeSelection(run, 1));
      return;
    }

    // Direct choice keys
    let directIndex = null;
    if (input.wasPressed("choice1")) directIndex = 0;
    else if (input.wasPressed("choice2")) directIndex = 1;
    else if (input.wasPressed("choice3")) directIndex = 2;

    const selectedIndex = directIndex ?? pendingChoice.selectedIndex;

    if (directIndex === null && !input.wasPressed("confirm") && !input.wasPressed("interact")) {
      return; // wait for confirmation
    }

    const selected = pendingChoice.choices[selectedIndex];
    if (!selected) return;

    const chosenRun = choosePendingUpgrade(run, selected.id);
    _updateRun(chosenRun);

    if (afterUpgradeChoice === "descend") {
      afterUpgradeChoice = null;
      _descendToNextFloor(chosenRun);
    } else {
      afterUpgradeChoice = null;
    }
  }

  // -------------------------------------------------------------------------
  // Interact
  // -------------------------------------------------------------------------
  function _interactWith(interaction) {
    if (interaction.id === "stairs") {
      if (!canDescendFromCurrentRoom(run)) {
        onFeedback?.("dungeon.prompt.bossLocked");
        return;
      }
      if (roomMap.room.type === "stairs") {
        afterUpgradeChoice = "descend";
        _updateRun(beginUpgradeChoice(run, "minor"));
        return;
      }
      _descendToNextFloor(run);
      return;
    }

    if (interaction.id === "event") {
      if (interaction.used) {
        onFeedback?.(interaction.feedbackKey ?? "");
        return;
      }
      roomEventFlow.open({ run, roomId: roomMap.id });
      return;
    }

    onFeedback?.(interaction.feedbackKey ?? "");
  }

  // -------------------------------------------------------------------------
  // isModalOpen (sim perspective — no rolePanel/settlement tracking here)
  // -------------------------------------------------------------------------
  function _isModalOpen() {
    return Boolean(run.build?.pendingChoice || roomEventFlow.isOpen());
  }

  // -------------------------------------------------------------------------
  // Main update — called once per fixed tick (dt = STEP_MS/1000)
  // -------------------------------------------------------------------------
  function update(input, dt) {
    if (settlementReason) return;
    if (!getElapsedMs) elapsedMs += dt * 1000;

    // Daily time limit
    if (maxTicks !== null && tickCount >= maxTicks) {
      settlementReason = "timeLimit";
      return;
    }
    tickCount += 1;

    if (isRunOver({ player })) {
      settlementReason = "death";
      return;
    }

    // Upgrade choice modal
    if (run.build?.pendingChoice) {
      _handleUpgradeChoiceInput(input);
      _resolveStuck();
      return;
    }

    // Room event modal
    if (roomEventFlow.isOpen()) {
      const { result } = roomEventFlow.update(input, { run, player });
      if (result) _applyRoomEventResult(result);
      _resolveStuck();
      return;
    }

    // Evacuation
    if (input.wasPressed("cancel")) {
      settlementReason = "evacuated";
      return;
    }

    // Hit-stop: skip movement but advance combat
    if (combat.isHitStopped()) {
      combat.update(input, dt, _currentElapsedMs());
      _resolveStuck();
      return;
    }

    // Movement
    const direction = input.getDirection();
    if (direction.x !== 0 || direction.y !== 0) {
      player.facingName = getFacing(direction, player.facingName);
      player.facing = direction;
      player.moving = _movePlayer(direction, dt);
    } else {
      player.moving = false;
    }

    // Combat (actions, enemy AI, pickups, room-clear)
    combat.update(input, dt, _currentElapsedMs());

    // Post-combat death
    if (isRunOver({ player })) {
      settlementReason = "death";
      _resolveStuck();
      return;
    }

    // Interact
    nearbyInteraction = getDungeonInteractionNear(roomMap, player.x, player.y, INTERACTION_RANGE);
    if (nearbyInteraction && input.wasPressed("interact")) {
      _interactWith(nearbyInteraction);
    }

    _resolveStuck();
  }

  function _resolveStuck() {
    Object.assign(player, resolveStuckPosition({
      roomMap,
      x: player.x,
      y: player.y,
      radius: PLAYER_FOOT_RADIUS,
      footOffset: PLAYER_FOOT_OFFSET,
    }));
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------
  function getState() {
    return {
      run,
      player,
      roomMap,
      nearbyInteraction,
      settlementReason,
      tickCount,
      roomEventOpen: roomEventFlow.isOpen(),
      roomEvent: roomEventFlow.getEvent(),
      roomEventSelectedIndex: roomEventFlow.getSelectedIndex(),
      pendingChoice: run.build?.pendingChoice ?? null,
      isModalOpen: _isModalOpen(),
      combat,
    };
  }

  function isOver() {
    return Boolean(settlementReason);
  }

  function getRun() { return run; }
  function getPlayer() { return { ...player }; }
  function getCombat() { return combat; }
  function getRoomMap() { return roomMap; }
  function getNearbyInteraction() { return nearbyInteraction; }

  // Expose for settlement flow in dungeonScene
  function beginSettlement(reason) {
    if (!settlementReason) settlementReason = reason;
  }

  return {
    update,
    getState,
    isOver,
    getRun,
    getPlayer,
    getCombat,
    getRoomMap,
    getNearbyInteraction,
    beginSettlement,
  };
}

// ---------------------------------------------------------------------------
// Headless / replay factory (creates run+player internally, drives via steps)
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string}  opts.seed
 * @param {string}  opts.heroClass
 * @param {string}  [opts.gameVersion]
 * @param {number}  [opts.maxTicks]   - tick limit (use DAILY_MAX_TICKS for daily runs)
 * @param {{ run: object, player: object }} [opts.startState] - override initial state
 *   (from createDailyStart); when supplied, seed/heroClass are ignored for run creation.
 */
export function createDungeonSimHeadless({ seed, heroClass, gameVersion = "0.0.0", maxTicks = null, startState = null }) {
  const classId = normalizeHeroClass(heroClass);

  // Use createRunStart for the canonical fixed baseline (no heroIdentity, no
  // economy effects). If a pre-built startState is passed, use that directly.
  const base = startState ?? createRunStart({ seed, heroClass: classId });
  let run    = base.run;
  const player = { ...base.player };

  let internalElapsedMs = 0;
  let completionMs = null;

  const sim = createDungeonSim({
    run,
    player,
    onRunUpdate: (nextRun) => { run = nextRun; },
    getElapsedMs: () => internalElapsedMs,
    maxTicks,
  });

  function step(input) {
    if (sim.isOver()) {
      if (completionMs === null) completionMs = internalElapsedMs;
      input.commitFrame?.();
      return;
    }

    internalElapsedMs += STEP_MS;
    const dt = STEP_MS / 1000;
    sim.update(input, dt);

    if (sim.isOver() && completionMs === null) {
      completionMs = internalElapsedMs;
    }

    input.commitFrame?.();
  }

  function isOver() { return sim.isOver(); }

  function getResult() {
    const finalRun = sim.getRun();
    const depth = finalRun.depth;
    const bosses = finalRun.stats?.bossesDefeated ?? 0;
    const visitedRoomCount = finalRun.stats?.visitedRoomCount ?? 1;
    const rate = explorationRate(finalRun);
    const ticks = Math.round((completionMs ?? internalElapsedMs) / STEP_MS);

    // Score computed by the single canonical computeScore() defined above.
    const dailyScore = computeScore({ depth, bossesDefeated: bosses, visitedRoomCount, ticks });

    return {
      seed,
      heroClass: classId,
      gameVersion,
      simVersion: SIM_VERSION,
      depthReached: depth,
      bossesDefeated: bosses,
      visitedRoomCount,
      explorationRate: rate,
      completionTimeTicks: ticks,
      settlementReason: sim.getState().settlementReason ?? "running",
      dailyScore,
    };
  }

  function getElapsedMs() { return internalElapsedMs; }

  return { step, isOver, getResult, getElapsedMs, getRun: sim.getRun, getPlayer: sim.getPlayer };
}

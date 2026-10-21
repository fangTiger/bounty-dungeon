import { applyBuildBonusesToPlayer, createPlayer } from "../../core/combat.js";
import { getDungeonSpawnPosition } from "../../core/dungeon/roomMap.js";
import { minimapFadeAlpha } from "../../core/dungeon/playerSafety.js";
import { translate } from "../../core/i18n/index.js";
import { calculateHudLayout } from "../../core/ui/hudLayout.js";
import { withDiscoveredStairsForRun } from "../../core/ui/minimapReveal.js";
import { createDungeonSim, RUN_MAX_TICKS, SIM_VERSION, computeScore, PLAYER_RADIUS } from "../../core/simulation/dungeonSim.js";
import { createReplayRecorder } from "../../core/simulation/inputCapture.js";
import { runBountyReplay } from "../../core/simulation/headlessRunner.js";
import { keccak_256 } from "../../../vendor/noble-hashes/sha3.js";
import { bytesToHex } from "../../../vendor/noble-hashes/utils.js";
import { setImageSmoothing } from "../renderer/pixelSurface.js";
import { createSpriteRenderer } from "../renderer/spriteRenderer.js";
import { createTilemapRenderer } from "../renderer/tilemapRenderer.js";
import { drawCombatBursts, drawDamageNumbers, drawProjectileBodies } from "./dungeonCombatRender.js";
import { drawSkillVfx } from "./dungeonSkillVfxRender.js";
import { createDungeonAtmosphere } from "./dungeonAtmosphere.js";
import { createDungeonInputHint, drawDungeonInputHint } from "./dungeonInputHint.js";
import { createDungeonSpriteFactory } from "./dungeonSprites.js";
import { normalizeHeroClass, resolveDungeonPlayerSpriteVariant } from "./dungeonScenePlayer.js";
import { drawDeathOverlay, drawDungeonHud, drawDungeonPrompt, drawFloorTransition } from "./dungeonUi.js";
import { createCombatJuice } from "./dungeonCombatJuice.js";
import { calculateMinimapRect, drawDungeonMinimap } from "./dungeonMinimapUi.js";
import { drawHudHintBanner, drawHudIconBar, shouldShowHudHintBanner } from "./hudIconBar.js";
import { drawHudInfoBar } from "./hudInfoBar.js";
import { createDungeonSettlementFlow } from "./dungeonSettlementFlow.js";
import { drawSettlementOverlay } from "./dungeonSettlementUi.js";
import { drawBossNameplate, drawUpgradeChoiceOverlay } from "./dungeonUpgradeUi.js";
import { getActiveBoss } from "./dungeonUpgradeFlow.js";
import { drawGamePanel } from "./gamePanelUi.js";
import { closeRolePanel, createRolePanelState, drawRolePanel, openRolePanel, updateRolePanel } from "./rolePanelUi.js";

const FEEDBACK_SECONDS = 2;
const FLOOR_TRANSITION_SECONDS = 0.85;

export function calculateDungeonHudLayout(run) { return calculateHudLayout({ minimap: calculateMinimapRect(run) }); }
export function isDungeonModalOpen({ settlementActive = false, pendingChoice = null, roomEventOpen = false, rolePanelOpen = false } = {}) { return Boolean(settlementActive || pendingChoice || roomEventOpen || rolePanelOpen); }

export function createDungeonScene({ surface, camera, tileset, getRun, setRun, returnToHub, settleRun, getCachedEconomySnapshot, setEquippedSkin, markHudHintSeen, i18n, isBountyRun = false, bountySeed = null }) {
  const t = i18n?.t ?? translate;
  const tilemapRenderer = createTilemapRenderer(tileset);
  const spriteRenderer = createSpriteRenderer();
  const spriteFactory = createDungeonSpriteFactory({ tileset });
  const atmosphere = createDungeonAtmosphere({ width: surface.width, height: surface.height, camera });
  const juice = createCombatJuice();
  const inputHint = createDungeonInputHint({ t });
  const spawn = getDungeonSpawnPosition();

  // Create the player object (shared/mutable — sim mutates it, renderer reads it)
  const initialRun = withDiscoveredStairsForRun(getRun());
  const player = applyHeroIdentitySprite(
    applyBuildBonusesToPlayer(createPlayer({
      classId: normalizeHeroClass(initialRun.heroClass),
      x: spawn.x,
      y: spawn.y,
      radius: PLAYER_RADIUS,
      facing: { x: 0, y: 1 },
      facingName: "down",
      moving: false,
      knockbackX: 0,
      knockbackY: 0,
    }), initialRun.build?.bonuses),
    { profile: getCachedEconomySnapshot?.()?.profile, heroIdentity: initialRun.heroIdentity, classId: normalizeHeroClass(initialRun.heroClass) },
  );

  // Replay recorder — captures every tick snapshot for daily-run verification
  const recorder = createReplayRecorder();

  // Sim state machine — owns all game logic
  const sim = createDungeonSim({
    run: initialRun,
    player,
    onRunUpdate: (nextRun) => {
      setRun(nextRun);
    },
    onFeedback: (key) => { showFeedback(t(key)); },
    maxTicks: isBountyRun ? RUN_MAX_TICKS : null,
  });

  // Bounty-run result package (built once when the run settles)
  let _runPackage = null;

  const settlement = createDungeonSettlementFlow({ settleRun, returnToHub, isBountyRun, t });

  let elapsedMs = 0;
  let minimapAlpha = 1;
  let feedbackText = "";
  let feedbackTimer = 0;
  let floorTransitionTimer = FLOOR_TRANSITION_SECONDS;
  const rolePanel = createRolePanelState();
  let hudHintDismissed = false;

  camera.setPosition(0, 0);

  function isModalOpen() {
    const simState = sim.getState();
    return isDungeonModalOpen({
      settlementActive: settlement.isActive(),
      pendingChoice: simState.pendingChoice,
      roomEventOpen: simState.roomEventOpen,
      rolePanelOpen: rolePanel.open,
    });
  }

  function update(input, dt) {
    elapsedMs += dt * 1000;
    const dtMs = dt * 1000;
    atmosphere.update(sim.getState().roomMap, dtMs);
    juice.update({ ...sim.getState().combat.getSnapshot(), playerHp: player.hp }, dtMs);

    if (settlement.isActive()) {
      settlement.update(input, dt);
      updateTimers(dt);
      return;
    }

    // Check if sim already settled (death/evacuated) — begin settlement flow
    const simState = sim.getState();
    if (simState.settlementReason && !settlement.isActive()) {
      if (isBountyRun && !_runPackage) {
        _runPackage = _buildRunPackage(simState);
      }
      settlement.begin({ run: simState.run, player, reason: simState.settlementReason, summary: _runPackage?.result });
      updateTimers(dt);
      return;
    }

    // Role panel (pure UI, no sim state — do NOT record)
    if (rolePanel.open) {
      updateRolePanel(rolePanel, input, {
        economySnapshot: getCachedEconomySnapshot?.(),
        setEquippedSkin: equipRolePanelSkin,
        runPickups: simState.combat.getSnapshot().pickups,
        t,
      });
      updateTimers(dt);
      return;
    }

    // HUD hint dismissal (pure UI — do NOT record)
    if (!isModalOpen() && !hudHintDismissed && shouldShowHudHintBanner(getCachedEconomySnapshot?.()?.profile, inputHint.getSnapshot(simState.run, simState.roomMap)) && (input.wasPressed("confirm") || input.wasPressed("cancel"))) {
      hudHintDismissed = true;
      void Promise.resolve().then(() => markHudHintSeen?.()).catch(() => undefined);
      updateTimers(dt);
      return;
    }

    // Tab panel open (pure UI — do NOT record)
    if (!simState.isModalOpen && input.wasPressed("tabPanel")) {
      openRolePanel(rolePanel);
      updateTimers(dt);
      return;
    }

    // Capture this tick's input snapshot for replay immediately before sim.update
    recorder.captureFrame({
      heldKeys: input.getHeldKeys ? input.getHeldKeys() : deriveHeldKeys(input.getDirection()),
      wasPressed: captureWasPressedSnapshot(input),
    });

    // Delegate to sim (movement, combat, room events, upgrade choices, interact, descend)
    sim.update(input, dt);

    // If sim just settled, start settlement flow
    const nextSimState = sim.getState();
    if (nextSimState.settlementReason && !settlement.isActive()) {
      if (isBountyRun && !_runPackage) {
        _runPackage = _buildRunPackage(nextSimState);
      }
      settlement.begin({ run: nextSimState.run, player, reason: nextSimState.settlementReason, summary: _runPackage?.result });
    }

    updateTimers(dt);
  }

  function render(context) {
    const simState = sim.getState();
    const run = simState.run;
    const roomMap = simState.roomMap;
    const combatState = simState.combat.getSnapshot();

    camera.setPosition(-combatState.cameraShake.x, -combatState.cameraShake.y);
    setImageSmoothing(context, false);
    context.clearRect(0, 0, surface.width, surface.height);
    context.fillStyle = "#000000";
    context.fillRect(0, 0, surface.width, surface.height);
    tilemapRenderer.drawLayer(context, roomMap.layers.floor, camera);
    tilemapRenderer.drawLayer(context, roomMap.layers.walls, camera, elapsedMs);
    atmosphere.drawTorchSprites(context, tileset, elapsedMs, camera);
    const inputHintSnapshot = inputHint.getSnapshot(run, roomMap);
    drawDungeonInputHint(context, inputHintSnapshot, camera);
    drawCombatBursts(context, combatState.bursts, camera);
    drawSkillVfx(context, combatState.skillEffects, camera);
    drawProjectileBodies(context, combatState.projectiles, camera);
    const sprites = spriteFactory.createSceneSprites({ roomMap, player, elapsedMs, combat: combatState });
    spriteRenderer.drawShadows(context, sprites, camera);
    spriteRenderer.drawSorted(context, sprites, camera, juice.getEnemyFlashAlpha);
    juice.drawParticles(context, camera);
    atmosphere.drawParticles(context, camera);
    atmosphere.applyLighting(context, player, elapsedMs, combatState.dynamicLights);
    atmosphere.applyVignette(context);
    juice.drawPlayerDamageFlash(context, surface.width, surface.height);
    drawDamageNumbers(context, combatState.damageNumbers, camera);
    camera.setPosition(0, 0);
    drawFloorTransition(context, { depth: run.depth, timer: floorTransitionTimer, duration: FLOOR_TRANSITION_SECONDS, t });
    drawBossNameplate(context, getActiveBoss(combatState), tileset);
    const economySnapshot = getCachedEconomySnapshot?.();
    const hudLayout = calculateDungeonHudLayout(run);
    drawDungeonHud(context, run, player, economySnapshot, tileset, elapsedMs, combatState.skillSlots, { combatActive: combatState.enemies.some((enemy) => enemy.hp > 0 && enemy.state !== "dead"), layout: hudLayout, t, bountyLabel: isBountyRun ? "Bounty Run" : null });
    drawDungeonMinimap(context, run, tileset, { alpha: minimapAlpha, t });
    drawHudInfoBar(context, { layout: hudLayout.infoBar, run, economySnapshot, tileset, t });
    drawDungeonPrompt(context, { nearbyInteraction: simState.nearbyInteraction, feedbackText, feedbackTimer }, tileset, { t });
    // Room event panel: build panel data from sim state
    const roomEventPanel = buildRoomEventPanel(simState, run);
    drawGamePanel(context, roomEventPanel, tileset, { t });
    drawRolePanel(context, { run, player, economySnapshot, heroIdentity: run.heroIdentity, skillSlots: combatState.skillSlots, runPickups: combatState.pickups, t }, rolePanel, tileset, { t });
    drawHudHintBanner(context, { layout: hudLayout.hintBanner, visible: !isModalOpen() && !hudHintDismissed && shouldShowHudHintBanner(economySnapshot?.profile, inputHintSnapshot), tileset, t });
    drawHudIconBar(context, { layout: hudLayout.iconBar, rolePanel, t });
    drawUpgradeChoiceOverlay(context, simState.pendingChoice, tileset, { t });
    drawSettlementState(context, settlement.getSnapshot());
  }

  function buildRoomEventPanel(simState, run) {
    if (!simState.roomEventOpen || !simState.roomEvent) return null;
    const event = simState.roomEvent;
    // Minimal panel structure for drawGamePanel
    return {
      title: event.title,
      lines: [{ text: event.description }],
      actions: event.options.map((opt) => ({ id: opt.id, label: opt.label })),
      selectedIndex: simState.roomEventSelectedIndex,
      accent: "#d4af64",
      footerExtra: t("panel.footer.select"),
    };
  }

  function drawSettlementState(context, snapshot) {
    if (snapshot?.reason === "death" && snapshot.status === "settling") {
      drawDeathOverlay(context, snapshot, tileset, { t });
      return;
    }
    drawSettlementOverlay(context, snapshot, tileset, { t });
  }

  function showFeedback(text) { feedbackText = text; feedbackTimer = FEEDBACK_SECONDS; }

  function equipRolePanelSkin(skinId) {
    return Promise.resolve(setEquippedSkin?.(skinId)).then((result) => {
      Object.assign(player, applyHeroIdentitySprite(player, { profile: getCachedEconomySnapshot?.()?.profile, heroIdentity: sim.getRun().heroIdentity, classId: player.classId }));
      return result;
    });
  }

  function updateTimers(dt) {
    const simState = sim.getState();
    const run = simState.run;
    const roomMap = simState.roomMap;
    minimapAlpha = minimapFadeAlpha({ playerX: player.x, playerY: player.y, minimapRect: calculateDungeonHudLayout(run).minimap, currentAlpha: minimapAlpha, previousElapsedMs: elapsedMs - dt * 1000, elapsedMs });
    inputHint.update({ run, roomMap, dt, paused: isModalOpen() });
    if (feedbackTimer > 0) feedbackTimer = Math.max(0, feedbackTimer - dt);
    if (floorTransitionTimer > 0) floorTransitionTimer = Math.max(0, floorTransitionTimer - dt);
  }

  /** Export the compressed replay as a plain number array (JSON-serialisable). */
  function exportReplay() {
    const bytes = recorder.finish();
    return Array.from(bytes);
  }

  // ---------------------------------------------------------------------------
  // Bounty run package helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the v2 run package from a settled simState.
   * Uses computeScore() (the single canonical formula) and runBountyReplay
   * for the self-check.
   */
  function _buildRunPackage(simState) {
    const finalRun = simState.run;
    const ticks    = simState.tickCount ?? 0;
    const settlementReason = simState.settlementReason;
    const depth            = finalRun.depth;
    const bossesDefeated   = finalRun.stats?.bossesDefeated  ?? 0;
    const visitedRoomCount = finalRun.stats?.visitedRoomCount ?? 1;

    // Score from the ONE canonical formula (no copy here)
    const score = computeScore({ depth, bossesDefeated, visitedRoomCount, ticks });

    const replayBytes  = recorder.finish();
    const replayBase64 = _uint8ArrayToBase64(replayBytes);

    // replayHash = keccak256(replay bytes) as 0x hex (for contract attestation)
    const replayHash = "0x" + bytesToHex(keccak_256(replayBytes));

    const liveResult = { score, depth, bossesDefeated, visitedRoomCount, settlementReason };

    // Self-check: replay via runBountyReplay (canonical baseline + RUN_MAX_TICKS)
    let selfCheck = { passed: false, replayResult: null, error: null };
    try {
      const heroClass     = finalRun.heroClass;
      const seed          = bountySeed ?? finalRun.seed;
      const headlessResult = runBountyReplay({ seed, heroClass, gameVersion: "selfcheck", replayBytes });
      const replayResult  = {
        score:             headlessResult.dailyScore,
        depth:             headlessResult.depthReached,
        bossesDefeated:    headlessResult.bossesDefeated,
        visitedRoomCount:  headlessResult.visitedRoomCount,
        settlementReason:  headlessResult.settlementReason,
        simVersion:        headlessResult.simVersion,
      };
      const passed = (
        replayResult.score            === liveResult.score &&
        replayResult.depth            === liveResult.depth &&
        replayResult.bossesDefeated   === liveResult.bossesDefeated &&
        replayResult.visitedRoomCount === liveResult.visitedRoomCount &&
        replayResult.settlementReason === liveResult.settlementReason
      );
      selfCheck = { passed, replayResult, error: null };
    } catch (err) {
      selfCheck.error = String(err?.message ?? err);
    }

    const seedForPkg = bountySeed ?? finalRun.seed;
    const pkg = {
      v: 2,
      simVersion: SIM_VERSION,
      seed: seedForPkg,
      heroClass: finalRun.heroClass,
      ticks,
      replay: replayBase64,
      replayHash,
      result: liveResult,
      selfCheck,
    };

    // Show DOM overlay
    _showRunResultOverlay(pkg, replayBytes);

    // postMessage for iframe embedding
    if (typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({ type: "arc-dungeon:run-result", package: pkg }, "*");
    }

    return pkg;
  }

  /** Return the run package (null if not a bounty run or not yet settled). */
  function getDailyPackage() { return _runPackage; }   // backwards-compat alias
  function getRunPackage()   { return _runPackage; }

  /** Show a small DOM overlay with score, copy, and download buttons. */
  function _showRunResultOverlay(pkg, replayBytes) {
    if (typeof document === "undefined") return;
    document.getElementById("arc-run-result")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "arc-run-result";
    overlay.style.cssText = [
      "position:fixed;bottom:16px;right:16px;z-index:9999",
      "background:#1a1410;border:1px solid #d4af64;border-radius:6px",
      "padding:12px 16px;color:#f7efd0;font-family:monospace;font-size:13px",
      "max-width:300px;box-shadow:0 4px 16px rgba(0,0,0,0.7)",
    ].join(";");

    const checkIcon  = pkg.selfCheck.passed ? "✓" : "✗";
    const checkColor = pkg.selfCheck.passed ? "#6fcf6f" : "#e05f5f";
    const checkText  = pkg.selfCheck.passed ? "Self-check passed" : "Local check failed";
    const shortSeed  = pkg.seed.slice(0, 10) + "…";

    const staleWarning = pkg.simVersion !== SIM_VERSION
      ? `<div style="margin-bottom:6px;color:#e05f5f;font-size:11px">⚠ Package simVersion ${pkg.simVersion} does not match current engine (${SIM_VERSION}) — this replay cannot be submitted.</div>`
      : "";

    overlay.innerHTML = `
      <div style="font-weight:bold;color:#d4af64;margin-bottom:6px">Bounty Run Result</div>
      ${staleWarning}
      <div style="margin-bottom:4px">Score: <strong>${pkg.result.score.toLocaleString()}</strong></div>
      <div style="margin-bottom:4px">Depth ${pkg.result.depth} · ${pkg.result.bossesDefeated} boss · ${pkg.result.visitedRoomCount} rooms</div>
      <div style="margin-bottom:4px;font-size:11px;color:#999">Seed: ${shortSeed}</div>
      <div style="margin-bottom:8px;color:${checkColor}">${checkIcon} ${checkText}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="arc-run-copy"     style="background:#2a2010;border:1px solid #d4af64;color:#f7efd0;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">Copy replay</button>
        <button id="arc-run-download" style="background:#2a2010;border:1px solid #d4af64;color:#f7efd0;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">Download</button>
        <button id="arc-run-close"    style="background:transparent;border:none;color:#888;padding:4px 8px;cursor:pointer;font-size:16px" title="Close">×</button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("arc-run-copy")?.addEventListener("click", () => {
      navigator.clipboard?.writeText(JSON.stringify(pkg, null, 2)).catch(() => {});
    });

    document.getElementById("arc-run-download")?.addEventListener("click", () => {
      const shortId = (bountySeed ?? pkg.seed).replace(/^0x/, "").slice(0, 8);
      const blob    = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
      const url     = URL.createObjectURL(blob);
      const a       = document.createElement("a");
      a.href        = url;
      a.download    = `arc-dungeon-${shortId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("arc-run-close")?.addEventListener("click", () => { overlay.remove(); });
  }

  /** Base64-encode a Uint8Array (no btoa dependency on large arrays). */
  function _uint8ArrayToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  }

  /** Snapshot for tests / rialoDebug: position, HP, build, current run. */
  function getSimSnapshot() {
    return {
      x:    player.x,
      y:    player.y,
      hp:   player.hp,
      build: sim.getRun().build,
      run:  sim.getRun(),
    };
  }

  return {
    update,
    render,
    exportReplay,
    getSimSnapshot,
    getDailyPackage,   // backwards-compat
    getRunPackage,
    debugKillPlayer: () => { player.hp = 0; },
    /**
     * Teleport the player to the named interaction and trigger it immediately.
     * Used from rialoDebug.interact(id).
     */
    debugInteract: (id) => {
      const simState = sim.getState();
      const found = simState.roomMap.interactions.find((i) => i.id === id);
      if (!found) return;
      player.x = found.interactX;
      player.y = found.interactY;
      // Fake an interact press for one tick
      const fakeInput = {
        getDirection:     () => ({ x: 0, y: 0 }),
        getHeldKeys:      () => ({ left: false, right: false, up: false, down: false }),
        wasPressed:       (a) => a === "interact",
        wasAnyPressed:    () => true,
        commitFrame:      () => {},
        consumeTextInput: () => [],
        isDown:           () => false,
      };
      sim.update(fakeInput, 1 / 60);
    },
    /**
     * Move the player to within interaction range of the named interaction
     * without triggering it.
     */
    debugMoveToInteraction: (id) => {
      const simState = sim.getState();
      const found = simState.roomMap.interactions.find((i) => i.id === id);
      if (!found) return;
      player.x = found.interactX;
      player.y = found.interactY;
    },
  };
}

// All actions the sim can read — must match REPLAY_ACTIONS_BYTE1/2/3 in inputCapture.js
const ALL_SIM_ACTIONS = [
  "attack", "dodge", "interact", "cancel",
  "skill1", "skill2", "skill3", "skill4",
  "choice1", "choice2", "choice3", "tabPanel",
  "confirm", "up", "down", "left", "right",
];

/**
 * Capture the wasPressed snapshot for the current tick (before commitFrame).
 * Must be called BEFORE input.commitFrame() is called.
 */
function captureWasPressedSnapshot(input) {
  const pressed = {};
  for (const action of ALL_SIM_ACTIONS) {
    if (input.wasPressed(action)) pressed[action] = true;
  }
  return pressed;
}

/** Fallback: derive held keys from a direction vector when getHeldKeys is absent. */
function deriveHeldKeys(dir) {
  return {
    left:  (dir?.x ?? 0) < -0.1,
    right: (dir?.x ?? 0) >  0.1,
    up:    (dir?.y ?? 0) < -0.1,
    down:  (dir?.y ?? 0) >  0.1,
  };
}

function applyHeroIdentitySprite(player, options = {}) { return { ...player, spritePrefix: resolveDungeonPlayerSpriteVariant({ ...options, classId: options.classId ?? player.classId }) }; }

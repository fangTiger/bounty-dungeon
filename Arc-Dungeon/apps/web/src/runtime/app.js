import { applyUpgradeChoice } from "../core/run/upgrades.js";
import { beginUpgradeChoice, createRun, descend, enterRoom } from "../core/run/runState.js";
import { createRunStart } from "../core/simulation/runStart.js";
import {
  createBrowserI18n,
  createDebugEconomyOptions,
  normalizeUpgradeIds,
  readPositiveIntegerOption,
} from "./appOptions.js";
import { readBrowserOption } from "./browserOptions.js";
import { createInput } from "./input.js";
import { createLoop } from "./loop.js";
import { createEconomySession } from "./economySession.js";
import { createGuestRuntimeIdentity, initializeRuntimeIdentity } from "./discord/identityBootstrap.js";
import { isDiscordActivityEnvironment } from "./discord/activityClient.js";
import { synchronizePlayerSaveForIdentity } from "./discord/playerSaveBootstrap.js";
import { createDiscordLoginSession } from "./discord/webOAuthClient.js";
import { createCamera } from "./renderer/camera.js";
import { loadDungeonAtlas } from "./renderer/dungeonAtlas.js";
import { createPixelSurface } from "./renderer/pixelSurface.js";
import { createClassSelectionScene } from "./scenes/classSelectionScene.js";
import { createDungeonScene } from "./scenes/dungeonScene.js";
import { createEntryScene } from "./scenes/entryScene.js";
import { createHubIdentityFlow } from "./scenes/hubIdentityFlow.js";
import { createHubScene } from "./scenes/hubScene.js";
import { selectedHeroClass } from "./scenes/hubSceneHelpers.js";
import { loadPixelFonts, setPixelFont } from "./ui/pixelFont.js";

const SCENE_FACTORIES = {
  entry: createEntryScene,
  classSelection: createClassSelectionScene,
  hub: createHubScene,
  dungeon: createDungeonScene,
};
export async function createApp(canvas) {
  const discordLogin = await createDiscordLoginSession();
  const surface = createPixelSurface(canvas);
  const camera = createCamera();
  await loadPixelFonts();
  const tileset = await loadDungeonAtlas();
  const input = createInput(canvas);
  const i18n = createBrowserI18n();
  const economy = createEconomySession(createDebugEconomyOptions());
  let sceneId = "entry";
  let run = null;
  let runCounter = 0;
  // Bounty-run state — MUST be declared before the first createScene call (TDZ).
  let _bountyMeta = null;  // { seed, heroClass }
  let _lastRunPackage = null; // persists across hub return so rialoDebug.getRunPackage() still works
  await economy.readSnapshot();
  let runtimeIdentity = createGuestRuntimeIdentity();
  if (discordLogin.callbackHandled) {
    runtimeIdentity = discordLogin.callbackRuntimeIdentity;
    await synchronizePlayerSaveForIdentity({ economy, runtimeIdentity });
    sceneId = "classSelection";
  }
  const identityFlow = createHubIdentityFlow({
    getCachedEconomySnapshot: economy.getSnapshot,
    heroIdentity: runtimeIdentity.heroIdentity,
    initialClassId: selectedHeroClass(),
    measureChar: (char) => {
      setPixelFont(surface.context, 10);
      return surface.context.measureText(char).width;
    },
    t: i18n.t,
  });
  let scene = createScene(sceneId);
  const debugEnabled =
    readBrowserOption("rialoDebug") === "1" || readBrowserOption("rialoAutoDungeon") === "1";

  if (readBrowserOption("rialoAutoDungeon") === "1") {
    await enterDungeon({
      heroClass: readBrowserOption("rialoHeroClass") ?? "knight",
      heroIdentity: runtimeIdentity.heroIdentity,
    });
  }

  // ?seed=0x<64 hex> auto-starts a bounty run on that specific seed.
  // Only accepted when the value is exactly 0x + 64 lowercase hex chars.
  const _qsSeed = new URLSearchParams(window.location.search).get("seed");
  if (_qsSeed && /^0x[0-9a-fA-F]{64}$/.test(_qsSeed)) {
    await enterBountyRun({ heroClass: selectedHeroClass() ?? "knight", seed: _qsSeed.toLowerCase() });
  }

  const loop = createLoop({
    update(dt) {
      scene.update(input, dt);
      input.commitFrame();
    },
    render() {
      scene.render(surface.context);
      surface.present();
    },
  });

  if (debugEnabled) {
    exposeDebugState();
  }

  function start() {
    canvas.setAttribute("tabindex", "0");
    canvas.addEventListener("pointerdown", () => canvas.focus());
    window.addEventListener("resize", surface.resize);
    surface.resize();
    loop.start();
  }

  function setScene(nextSceneId) {
    if (!SCENE_FACTORIES[nextSceneId]) {
      throw new Error(`未知场景: ${nextSceneId}`);
    }

    if (nextSceneId === "dungeon" && !run) {
      throw new Error("进入地牢前必须先创建 run");
    }

    sceneId = nextSceneId;
    scene = createScene(sceneId);
  }

  async function authorizeDiscordLogin() {
    if (discordLogin.activityAvailable) {
      const nextIdentity = await initializeRuntimeIdentity();
      return applyAuthorizedIdentity(nextIdentity);
    }
    const nextIdentity = await discordLogin.authorize();
    if (nextIdentity?.redirecting) return nextIdentity;
    return applyAuthorizedIdentity(nextIdentity);
  }

  async function applyAuthorizedIdentity(nextIdentity) {
    runtimeIdentity = nextIdentity;
    identityFlow.setHeroIdentity(nextIdentity.heroIdentity, nextIdentity.personaPreview?.source);
    await synchronizePlayerSaveForIdentity({ economy, runtimeIdentity: nextIdentity, saveLocalIdentity: () => economy.saveProfileIdentity(nextIdentity.heroIdentity) });
    return nextIdentity;
  }

  async function enterDungeon({
    heroClass = "knight",
    heroIdentity = null,
    seed = null,
    startDepth = null,
    startRoomType = null,
    buildUpgradeIds = null,
    pendingUpgrade = null,
    ticketCount = 1,
  } = {}) {
    const runSeed = seed ?? createRunSeed();
    const result = await economy.startRun({
      runId: `run:${runSeed}`,
      ticketCount,
      createRun: () => createConfiguredRun({
        seed: runSeed,
        heroClass,
        heroIdentity,
        startDepth,
        startRoomType,
        buildUpgradeIds,
        pendingUpgrade,
      }),
    });

    if (result.ok) {
      run = result.run;
      setScene("dungeon");
    }

    return result;
  }

  // (Bounty-run state declared above, before the first createScene call.)

  /**
   * Generate a random 32-byte bounty seed (0x + 64 hex chars).
   * Uses crypto.getRandomValues — UI layer only, never inside core/simulation.
   */
  function _randomBouncySeed() {
    const bytes = new Uint8Array(32);
    (typeof crypto !== "undefined" ? crypto : globalThis.crypto).getRandomValues(bytes);
    return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Validate that a seed string is 0x + exactly 64 lowercase hex chars. */
  function _isValidSeed(s) {
    return typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);
  }

  /**
   * Start a bounty run with the fixed baseline (no economy.startRun).
   * seed defaults to a fresh random seed; can be overridden for challenge runs.
   */
  async function enterBountyRun({ heroClass = selectedHeroClass() ?? "knight", seed = null } = {}) {
    const resolvedSeed = (seed && _isValidSeed(seed)) ? seed : _randomBouncySeed();
    const { run: bountyRun } = createRunStart({ seed: resolvedSeed, heroClass });
    run = bountyRun;
    _bountyMeta = { seed: resolvedSeed, heroClass };
    setScene("dungeon");
    return { ok: true, run, seed: resolvedSeed };
  }

  function returnToHub() {
    // Grab the run package before the scene is destroyed (scene.getRunPackage returns
    // null after setScene replaces the scene object).
    const pkg = scene.getRunPackage?.() ?? null;
    if (pkg) _lastRunPackage = pkg;
    run = null;
    _bountyMeta = null;
    void economy.readSnapshot();
    setScene("hub");
  }

  function createScene(nextSceneId) {
    return SCENE_FACTORIES[nextSceneId]({
      surface,
      camera,
      tileset,
      isBountyRun: Boolean(_bountyMeta),
      bountySeed: _bountyMeta?.seed ?? null,
      activityAvailable: isDiscordActivityEnvironment(),
      webOAuthAvailable: discordLogin.webOAuthAvailable,
      authorizeDiscord: authorizeDiscordLogin,
      onIdentityResolved: (nextIdentity) => {
        if (nextIdentity) {
          runtimeIdentity = nextIdentity;
        }
      },
      enterClassSelection: () => setScene("classSelection"),
      enterHub: () => setScene("hub"),
      enterDungeon,
      returnToHub,
      getEconomySnapshot: economy.readSnapshot,
      getCachedEconomySnapshot: economy.getSnapshot,
      craftSkin: economy.craftSkin,
      exchangeSkinBox: economy.exchangeSkinBox,
      openSkinBox: economy.openSkinBox,
      claimDailyTickets: economy.claimDailyTickets,
      buyTickets: economy.buyTickets,
      saveProfileIdentity: economy.saveProfileIdentity,
      setEquippedSkin: economy.setEquippedSkin,
      heroIdentity: runtimeIdentity.heroIdentity,
      personaPreview: runtimeIdentity.personaPreview,
      sharedIdentityFlow: identityFlow,
      identityFlow,
      i18n,
      markHudHintSeen: economy.markHudHintSeen,
      settleRun: economy.settleRun,
      getRun: () => run,
      setRun: (nextRun) => {
        run = nextRun;
      },
    });
  }

  function createRunSeed() {
    runCounter += 1;
    const fixedSeed = readBrowserOption("rialoRunSeed");
    if (fixedSeed) {
      return `${fixedSeed}-${runCounter.toString(36)}`;
    }

    return `run-${Date.now().toString(36)}-${runCounter.toString(36)}`;
  }

  function createConfiguredRun({
    seed,
    heroClass,
    heroIdentity,
    startDepth = null,
    startRoomType = null,
    buildUpgradeIds = null,
    pendingUpgrade = null,
  }) {
    let configuredRun = createRun({ seed, heroClass, heroIdentity });
    const configuredStartDepth = startDepth ?? readPositiveIntegerOption("rialoStartDepth", 1);

    while (configuredRun.depth < configuredStartDepth) {
      configuredRun = descend(configuredRun);
    }

    configuredRun = enterConfiguredRoom(configuredRun, startRoomType);
    configuredRun = applyConfiguredBuild(configuredRun, buildUpgradeIds);

    const pendingTrigger = pendingUpgrade ?? readBrowserOption("rialoPendingUpgrade");
    if (pendingTrigger === "minor" || pendingTrigger === "major") {
      configuredRun = beginUpgradeChoice(configuredRun, pendingTrigger);
    }

    return configuredRun;
  }

  function enterConfiguredRoom(configuredRun, startRoomType) {
    const roomType = startRoomType ?? readBrowserOption("rialoStartRoomType");

    if (!roomType) {
      return configuredRun;
    }

    const room = configuredRun.floorPlan.rooms.find((candidate) => candidate.type === roomType);
    return room ? enterRoom(configuredRun, room.id) : configuredRun;
  }

  function applyConfiguredBuild(configuredRun, buildUpgradeIds) {
    const rawUpgradeIds = buildUpgradeIds ?? readBrowserOption("rialoBuildUpgrades");
    if (!rawUpgradeIds || rawUpgradeIds.length === 0) {
      return configuredRun;
    }

    return normalizeUpgradeIds(rawUpgradeIds)
      .map((id) => id.trim())
      .filter(Boolean)
      .reduce((currentRun, upgradeId) => applyUpgradeChoice(currentRun, upgradeId), configuredRun);
  }

  function exposeDebugState() {
    globalThis.rialoDebug = {
      getSceneId: () => sceneId,
      getRun: () => run,
      getEconomySnapshot: economy.readSnapshot,
      getCachedEconomySnapshot: economy.getSnapshot,
      startDungeon: (options = {}) => enterDungeon(options),
      settleRun: () => economy.settleRun(run),
      craftSkin: () => economy.craftSkin(),
      exchangeSkinBox: () => economy.exchangeSkinBox(),
      openSkinBox: () => economy.openSkinBox(),
      setEquippedSkin: (skinId) => economy.setEquippedSkin(skinId),
      markHudHintSeen: () => economy.markHudHintSeen(),
      claimDailyTickets: () => economy.claimDailyTickets(),
      buyTickets: (count = 1) => economy.buyTickets(count),
      killPlayer: () => scene.debugKillPlayer?.(),
      interact: (id) => scene.debugInteract?.(id),
      moveToInteraction: (id) => scene.debugMoveToInteraction?.(id),
      exportReplay: () => scene.exportReplay?.() ?? [],
      getSimSnapshot: () => scene.getSimSnapshot?.() ?? null,
      startBountyRun:  ({ heroClass, seed } = {}) => enterBountyRun({ heroClass: heroClass ?? selectedHeroClass() ?? "knight", seed }),
      getDailyPackage: () => scene.getRunPackage?.() ?? _lastRunPackage ?? null,  // backwards-compat
      getRunPackage:   () => scene.getRunPackage?.() ?? _lastRunPackage ?? null,
      forceRender: () => {
        scene.render(surface.context);
        surface.present();
      },
      startLoop: () => loop.start(),
      stopLoop: () => loop.stop(),
    };
  }

  // Expose a minimal non-debug API so the toolbar button and panel.js can
  // call enterBountyRun without requiring ?rialoDebug=1.
  globalThis.__arcApp = { enterBountyRun };

  // Listen for { type: "arc-dungeon:start", seed } from the parent frame.
  // The seed must be 0x + 64 lowercase hex chars, or null (generates a fresh seed).
  // Messages are only accepted from window.parent.
  if (typeof window !== "undefined" && window.parent !== window) {
    window.addEventListener("message", (evt) => {
      if (evt.source !== window.parent) return;
      const msg = evt.data;
      if (!msg || msg.type !== "arc-dungeon:start") return;
      const rawSeed = msg.seed ?? null;
      // If a seed is present it must be exactly 0x + 64 lowercase hex chars.
      // A non-null invalid seed is silently ignored (never falls back to random,
      // which would produce a run that cannot claim the bounty).
      if (rawSeed !== null && !/^0x[0-9a-f]{64}$/.test(rawSeed)) return;
      const seed = rawSeed; // null → fresh random seed; valid hex → challenge seed
      void enterBountyRun({ seed });
    });
  }

  return {
    start,
    setScene,
    get sceneId() {
      return sceneId;
    },
  };
}

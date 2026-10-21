import {
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  TILE_SIZE,
} from "../renderer/pixelSurface.js";
import { createLightingLayer } from "../renderer/lighting.js";
import { drawVignette } from "../renderer/postfx.js";
import {
  buildTorchLights,
  computeTorchPositions,
  createTorchEmbers,
  drawTorches,
} from "./dungeonTorches.js";

export const DUNGEON_LIGHTING = Object.freeze({
  ambientColor: "#6e5e78",
  room: Object.freeze({
    x: INTERNAL_WIDTH / 2,
    y: 6 * TILE_SIZE,
    radius: 188,
    color: "#c28f62",
    intensity: 0.55,
  }),
  player: Object.freeze({
    radius: 52,
    color: "#ffd08a",
    intensity: 0.98,
    radiusPulse: 3,
    intensityPulse: 0.03,
  }),
  vignetteIntensity: 0.2,
});

export function createDungeonAtmosphere({ width = INTERNAL_WIDTH, height = INTERNAL_HEIGHT, camera } = {}) {
  let lightingLayer = null;
  let lightingUnavailable = false;

  // Torch state — reset when the room changes
  let torches = [];
  let lastRoomId = null;
  const embers = createTorchEmbers();

  function update(roomMap, dtMs) {
    if (!roomMap) return;
    // Recompute torch positions when the room changes
    if (roomMap.id !== lastRoomId) {
      lastRoomId = roomMap.id;
      torches = computeTorchPositions(roomMap);
      embers.reset(lastRoomId ? hashStr(lastRoomId) : 0);
    }
    embers.update(torches, dtMs ?? 16);
  }

  function drawParticles(context, camera) {
    if (context && camera) {
      embers.draw(context, camera);
    }
  }

  function applyLighting(context, player, elapsedMs, dynamicLights = []) {
    if (typeof context.createRadialGradient !== "function") {
      return;
    }

    const lighting = getLightingLayer();

    if (!lighting) {
      return;
    }

    const seconds = elapsedMs / 1000;
    const playerPulse = softFlicker(seconds, 1.1, 2.3, 3.7);

    lighting.begin(DUNGEON_LIGHTING.ambientColor);
    lighting.addLight(DUNGEON_LIGHTING.room);
    lighting.addLight({
      x: player.x,
      y: player.y - 7,
      radius: DUNGEON_LIGHTING.player.radius +
        playerPulse * DUNGEON_LIGHTING.player.radiusPulse,
      color: DUNGEON_LIGHTING.player.color,
      intensity: DUNGEON_LIGHTING.player.intensity +
        playerPulse * DUNGEON_LIGHTING.player.intensityPulse,
    });

    // Torch lights
    for (const torchLight of buildTorchLights(torches, elapsedMs)) {
      lighting.addLight(torchLight);
    }

    for (const light of dynamicLights) {
      lighting.addLight(light);
    }

    lighting.composite(context);
  }

  function drawTorchSprites(context, tileset, elapsedMs, cameraArg) {
    drawTorches(context, torches, tileset, elapsedMs, cameraArg ?? camera);
  }

  function applyVignette(context) {
    if (typeof context.createRadialGradient !== "function") {
      return;
    }

    drawVignette(context, {
      width,
      height,
      intensity: DUNGEON_LIGHTING.vignetteIntensity,
    });
  }

  function getLightingLayer() {
    if (lightingLayer || lightingUnavailable) {
      return lightingLayer;
    }

    try {
      lightingLayer = createLightingLayer({ width, height, camera });
    } catch {
      lightingUnavailable = true;
    }

    return lightingLayer;
  }

  return {
    update,
    drawParticles,
    applyLighting,
    applyVignette,
    drawTorchSprites,
  };
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h, 33) ^ str.charCodeAt(i);
  }
  return h >>> 0;
}

function softFlicker(seconds, firstFrequency, secondFrequency, thirdFrequency) {
  const first = Math.sin(seconds * firstFrequency);
  const second = Math.sin(seconds * secondFrequency + 1.4) * 0.5;
  const third = Math.sin(seconds * thirdFrequency + 0.2) * 0.24;

  return (first + second + third) / 1.74;
}

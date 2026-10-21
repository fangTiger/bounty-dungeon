/**
 * Cross-engine determinism test (Playwright).
 *
 * Runs headlessRunner inside Chromium, WebKit, and Firefox and asserts that
 * the final dailyScore and settlementReason equal the Node baseline for each
 * of the five scripted replays from sim-replay.test.js.
 *
 * Prerequisites:
 *   npx playwright install chromium webkit firefox
 *
 * Run:
 *   npx playwright test test/sim-cross-engine.spec.js
 */

// @ts-check
import { test, expect, chromium, webkit, firefox } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(__dirname, "../apps/web/src");

// ---------------------------------------------------------------------------
// Generate Node baseline results for the scripted replays
// ---------------------------------------------------------------------------

const { recordRun, runReplay } = await import(`${ROOT}/core/simulation/headlessRunner.js`);

const TEST_CASES = [
  { seed: "abc123",          heroClass: "knight",  maxTicks: 3600 },
  { seed: "deadbeef",        heroClass: "wizzard", maxTicks: 3600 },
  { seed: "dungeon-seed-1",  heroClass: "knight",  maxTicks: 3600 },
  { seed: "replay-test-42",  heroClass: "wizzard", maxTicks: 3600 },
  { seed: "arc-bounty-2025", heroClass: "knight",  maxTicks: 3600 },
];

// Simple walk script (same as sim-replay.test.js)
const WALK_SCRIPT = [
  { ticks: 5,   direction: { x: 0, y: 0 } },
  { ticks: 600, direction: { x: 1, y: 0 } },
  { ticks: 300, direction: { x: 0, y: -1 } },
  { ticks: 300, direction: { x: -1, y: 0 } },
  { ticks: 300, direction: { x: 0, y: 1 } },
  { ticks: 300, direction: { x: 1, y: 1 } },
  { ticks: 300, direction: { x: 0, y: 0 } },
  { ticks: 1000, direction: { x: -1, y: 0 } },
  { ticks: 495, direction: { x: 0, y: 0 } },
];

const baselines = TEST_CASES.map(({ seed, heroClass, maxTicks }) => {
  const { result, replayBytes } = recordRun({ seed, heroClass, script: WALK_SCRIPT, maxTicks });
  return {
    seed, heroClass,
    nodeResult: result,
    // Encode replayBytes as base64 for transport to the browser context
    replayBase64: Buffer.from(replayBytes).toString("base64"),
    maxTicks,
  };
});

// ---------------------------------------------------------------------------
// Browser-side script that runs headlessRunner via an ES module import
// ---------------------------------------------------------------------------

/**
 * Build an inline script the browser page can eval.
 * We use a dynamic ESM import from the game's static server (port 5174).
 * The game server must be running: python3 -m http.server 5174 --bind 127.0.0.1
 * inside apps/web/.
 */
function makeBrowserScript({ replayBase64, seed, heroClass, maxTicks }) {
  return `
    async function run() {
      // Import headlessRunner from the static game server
      const { runReplay } = await import("http://localhost:5174/src/core/simulation/headlessRunner.js");

      // Decode the base64 replay
      const binaryStr = atob(${JSON.stringify(replayBase64)});
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const result = runReplay({
        seed: ${JSON.stringify(seed)},
        heroClass: ${JSON.stringify(heroClass)},
        replayBytes: bytes,
        maxTicks: ${maxTicks},
      });

      return JSON.stringify(result);
    }
    run();
  `;
}

// ---------------------------------------------------------------------------
// Playwright tests
// ---------------------------------------------------------------------------

const BROWSER_LAUNCHERS = [
  { name: "chromium", launcher: chromium },
  { name: "webkit",   launcher: webkit },
  { name: "firefox",  launcher: firefox },
];

for (const { name: browserName, launcher } of BROWSER_LAUNCHERS) {
  for (const baseline of baselines) {
    test(`${browserName}: seed="${baseline.seed}" class="${baseline.heroClass}" matches Node`, async () => {
      const browser = await launcher.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      // Navigate to the game server so ESM imports resolve correctly
      await page.goto("http://localhost:5174/");

      const resultJson = await page.evaluate(
        makeBrowserScript({
          replayBase64: baseline.replayBase64,
          seed: baseline.seed,
          heroClass: baseline.heroClass,
          maxTicks: baseline.maxTicks,
        }),
      );

      await browser.close();

      const browserResult = JSON.parse(resultJson);
      const nodeResult = baseline.nodeResult;

      expect(browserResult.dailyScore, `${browserName} dailyScore`)
        .toBe(nodeResult.dailyScore);
      expect(browserResult.settlementReason, `${browserName} settlementReason`)
        .toBe(nodeResult.settlementReason);
      expect(browserResult.completionTimeTicks, `${browserName} completionTimeTicks`)
        .toBe(nodeResult.completionTimeTicks);
    });
  }
}

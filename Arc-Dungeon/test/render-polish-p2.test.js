/**
 * test/render-polish-p2.test.js
 * Tests for polish-round changes:
 *   1. entrySceneUi — row list in Discord-disabled vs Discord-enabled states
 *   2. pixelSurface.computeScale — integer/fractional scale math
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "apps", "web", "src");

// ---------------------------------------------------------------------------
// 1. entrySceneUi — row list
// ---------------------------------------------------------------------------

describe("entrySceneUi — visible option rows by Discord state", () => {
  let drawEntryScene;

  before(async () => {
    ({ drawEntryScene } = await import(`${ROOT}/runtime/scenes/entrySceneUi.js`));
  });

  function makeCtx() {
    return {
      save() {}, restore() {},
      fillStyle: "",
      fillRect() {},
      fillText() {},
      strokeText() {},
      measureText() { return { width: 40 }; },
      drawImage() {},
      setTransform() {},
      imageSmoothingEnabled: false,
      mozImageSmoothingEnabled: false,
      webkitImageSmoothingEnabled: false,
      msImageSmoothingEnabled: false,
    };
  }

  function makeT(key) {
    // Return key as-is so assertions can inspect the key.
    return key;
  }

  const TILESET = { frames: {}, image: null };

  it("shows only 1 option row when Discord is disabled", () => {
    const options = [
      { id: "discord", label: "Discord", disabled: true, disabledReason: "no client id" },
      { id: "guest",   label: "Guest",   disabled: false },
    ];
    const result = drawEntryScene(makeCtx(), {
      width: 320, height: 180,
      tileset: TILESET,
      options,
      selectedIndex: 1,
      statusText: "",
      authorizing: false,
      elapsedMs: 0,
      t: makeT,
    });
    assert.equal(result.optionRects.length, 1,
      "only guest row should be rendered when Discord is disabled");
  });

  it("the single guest option is shifted down when Discord is hidden", () => {
    const options = [
      { id: "discord", label: "Discord", disabled: true, disabledReason: "no client id" },
      { id: "guest",   label: "Guest",   disabled: false },
    ];
    const result = drawEntryScene(makeCtx(), {
      width: 320, height: 180,
      tileset: TILESET,
      options,
      selectedIndex: 1,
      statusText: "",
      authorizing: false,
      elapsedMs: 0,
      t: makeT,
    });
    // With Discord hidden, guest rect y must be > 114 (the base OPTION_RECTS[0].y)
    const rect = result.optionRects[0];
    assert.ok(rect.y > 114,
      `guest option y (${rect.y}) should be > 114 (re-centred offset)`);
  });

  it("shows 2 option rows when Discord is available", () => {
    const options = [
      { id: "discord", label: "Discord", disabled: false },
      { id: "guest",   label: "Guest",   disabled: false },
    ];
    const result = drawEntryScene(makeCtx(), {
      width: 320, height: 180,
      tileset: TILESET,
      options,
      selectedIndex: 0,
      statusText: "",
      authorizing: false,
      elapsedMs: 0,
      t: makeT,
    });
    assert.equal(result.optionRects.length, 2,
      "both rows should be rendered when Discord is available");
  });

  it("Discord row y is unchanged (not shifted) when both rows show", () => {
    const options = [
      { id: "discord", label: "Discord", disabled: false },
      { id: "guest",   label: "Guest",   disabled: false },
    ];
    const result = drawEntryScene(makeCtx(), {
      width: 320, height: 180,
      tileset: TILESET,
      options,
      selectedIndex: 0,
      statusText: "",
      authorizing: false,
      elapsedMs: 0,
      t: makeT,
    });
    assert.equal(result.optionRects[0].y, 114,
      "Discord row y should be 114 (base OPTION_RECTS[0].y) when not hidden");
  });
});

// ---------------------------------------------------------------------------
// 2. pixelSurface.computeScale
// ---------------------------------------------------------------------------

describe("pixelSurface.computeScale — scale math", () => {
  let computeScale;

  before(async () => {
    ({ computeScale } = await import(`${ROOT}/runtime/renderer/pixelSurface.js`));
  });

  it("390×664 → scale 1 (fitScale=1.21875, below 1.25 threshold)", () => {
    // fitScale = min(390/320, 664/180) = min(1.21875, 3.688) = 1.21875  < 1.25
    const s = computeScale(390, 664);
    assert.equal(s, 1);
  });

  it("390×180 → scale 1 (exactly fits at 1×)", () => {
    assert.equal(computeScale(390, 180), 1);
  });

  it("414×896 → fractional (fitScale=1.29375 ≥ 1.25)", () => {
    // fitScale = min(414/320, 896/180) = min(1.29375, 4.977) = 1.29375 ≥ 1.25
    // expected: floor(1.29375 * 100) / 100 = 1.29
    const s = computeScale(414, 896);
    assert.equal(s, 1.29, `expected 1.29, got ${s}`);
  });

  it("400×225 → fractional exactly at 1.25 (floor→1.25)", () => {
    // fitScale = min(400/320, 225/180) = min(1.25, 1.25) = 1.25 ≥ 1.25
    // intScale = floor(1.25) = 1 (< 2) → fractional path
    // floor(1.25 * 100)/100 = 1.25
    const s = computeScale(400, 225);
    assert.equal(s, 1.25);
  });

  it("1120×900 → scale 3", () => {
    // fitScale = min(1120/320, 900/180) = min(3.5, 5) = 3.5 → intScale=3 ≥ 2
    assert.equal(computeScale(1120, 900), 3);
  });

  it("1600×1080 → scale 5", () => {
    // fitScale = min(1600/320, 1080/180) = min(5, 6) = 5 → intScale=5 ≥ 2
    assert.equal(computeScale(1600, 1080), 5);
  });

  it("320×180 → scale 1 (exact internal size)", () => {
    assert.equal(computeScale(320, 180), 1);
  });

  it("319×180 → scale 1 (just under 1×)", () => {
    assert.equal(computeScale(319, 180), 1);
  });
});

// ---------------------------------------------------------------------------
// 3. createPixelSurface — startup at every container size
//    These fail on the old code (TDZ ReferenceError on the first resize() call
//    when MIN_FRACTIONAL_SCALE was declared after resize() inside the function).
// ---------------------------------------------------------------------------

describe("createPixelSurface — startup at every container size", () => {
  let createPixelSurface;

  before(async () => {
    ({ createPixelSurface } = await import(`${ROOT}/runtime/renderer/pixelSurface.js`));
  });

  function makeCanvas(w, h) {
    const style = {};
    return {
      width: 320,
      height: 180,
      style,
      parentElement: {
        getBoundingClientRect: () => ({ width: w, height: h }),
      },
      getContext: () => ({
        setTransform() {},
        imageSmoothingEnabled: false,
        mozImageSmoothingEnabled: false,
        webkitImageSmoothingEnabled: false,
        msImageSmoothingEnabled: false,
      }),
    };
  }

  const CASES = [
    [390,  664, 1   ],
    [414,  896, 1.29],
    [750,  342, 1.9 ],   // min(750/320,342/180)=min(2.34,1.9)=1.9 → intScale=1<2, fractional
    [1120, 900, 3   ],
    [1600, 1080, 5  ],
  ];

  for (const [w, h, expected] of CASES) {
    it(`${w}×${h} → surface.scale === ${expected} and CSS width === ${320 * expected}px`, () => {
      const canvas = makeCanvas(w, h);
      const surface = createPixelSurface(canvas);
      assert.equal(surface.scale, expected,
        `scale should be ${expected} for container ${w}×${h}`);
      assert.equal(canvas.style.width, `${320 * expected}px`,
        `CSS width should be ${320 * expected}px`);
      // Smoke-test that resize() and present() do not throw.
      surface.resize();
      surface.present();
    });
  }
});

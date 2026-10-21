/**
 * test/bounty-branding.test.js
 * Renamed from arc-branding.test.js; updated for the Bounty Dungeon rebrand.
 */
import assert from "node:assert/strict";
import test, { describe, it, before } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as branding from "../apps/web/src/core/branding.js";
import { drawHubBranding } from "../apps/web/src/runtime/scenes/hubBranding.js";
import { drawOnboardingBackground } from "../apps/web/src/runtime/scenes/onboardingBackground.js";
import { ENTRY_HERO_NICHE_LAYOUT } from "../apps/web/src/runtime/scenes/onboardingHeroNiche.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "apps", "web");

function recordingContext() {
  const context = {
    texts: [], rects: [],
    fillStyle: "#000",
    globalAlpha: 1,
    save() {}, restore() {},
    fillRect(x, y, width, height) {
      this.rects.push({ x, y, width, height, color: this.fillStyle });
    },
    fillText(text, x, y) { this.texts.push({ text, x, y }); },
    measureText: (text) => ({ width: text.length * 10 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    setTransform() {},
    imageSmoothingEnabled: false,
    mozImageSmoothingEnabled: false,
    webkitImageSmoothingEnabled: false,
    msImageSmoothingEnabled: false,
  };
  return context;
}

// ---------------------------------------------------------------------------
// 1. branding.js exports
// ---------------------------------------------------------------------------

test("createBountyLogoMark is exported; createArcLogoMark and arcCastleBrand are undefined", () => {
  assert.equal(typeof branding.createBountyLogoMark, "function",
    "createBountyLogoMark must be exported");
  assert.equal(branding.createArcLogoMark, undefined,
    "createArcLogoMark must not be exported (old name)");
  assert.equal(branding.arcCastleBrand, undefined,
    "arcCastleBrand must not be exported (old name)");
  assert.equal(typeof branding.guildBrand, "object",
    "guildBrand must be exported");
});

test("createBountyLogoMark kind is 'bounty-chest-sword'", () => {
  const mark = branding.createBountyLogoMark(0, 0, 1);
  assert.equal(mark.kind, "bounty-chest-sword");
});

test("mark has required roles: coin, blade, lid, lock", () => {
  const mark = branding.createBountyLogoMark(0, 0, 1);
  const roles = new Set(mark.parts.map((p) => p.role));
  for (const role of ["coin", "blade", "lid", "lock"]) {
    assert.ok(roles.has(role), `missing role: ${role}`);
  }
});

test("all mark parts are integers inside a 16×15 grid at unit=1", () => {
  const mark = branding.createBountyLogoMark(0, 0, 1);
  for (const p of mark.parts) {
    assert.ok(Number.isInteger(p.x), `x not integer: ${p.x}`);
    assert.ok(Number.isInteger(p.y), `y not integer: ${p.y}`);
    assert.ok(Number.isInteger(p.width), `width not integer: ${p.width}`);
    assert.ok(Number.isInteger(p.height), `height not integer: ${p.height}`);
    assert.ok(p.x >= 0 && p.x <= 15, `x out of bounds: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= 14, `y out of bounds: ${p.y}`);
  }
});

// ---------------------------------------------------------------------------
// 2. hubBranding draws "BOUNTY" (shortLabel)
// ---------------------------------------------------------------------------

test("drawHubBranding draws guildBrand.shortLabel ('BOUNTY') on the wall sign", () => {
  const ctx = recordingContext();
  // Intercept drawPixelText via fillText stub — pixelUi uses fillText.
  const texts = [];
  ctx.fillText = (text, x, y) => texts.push({ text, x, y });
  drawHubBranding(ctx);
  // Texts captured include the short label.
  const allText = texts.map((t) => t.text).join(" ");
  assert.ok(
    allText.includes(branding.guildBrand.shortLabel),
    `expected "${branding.guildBrand.shortLabel}" in hub branding text, got: ${allText}`,
  );
});

test("drawHubBranding draws all logo mark parts", () => {
  const ctx = recordingContext();
  const mark = branding.createBountyLogoMark(
    Math.round(branding.guildBrand.environmentMark.x),
    Math.round(branding.guildBrand.environmentMark.y + 2),
    Math.round(branding.guildBrand.environmentMark.logoUnit),
  );
  drawHubBranding(ctx);
  // Every mark part color should appear in the drawn rects.
  const colors = new Set(ctx.rects.map((r) => r.color));
  for (const part of mark.parts) {
    assert.ok(colors.has(part.color),
      `color ${part.color} (role: ${part.role}) was not drawn`);
  }
});

// ---------------------------------------------------------------------------
// 3. onboardingBackground draws "BOUNTY DUNGEON"
// ---------------------------------------------------------------------------

const TILESET = { frames: {}, image: null };

function makeOnboardingCtx() {
  const ctx = recordingContext();
  ctx.setTransform = () => {};
  const fakeGradient = { addColorStop() {} };
  ctx.createRadialGradient = () => fakeGradient;
  ctx.createLinearGradient = () => fakeGradient;
  return ctx;
}

for (const logoUnit of [1.5, 2, 3]) {
  test(`drawOnboardingBackground logoUnit=${logoUnit} draws "BOUNTY DUNGEON"`, () => {
    const ctx = makeOnboardingCtx();
    const texts = [];
    ctx.fillText = (text, x, y) => { texts.push({ text, x, y }); };
    drawOnboardingBackground(ctx, {
      width: 320, height: 180,
      tileset: TILESET,
      elapsedMs: 0,
      logoUnit,
      logoShadowMode: "offset",
      nicheLayout: ENTRY_HERO_NICHE_LAYOUT,
    });
    const allText = texts.map((t) => t.text).join(" ");
    assert.ok(
      allText.includes("BOUNTY DUNGEON"),
      `expected "BOUNTY DUNGEON" in onboarding text at logoUnit=${logoUnit}, got: ${allText}`,
    );
  });
}

test("onboardingBackground contains no /rialo|\\bARC\\b/i text", () => {
  const ctx = makeOnboardingCtx();
  const texts = [];
  ctx.fillText = (text, x, y) => { texts.push(text); };
  drawOnboardingBackground(ctx, {
    width: 320, height: 180,
    tileset: TILESET,
    elapsedMs: 0,
    logoUnit: 2,
    logoShadowMode: "offset",
    nicheLayout: ENTRY_HERO_NICHE_LAYOUT,
  });
  for (const t of texts) {
    assert.ok(
      !/rialo|\bARC\b/i.test(t),
      `found forbidden text "${t}" in onboarding draw calls`,
    );
  }
});

test("logo mark origin is left of title text and inside the canvas (320 wide)", () => {
  const ctx = makeOnboardingCtx();
  const result = drawOnboardingBackground(ctx, {
    width: 320, height: 180,
    tileset: TILESET,
    elapsedMs: 0,
    logoUnit: 2,
    logoShadowMode: "outline",
    nicheLayout: ENTRY_HERO_NICHE_LAYOUT,
  });
  assert.ok(result.logoOrigin.x >= 0, "logoOrigin.x must be >= 0");
  assert.ok(result.logoOrigin.x < 320, "logoOrigin.x must be inside canvas");
});

// ---------------------------------------------------------------------------
// 4. Font-size fitting test with mock measureText (width = chars * size * 0.6)
// ---------------------------------------------------------------------------

test("font-size fitting: logoUnit 3 still returns a valid logoMark and origin inside 320", () => {
  // At size 30, "BOUNTY DUNGEON" (14 chars × 30 × 0.6 = 252) > available (247), so 30 is
  // rejected and the function falls back to 20. We verify the result is valid.
  const fakeGradient = { addColorStop() {} };
  const ctx = {
    texts: [], rects: [],
    fillStyle: "#000", globalAlpha: 1,
    save() {}, restore() {},
    fillRect() {},
    fillText(text, x, y) { this.texts.push({ text, x, y }); },
    setTransform() {},
    imageSmoothingEnabled: false,
    mozImageSmoothingEnabled: false,
    webkitImageSmoothingEnabled: false,
    msImageSmoothingEnabled: false,
    createRadialGradient: () => fakeGradient,
    createLinearGradient: () => fakeGradient,
    measureText(text) { return { width: text.length * 10 }; },
  };
  const result = drawOnboardingBackground(ctx, {
    width: 320, height: 180,
    tileset: TILESET,
    elapsedMs: 0,
    logoUnit: 3,
    logoShadowMode: "outline",
    nicheLayout: ENTRY_HERO_NICHE_LAYOUT,
  });
  assert.ok(result.logoMark, "logoMark must be returned");
  assert.equal(result.logoMark.kind, "bounty-chest-sword");
  assert.ok(result.logoOrigin.x >= 0 && result.logoOrigin.x < 320);
});

// ---------------------------------------------------------------------------
// 5. index.html checks
// ---------------------------------------------------------------------------

describe("apps/web/index.html", () => {
  let html;
  before(async () => {
    html = await readFile(join(ROOT, "index.html"), "utf8");
  });

  it("uses bounty-logo.svg (not arc-logo.svg)", () => {
    assert.ok(html.includes("bounty-logo.svg"), "should reference bounty-logo.svg");
    assert.ok(!html.includes("arc-logo.svg"), "must not reference arc-logo.svg");
  });

  it("title is 'Bounty Dungeon'", () => {
    assert.ok(html.includes("<title>Bounty Dungeon</title>"),
      "title must be exactly 'Bounty Dungeon'");
  });

  it("does not contain 'ARC Dungeon' text", () => {
    assert.ok(!html.includes("ARC Dungeon"),
      "must not contain 'ARC Dungeon'");
  });
});

// ---------------------------------------------------------------------------
// 6. SVG rects equal the canvas parts
// ---------------------------------------------------------------------------

describe("bounty-logo.svg rects equal createBountyLogoMark(0,0,1).parts", () => {
  let svgContent;
  before(async () => {
    svgContent = await readFile(
      join(ROOT, "assets", "branding", "bounty-logo.svg"),
      "utf8",
    );
  });

  it("SVG rect count matches part count", () => {
    const mark = branding.createBountyLogoMark(0, 0, 1);
    const rectMatches = [...svgContent.matchAll(/<rect/g)];
    assert.equal(rectMatches.length, mark.parts.length,
      `SVG has ${rectMatches.length} rects but mark has ${mark.parts.length} parts`);
  });

  it("every part color appears in the SVG", () => {
    const mark = branding.createBountyLogoMark(0, 0, 1);
    for (const part of mark.parts) {
      assert.ok(svgContent.includes(part.color),
        `color ${part.color} not found in SVG`);
    }
  });
});

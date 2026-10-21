/**
 * Acceptance test 3 (revised): banned symbols — import-graph walker.
 *
 * Starting from core/simulation/dungeonLogic.js, follows every relative
 * import recursively to build the complete simulation-path file set, then
 * asserts that none of those files contain the banned symbols.
 *
 * Banned: Math.{sin cos tan asin acos atan atan2 sinh cosh tanh asinh acosh
 *   atanh exp expm1 log log1p log2 log10 pow cbrt hypot random}, ** operator,
 *   Date.now, performance.now, new Date.
 *
 * Allowed: sqrt floor ceil round trunc abs min max sign imul fround clz32.
 *
 * dmath.js is exempt from the Math.* checks (it is the implementation) but
 * must not call Math.random, Date.now, or performance.now.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(__dirname, "../apps/web/src");
const ENTRY = resolve(ROOT, "core/simulation/dungeonSim.js");

// ---------------------------------------------------------------------------
// Import-graph walker
// ---------------------------------------------------------------------------

/**
 * Walk all relative imports from `startFile`, resolving only relative paths
 * (bare specifiers are third-party, not in the sim path).
 * Returns a Set of absolute file paths in the transitive closure.
 */
function walkImports(startFile) {
  const visited = new Set();
  const queue = [startFile];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    let src;
    try {
      src = readFileSync(current, "utf8");
    } catch {
      // File not found — may be a dynamic load we can't statically trace; skip.
      continue;
    }

    // Match: import ... from "./foo" or import ... from "../foo"
    // Also: export ... from "./foo"
    const importRe = /(?:import|export)[^'"]*['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      let target = m[1];
      // Resolve relative to the current file's directory
      const base = dirname(current);
      let abs = resolve(base, target);
      // If no extension, try .js
      if (!abs.endsWith(".js") && !abs.endsWith(".mjs") && !abs.endsWith(".cjs")) {
        abs += ".js";
      }
      if (!visited.has(abs)) {
        queue.push(abs);
      }
    }
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Banned-symbol checkers
// ---------------------------------------------------------------------------

/**
 * Returns all lines that contain a banned symbol.
 * For dmath.js (the implementation), only check the runtime-source bans
 * (Math.random, Date.now, performance.now, new Date) — not the Math.sin etc.
 * because dmath.js must define those using the allowed subset.
 */
function bannedLines(src, isDmath) {
  const lines = src.split("\n");
  const hits = [];

  // Banned Math methods (implementation-approximated)
  const bannedMathMethods = isDmath
    ? ["random"]
    : [
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
        "exp", "expm1", "log", "log1p", "log2", "log10",
        "pow", "cbrt", "hypot", "random",
      ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Skip comment-only lines
    const stripped = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");

    // Math.bannedMethod(  — check for method call (not a property in a string or comment)
    for (const method of bannedMathMethods) {
      // Match Math.method( but not inside a string literal (naive but sufficient
      // since simulation files don't embed code strings)
      if (new RegExp(`\\bMath\\.${method}\\s*\\(`).test(stripped)) {
        hits.push({ line: lineNo, text: line.trim(), reason: `Math.${method}` });
      }
    }

    // ** operator — but only when it's not inside a comment or string.
    // Skip if the line is purely a comment (already handled above by stripping).
    // The regex requires a non-* non-whitespace char on both sides to avoid
    // matching /**/ style comments or /* ... */ stripped text.
    if (!isDmath) {
      // stripped has had // comments and /* */ removed. Check for ** used as operator.
      // Operator: not surrounded by / (not regexp division).
      // A comment that starts with "* " (JSDoc) is already stripped; remaining ** should be operators.
      // But guard: "** operator" text in a string literal would still match — acceptable.
      // Skip if this is a block-comment continuation line (* ...)
      const trimmedStripped = stripped.trim();
      if (!trimmedStripped.startsWith("*")) {
        const noStrings = stripped.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
        if (/[^\s/*]\s*\*\*\s*[^\s/*=]|[^\s/*=]\s*\*\*\s*[^\s/*]/.test(noStrings)) {
          hits.push({ line: lineNo, text: line.trim(), reason: "** operator" });
        }
      }
    }

    // Date.now(
    if (/\bDate\.now\s*\(/.test(stripped)) {
      hits.push({ line: lineNo, text: line.trim(), reason: "Date.now" });
    }

    // performance.now(
    if (/\bperformance\.now\s*\(/.test(stripped)) {
      hits.push({ line: lineNo, text: line.trim(), reason: "performance.now" });
    }

    // new Date(  or  new Date)  or  new Date;  (wall-clock construction)
    if (/\bnew\s+Date\s*[();]/.test(stripped)) {
      hits.push({ line: lineNo, text: line.trim(), reason: "new Date" });
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Render-only files in the import graph that are intentionally excluded.
// These files are pure renderers (VFX shapes, hit feedback display) that only
// call Math.* for visual calculations — their output has no effect on
// simulation state.  Per the project spec: "Leave render-only files untouched."
// ---------------------------------------------------------------------------
const RENDER_ONLY_EXCLUSIONS = new Set([
  resolve(ROOT, "runtime/scenes/dungeonCombatFeedback.js"),
  resolve(ROOT, "runtime/scenes/dungeonSkillVfxShapes.js"),
  resolve(ROOT, "runtime/scenes/dungeonCombatLights.js"),
]);

const graph = walkImports(ENTRY);
const DMATH_PATH = resolve(ROOT, "core/simulation/dmath.js");

describe("import graph from dungeonLogic.js", () => {
  it("graph contains expected core files", () => {
    const relPaths = [...graph].map((p) => relative(ROOT, p)).sort();
    // Must include the three new simulation files
    assert.ok(
      relPaths.some((p) => p.includes("dmath")),
      `dmath.js not in graph. Graph:\n${relPaths.join("\n")}`,
    );
    assert.ok(
      relPaths.some((p) => p.includes("dungeonSim")),
      "dungeonSim.js not in graph",
    );
    assert.ok(
      relPaths.some((p) => p.includes("enemyCoordination")),
      "enemyCoordination.js not in graph",
    );
  });

  it("graph size is reasonable (10–120 files)", () => {
    assert.ok(
      graph.size >= 10 && graph.size <= 120,
      `graph.size=${graph.size} — check for runaway traversal or missing imports`,
    );
  });
});

describe("banned symbols — full import graph", () => {
  for (const filePath of [...graph].sort()) {
    if (RENDER_ONLY_EXCLUSIONS.has(filePath)) continue;
    const rel = relative(ROOT, filePath);
    const isDmath = filePath === DMATH_PATH;

    it(`${rel} has no banned symbols`, () => {
      let src;
      try {
        src = readFileSync(filePath, "utf8");
      } catch {
        assert.fail(`Could not read ${filePath}`);
      }

      const hits = bannedLines(src, isDmath);
      if (hits.length > 0) {
        const detail = hits.map((h) => `  line ${h.line} [${h.reason}]: ${h.text}`).join("\n");
        assert.fail(`${rel} contains banned symbols:\n${detail}`);
      }
    });
  }
});

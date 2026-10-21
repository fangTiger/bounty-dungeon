/**
 * app-source-order.test.js
 *
 * Guards against TDZ bugs in app.js: any `let`/`const` that is read inside
 * `createScene` must be declared BEFORE the first `createScene(` call-site.
 *
 * Strategy: parse the source with a simple line-by-line scan (no AST needed):
 *   1. Find the line index of every `let X` / `const X` declaration.
 *   2. Find the line index of the first `createScene(` call (not the function def).
 *   3. For every identifier used inside the createScene function body, if it was
 *      declared with let/const, its declaration must be on an earlier line.
 *
 * We use a conservative text-search approach:
 *   - "used inside createScene" = appears in the createScene function definition
 *     body (between `function createScene(` and the matching closing `}`).
 *   - We collect identifiers from that body that appear in let/const declarations
 *     elsewhere in the file.
 *   - We then check each one was declared BEFORE the first `createScene(` call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_SRC = join(ROOT, "apps/web/src/runtime/app.js");

describe("app.js source order", () => {
  it("all let/const used inside createScene() are declared before the first createScene() call", () => {
    const src = readFileSync(APP_SRC, "utf8");
    const lines = src.split("\n");

    // --- 1. Find let/const declarations at the createApp body's TOP level only ---
    // (i.e. declarations that are direct children of createApp, not inside nested
    // function bodies or if/else blocks).  We track this with a brace-depth counter
    // relative to the opening `{` of `export async function createApp`.
    const declarations = new Map(); // identifier -> line index (0-based)
    {
      // Find the opening { of createApp
      let createAppStart = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/export\s+async\s+function\s+createApp\b/.test(lines[i])) {
          createAppStart = i;
          break;
        }
      }
      assert.notEqual(createAppStart, -1, "Could not find createApp in app.js");

      // Walk from there, tracking depth; depth 1 = direct body of createApp
      let depth = 0;
      let started = false;
      for (let i = createAppStart; i < lines.length; i++) {
        const line = lines[i];
        // Count braces character-by-character so we stay accurate
        for (const ch of line) {
          if (ch === "{") { depth++; started = true; }
          else if (ch === "}") { depth--; }
        }
        if (!started) continue;
        if (depth <= 0) break; // left createApp

        // Only declarations at depth === 1 (direct body of createApp)
        if (depth === 1) {
          const m = line.match(/^\s*(?:let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
          if (m) {
            const name = m[1];
            if (!declarations.has(name)) declarations.set(name, i);
          }
        }
      }
    }

    // --- 2. First call-site of createScene( (not the function definition line) ---
    let firstCallLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Skip the definition line itself
      if (/function\s+createScene\s*\(/.test(l)) continue;
      if (/createScene\s*\(/.test(l)) {
        firstCallLine = i;
        break;
      }
    }

    assert.notEqual(firstCallLine, -1, "Could not find a createScene( call in app.js");

    // --- 3. Extract the body of the `function createScene(` definition ---
    let defStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/function\s+createScene\s*\(/.test(lines[i])) { defStart = i; break; }
    }
    assert.notEqual(defStart, -1, "Could not find function createScene( definition");

    // Collect lines inside the function body (naive brace counting)
    let depth = 0;
    let bodyLines = [];
    let inBody = false;
    for (let i = defStart; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; inBody = true; }
        else if (ch === "}") { depth--; }
      }
      bodyLines.push(lines[i]);
      if (inBody && depth === 0) break;
    }
    const bodyText = bodyLines.join("\n");

    // --- 4. Collect identifiers in the body that have let/const declarations ---
    const identPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
    const used = new Set();
    let match;
    while ((match = identPattern.exec(bodyText)) !== null) {
      used.add(match[1]);
    }

    // --- 5. Assert each such identifier is declared before the first call ---
    const violations = [];
    for (const name of used) {
      if (!declarations.has(name)) continue; // not a let/const — skip
      const declLine = declarations.get(name);
      if (declLine >= firstCallLine) {
        violations.push({
          name,
          declaredAt: declLine + 1,   // 1-based for readability
          firstCallAt: firstCallLine + 1,
        });
      }
    }

    assert.deepEqual(
      violations,
      [],
      `The following let/const identifiers used inside createScene() are declared ` +
      `AFTER the first createScene() call — this causes a TDZ ReferenceError:\n` +
      violations.map((v) => `  ${v.name}: declared line ${v.declaredAt}, first call line ${v.firstCallAt}`).join("\n"),
    );
  });
});

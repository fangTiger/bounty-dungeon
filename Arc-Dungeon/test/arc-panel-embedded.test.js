/**
 * test/arc-panel-embedded.test.js
 * Verifies that initializeArcPanel hides the wallet controls (connect, switch,
 * walletStatus) when the game is running inside a parent shell (iframe mode),
 * and leaves them visible when running standalone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initializeArcPanel } from "../apps/web/src/arc/panel.js";

/**
 * Minimal DOM stub that records style.display changes.
 */
function makeDoc(hasParent) {
  const elements = {};
  const makeEl = (id) => {
    const el = {
      id,
      style: { display: "" },
      disabled: false,
      textContent: "",
      open: false,
      replaceChildren() {},
      append() {},
      addEventListener() {},
    };
    elements[id] = el;
    return el;
  };
  const ids = ["arc-connect", "arc-switch", "arc-wallet-status", "arc-submit",
                "arc-record-status", "arc-preview", "arc-history", "arc-records",
                "arc-daily"];
  for (const id of ids) makeEl(id);

  const doc = {
    querySelector(sel) {
      const id = sel.replace(/^#/, "");
      return elements[id] ?? null;
    },
  };

  // Minimal window stub
  const win = {
    ethereum: undefined,
    localStorage: null,
    parent: hasParent ? {} : null,   // different object → embedded; set below
    addEventListener() {},
    removeEventListener() {},
    setInterval() { return 0; },
    clearInterval() {},
    rialoDebug: undefined,
    __arcApp: undefined,
  };
  // For standalone: parent === win itself
  if (!hasParent) win.parent = win;

  return { doc, win, elements };
}

describe("panel.js embedded-mode wallet hiding", () => {
  it("hides connect, switch, and status when embedded in a shell (parent !== window)", () => {
    const { doc, win, elements } = makeDoc(true /* has different parent */);
    initializeArcPanel(doc, win);
    assert.equal(elements["arc-connect"].style.display, "none", "connect should be hidden");
    assert.equal(elements["arc-switch"].style.display,  "none", "switch should be hidden");
    assert.equal(elements["arc-wallet-status"].style.display, "none", "walletStatus should be hidden");
  });

  it("leaves wallet controls visible when running standalone (parent === window)", () => {
    const { doc, win, elements } = makeDoc(false /* standalone */);
    initializeArcPanel(doc, win);
    // display should be "" (not overridden)
    assert.equal(elements["arc-connect"].style.display, "", "connect should be visible");
    assert.equal(elements["arc-switch"].style.display,  "", "switch should be visible");
    assert.equal(elements["arc-wallet-status"].style.display, "", "walletStatus should be visible");
  });

  it("sets .arc-shell gridTemplateRows to 'minmax(0, 1fr)' when embedded", () => {
    // Build a doc stub that also handles class-based selectors
    const shellEl = { style: {} };
    const toolbarEl = { style: {} };
    const { doc: baseDoc, win, elements } = makeDoc(true);
    const doc = {
      querySelector(sel) {
        if (sel === ".arc-shell")  return shellEl;
        if (sel === ".arc-toolbar") return toolbarEl;
        return baseDoc.querySelector(sel);
      },
    };
    initializeArcPanel(doc, win);
    assert.equal(shellEl.style.gridTemplateRows, "minmax(0, 1fr)",
      "shell grid row should collapse to fill viewport");
    assert.equal(toolbarEl.style.display, "none", "toolbar should be hidden");
    // In standalone mode the shell is not touched
    const shellEl2 = { style: {} };
    const { doc: baseDoc2, win: win2 } = makeDoc(false);
    const doc2 = {
      querySelector(sel) {
        if (sel === ".arc-shell")  return shellEl2;
        if (sel === ".arc-toolbar") return { style: {} };
        return baseDoc2.querySelector(sel);
      },
    };
    initializeArcPanel(doc2, win2);
    assert.equal(shellEl2.style.gridTemplateRows, undefined,
      "shell grid row should not be set in standalone mode");
  });
});

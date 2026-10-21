/**
 * dungeonCombatJuice.js — render-only hit/death effects.
 *
 * Listens to combat snapshot changes (enemy hp, player hp) AFTER the sim tick
 * and drives:
 *   - A white flash on the enemy sprite when hit
 *   - 4-6 spark particles at the impact point
 *   - A small dust/bone puff when an enemy dies
 *   - A red edge vignette flash (~150 ms) when the player takes damage
 *
 * HARD RULE: must never import from core/simulation/* and must never consume
 * sim RNG.  All randomness uses a render-local PRNG seeded from frame time.
 *
 * prefers-reduced-motion: no camera shake extra, fewer particles.
 */

const SPARK_COUNT       = 5;
const SPARK_MAX_AGE_MS  = 220;
const DUST_COUNT        = 6;
const DUST_MAX_AGE_MS   = 320;
const FLASH_MAX_AGE_MS  = 120;
const PLAYER_FLASH_MS   = 150;

const prefersReducedMotion = typeof window !== "undefined"
  && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

/**
 * Stateful xorshift32 PRNG — seeded once per createCombatJuice() call.
 * All particle randomness draws from this; never re-seeded from performance.now
 * so consecutive values are always distinct.
 */
function makeRng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0 || 1; // must be non-zero
  return function rnd() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export function createCombatJuice() {
  // Seed from performance.now once at construction — never per-particle
  const rnd = makeRng(Math.round((performance?.now?.() ?? Date.now()) * 1000) >>> 0);
  // Per-enemy flash state: Map<enemyId, { ageMs, maxAgeMs }>
  const flashes = new Map();
  // Spark particles
  const sparks = [];
  // Dust puff particles
  const dust = [];
  // Player damage vignette flash
  let playerFlashMs = 0;

  // Previous snapshots for delta detection
  let prevEnemyHp = new Map();   // Map<id, hp>
  let prevEnemyDead = new Set(); // ids known dead last frame
  let prevPlayerHp = Infinity;

  function update(combatSnapshot, dtMs) {
    const enemies = combatSnapshot?.enemies ?? [];
    const playerHp = combatSnapshot?.playerHp ?? Infinity;

    // --- Detect hits and deaths ---
    for (const enemy of enemies) {
      const id = enemy.id;
      const hp = enemy.hp;
      const wasDead = prevEnemyDead.has(id);
      const prevHp = prevEnemyHp.get(id) ?? hp;

      if (!wasDead && hp < prevHp) {
        // Enemy took damage → white flash + sparks
        flashes.set(id, { ageMs: 0, maxAgeMs: FLASH_MAX_AGE_MS });
        const count = prefersReducedMotion ? 2 : SPARK_COUNT + Math.floor(rnd() * 2);
        for (let i = 0; i < count; i++) {
          const angle = rnd() * Math.PI * 2;
          const speed = 20 + rnd() * 40;
          sparks.push({
            x: enemy.x,
            y: enemy.y - 8,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 15,
            ageMs: 0,
            maxAgeMs: SPARK_MAX_AGE_MS * (0.6 + rnd() * 0.8),
            color: rnd() < 0.5 ? "#ffe8a3" : "#ffffff",
          });
        }
        if (hp <= 0) {
          // Death dust
          const dcount = prefersReducedMotion ? 2 : DUST_COUNT;
          for (let i = 0; i < dcount; i++) {
            const angle = rnd() * Math.PI * 2;
            const speed = 10 + rnd() * 20;
            dust.push({
              x: enemy.x + (rnd() - 0.5) * 6,
              y: enemy.y - 4 + (rnd() - 0.5) * 4,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed - 8,
              ageMs: 0,
              maxAgeMs: DUST_MAX_AGE_MS * (0.7 + rnd() * 0.6),
            });
          }
        }
      }

      prevEnemyHp.set(id, hp);
      if (hp <= 0 || enemy.state === "dead") {
        prevEnemyDead.add(id);
      }
    }

    // Player took damage
    if (playerHp < prevPlayerHp) {
      playerFlashMs = PLAYER_FLASH_MS;
    }
    prevPlayerHp = playerHp;

    // --- Age / tick ---
    for (const [id, flash] of flashes) {
      flash.ageMs += dtMs;
      if (flash.ageMs >= flash.maxAgeMs) flashes.delete(id);
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.ageMs += dtMs;
      s.x += s.vx * (dtMs / 1000);
      s.y += s.vy * (dtMs / 1000);
      if (s.ageMs >= s.maxAgeMs) sparks.splice(i, 1);
    }
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      d.ageMs += dtMs;
      d.x += d.vx * (dtMs / 1000);
      d.y += d.vy * (dtMs / 1000);
      if (d.ageMs >= d.maxAgeMs) dust.splice(i, 1);
    }
    playerFlashMs = Math.max(0, playerFlashMs - dtMs);
  }

  /** Returns the flash alpha for a given enemy id (0 = no flash). */
  function getEnemyFlashAlpha(id) {
    const flash = flashes.get(id);
    if (!flash) return 0;
    return Math.max(0, 1 - flash.ageMs / flash.maxAgeMs);
  }

  /** Draw spark + dust particles. Call AFTER sprites, BEFORE lighting. */
  function drawParticles(context, camera) {
    context.save();
    for (const s of sparks) {
      const t = s.ageMs / s.maxAgeMs;
      const screen = camera.worldToScreen(s.x, s.y);
      context.globalAlpha = Math.max(0, 1 - t);
      context.fillStyle = s.color;
      context.fillRect(Math.round(screen.x), Math.round(screen.y), 1, 1);
    }
    for (const d of dust) {
      const t = d.ageMs / d.maxAgeMs;
      const screen = camera.worldToScreen(d.x, d.y);
      context.globalAlpha = Math.max(0, 0.7 * (1 - t));
      context.fillStyle = t < 0.4 ? "#d4c8b8" : "#8c7c6c";
      context.fillRect(Math.round(screen.x), Math.round(screen.y), 2, 2);
    }
    context.restore();
  }

  /**
   * Draw a red edge vignette flash when the player took damage.
   * Call AFTER the lighting/vignette pass.
   */
  function drawPlayerDamageFlash(context, width, height) {
    if (playerFlashMs <= 0) return;
    const alpha = (playerFlashMs / PLAYER_FLASH_MS) * 0.55;
    context.save();
    const grad = context.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.25,
      width / 2, height / 2, Math.max(width, height) * 0.75,
    );
    grad.addColorStop(0, "rgba(180,20,20,0)");
    grad.addColorStop(1, `rgba(180,20,20,${alpha.toFixed(3)})`);
    context.globalCompositeOperation = "source-over";
    context.fillStyle = grad;
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  function reset() {
    flashes.clear();
    sparks.length = 0;
    dust.length = 0;
    playerFlashMs = 0;
    prevEnemyHp.clear();
    prevEnemyDead.clear();
    prevPlayerHp = Infinity;
  }

  return {
    update,
    getEnemyFlashAlpha,
    drawParticles,
    drawPlayerDamageFlash,
    reset,
  };
}

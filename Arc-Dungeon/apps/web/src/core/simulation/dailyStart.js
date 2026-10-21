/**
 * createDailyStart — canonical fixed baseline for a daily dungeon run.
 *
 * Both the live browser game and createDungeonSimHeadless must use this
 * function to build the initial (run, player) pair for a daily run, so the
 * two paths cannot drift.
 *
 * Fixed baseline contract:
 *   - No tickets consumed, no economy.startRun interaction.
 *   - No build upgrades pre-applied (createRun's EMBARK choice is still
 *     presented to the player on tick 1 as usual).
 *   - No profile or skin stat effects (sprite variant is fine via heroIdentity).
 *   - heroIdentity is accepted as-is for cosmetic use only.
 *   - Daily runs do not pay economy rewards (enforced at the call site in app.js).
 */

import { applyBuildBonusesToPlayer, createPlayer } from "../combat.js";
import { getDungeonSpawnPosition } from "../dungeon/roomMap.js";
import { createRun } from "../run/runState.js";
import { normalizeHeroClass } from "../../runtime/scenes/dungeonScenePlayer.js";
import { PLAYER_RADIUS } from "./dungeonSim.js";

/**
 * @param {object} opts
 * @param {string}  opts.seed       - daily seed string (hex from computeDailySeed)
 * @param {string}  opts.heroClass  - "knight" | "wizzard"
 * @param {object}  [opts.heroIdentity] - cosmetic only; no stat effects
 * @returns {{ run: object, player: object }}
 */
export function createDailyStart({ seed, heroClass, heroIdentity = null }) {
  const classId = normalizeHeroClass(heroClass);
  const spawn = getDungeonSpawnPosition();

  // createRun triggers the EMBARK upgrade choice; build is empty until the
  // player picks at tick 1 — identical to headless path.
  const run = createRun({ seed, heroClass: classId, heroIdentity });

  const player = applyBuildBonusesToPlayer(
    createPlayer({
      classId,
      x: spawn.x,
      y: spawn.y,
      radius: PLAYER_RADIUS,
      facing: { x: 0, y: 1 },
      facingName: "down",
      moving: false,
      knockbackX: 0,
      knockbackY: 0,
    }),
    run.build?.bonuses,
  );

  return { run, player };
}

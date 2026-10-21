import { enemyCountForDepth } from "../../core/combat/balance.js";
import { canMoveCharacterTo, canMoveToDungeonRoom } from "../../core/dungeon/roomMap.js";
import { collectDoorPathTiles } from "../../core/dungeon/roomContentPlacement.js";
import { dacos, dcos, dexp, dhypot, dsin } from "../../core/simulation/dmath.js";

/** Pixels below enemy body-centre to foot-centre (same sprite placement as player). */
export const ENEMY_FOOT_OFFSET = 7;

export { enemyCountForDepth };

export const ENEMY_RADIUS = 7;

export function collectWalkableTiles(roomMap) {
  const tiles = [];

  for (let tileY = 0; tileY < roomMap.height; tileY += 1) {
    for (let tileX = 0; tileX < roomMap.width; tileX += 1) {
      const x = tileX * roomMap.tileSize + roomMap.tileSize / 2;
      const y = tileY * roomMap.tileSize + roomMap.tileSize / 2;
      if (canMoveCharacterTo(roomMap, x, y, ENEMY_RADIUS, ENEMY_FOOT_OFFSET)) {
        tiles.push({ tileX, tileY });
      }
    }
  }

  return tiles;
}

export function collectDoorTiles(roomMap) {
  return collectDoorPathTiles({
    doors: roomMap.room.doors,
    extendToCenter: false,
    width: roomMap.width,
    height: roomMap.height,
  });
}

export function patrolTarget(enemy, now) {
  const seconds = now / 1000;
  return {
    x: enemy.spawnX + dcos(seconds * 0.8 + enemy.patrolPhase) * 18,
    y: enemy.spawnY + dsin(seconds * 0.65 + enemy.patrolPhase) * 14,
  };
}

export function isEnemyInsideMelee(player, enemy, attack) {
  const dx = enemy.x - player.x;
  const dy = enemy.y - player.y;
  const distance = dhypot(dx, dy);

  if (distance > attack.range + enemy.radius) {
    return false;
  }

  return angleBetween(player.facing, normalize(dx, dy)) <= (attack.arc * Math.PI) / 360;
}

export function moveEntityInRoom(roomMap, entity, dx, dy) {
  const moved = { ...entity };
  const fo = entity.footOffset ?? 0;
  const canMove = fo
    ? (x, y) => canMoveCharacterTo(roomMap, x, y, moved.radius, fo)
    : (x, y) => canMoveToDungeonRoom(roomMap, x, y, moved.radius);

  if (canMove(moved.x + dx, moved.y)) {
    moved.x += dx;
  }

  if (canMove(moved.x, moved.y + dy)) {
    moved.y += dy;
  }

  if (moved.x === entity.x && moved.y === entity.y && Math.abs(dx) + Math.abs(dy) > 0) {
    const slideX = -Math.sign(dy) * Math.min(1.2, Math.abs(dy));
    const slideY = Math.sign(dx) * Math.min(1.2, Math.abs(dx));
    if (canMove(moved.x + slideX, moved.y + slideY)) {
      moved.x += slideX;
      moved.y += slideY;
    }
  }

  if (moved.x !== entity.x) {
    moved.facingX = moved.x < entity.x ? -1 : 1;
  }

  return moved;
}

export function applyEntityKnockbackInRoom(roomMap, entity, dt) {
  const vx = entity.knockbackX ?? 0;
  const vy = entity.knockbackY ?? 0;

  if (Math.abs(vx) + Math.abs(vy) < 1) {
    return {
      ...entity,
      knockbackX: 0,
      knockbackY: 0,
    };
  }

  const moved = moveEntityInRoom(roomMap, entity, vx * dt, vy * dt);
  const decay = dexp(-dt * 12);

  return {
    ...moved,
    knockbackX: vx * decay,
    knockbackY: vy * decay,
  };
}

export function knockbackVector(target, source, force) {
  const direction = normalize(target.x - source.x, target.y - source.y);
  return { x: direction.x * force, y: direction.y * force };
}

export function normalize(x, y) {
  const length = dhypot(x, y);
  if (length === 0) {
    return { x: 0, y: 1 };
  }

  return { x: x / length, y: y / length };
}

export function isAlive(enemy) {
  return enemy.hp > 0 && enemy.state !== "dead";
}

function angleBetween(left, right) {
  const dot = left.x * right.x + left.y * right.y;
  return dacos(Math.max(-1, Math.min(1, dot)));
}

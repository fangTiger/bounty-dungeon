export const guildBrand = {
  label: "BOUNTY DUNGEON",
  shortLabel: "BOUNTY",
  subtitle: "Guild Lintel",
  mode: "integrated-guild-hub",
  x: 260,
  y: 10,
  environmentMark: {
    kind: "guild-lintel-logo",
    x: 230,
    y: 4,
    logoUnit: 1,
    logoCount: 1,
    color: "#f6d77a",
    showTextLabel: true,
    surface: "wall-relief",
    detachedPanel: false,
  },
};

// 原创 16×15 像素标记：插在宝箱上的剑代表悬赏挑战，右上金币代表 USDC 奖金。
// 顺序即绘制顺序，后画的块覆盖先画的块；SVG 图标由同一组矩形生成。
const LOGO_BLOCKS = Object.freeze([
  [13, 0, 2, 1, "coin"], [12, 1, 4, 2, "coin"], [13, 3, 2, 1, "coin"], [14, 1, 1, 2, "coin-mark"],
  [7, 0, 2, 1, "hilt"], [7, 1, 2, 1, "grip"], [6, 2, 4, 1, "hilt"],
  [7, 3, 2, 3, "blade"], [8, 3, 1, 3, "blade-shade"],
  [2, 6, 12, 1, "outline"], [1, 7, 14, 2, "lid"], [1, 9, 14, 1, "band"],
  [1, 10, 14, 4, "wood"], [1, 14, 14, 1, "outline"],
  [4, 7, 1, 7, "strap"], [11, 7, 1, 7, "strap"],
  [6, 9, 4, 3, "lock"], [7, 10, 2, 1, "keyhole"],
]);

const LOGO_COLORS = Object.freeze({
  coin: "#f6d77a",
  "coin-mark": "#c9962e",
  hilt: "#f6d77a",
  grip: "#8a4b2a",
  blade: "#dfe6f0",
  "blade-shade": "#8b97ab",
  outline: "#3a2216",
  lid: "#b8683a",
  band: "#f6d77a",
  wood: "#8a4b2a",
  strap: "#c9962e",
  lock: "#f6d77a",
  keyhole: "#3a2216",
});

export function createBountyLogoMark(x, y, unit = 4) {
  return {
    kind: "bounty-chest-sword", x, y, unit,
    width: Math.round(16 * unit), height: Math.round(15 * unit),
    parts: LOGO_BLOCKS.map(([left, top, width, height, role]) => ({
      x: Math.round(x + left * unit), y: Math.round(y + top * unit),
      width: Math.max(1, Math.round(width * unit)), height: Math.max(1, Math.round(height * unit)),
      role, color: LOGO_COLORS[role],
    })),
  };
}

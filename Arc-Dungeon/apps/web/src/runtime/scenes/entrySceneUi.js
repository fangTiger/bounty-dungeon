import { setImageSmoothing } from "../renderer/pixelSurface.js";
import {
  drawCenteredPixelText,
  drawPixelPanel,
  drawPixelText,
} from "../ui/pixelUi.js";
import { drawOnboardingBackground } from "./onboardingBackground.js";
import { drawHeroNiche, ENTRY_HERO_NICHE_LAYOUT } from "./onboardingHeroNiche.js";

const LOGIN_LAYOUT = Object.freeze({
  optionX: 72,
  optionsTop: 114,
  optionWidth: 176,
  optionHeight: 24,
  footerX: 72,
  footerTop: 164,
  footerWidth: 176,
  footerHeight: 16,
});
const ENTRY_LOGO_UNIT = 1.5;
const BOTTOM_BAR = Object.freeze({
  x: LOGIN_LAYOUT.footerX,
  y: LOGIN_LAYOUT.footerTop,
  width: LOGIN_LAYOUT.footerWidth,
  height: LOGIN_LAYOUT.footerHeight,
  fill: "#17121c",
});
const SUBTITLE_PANEL = Object.freeze({ id: "subtitle", ...BOTTOM_BAR });
const FOOTER_PANEL = Object.freeze({ id: "footer", ...BOTTOM_BAR });
// Compact badge: 52 px leaves room for the brand mark in the lintel above it.
// The full key hint is already in the footer bar.
const LANGUAGE_PANEL = Object.freeze({
  id: "language", x: 4, y: 4, width: 52, height: 18, fill: "#17121c",
});
const OPTION_RECTS = Object.freeze([
  Object.freeze({
    x: LOGIN_LAYOUT.optionX,
    y: LOGIN_LAYOUT.optionsTop,
    width: LOGIN_LAYOUT.optionWidth,
    height: LOGIN_LAYOUT.optionHeight,
  }),
  Object.freeze({
    x: LOGIN_LAYOUT.optionX,
    y: LOGIN_LAYOUT.optionsTop + LOGIN_LAYOUT.optionHeight,
    width: LOGIN_LAYOUT.optionWidth,
    height: LOGIN_LAYOUT.optionHeight,
  }),
]);
// 入口统一使用石色顶边，选中和可用状态只通过文字与箭头表达。
const OPTION_ACCENT = "#6d6177";

export const entryBackgroundRenderer = drawOnboardingBackground;
export const entryNicheRenderer = drawHeroNiche;

export function drawEntryScene(context, {
  width,
  height,
  tileset,
  options,
  selectedIndex,
  statusText,
  authorizing,
  elapsedMs = 0,
  statusKey,
  t,
}) {
  context.save();
  setImageSmoothing(context, false);
  const baseBackground = entryBackgroundRenderer(context, {
    width,
    height,
    tileset,
    elapsedMs,
    logoUnit: ENTRY_LOGO_UNIT,
    logoShadowMode: "offset",
    nicheLayout: ENTRY_HERO_NICHE_LAYOUT,
  });
  const niche = entryNicheRenderer(context, tileset, {
    layer: "portrait",
    spritePrefix: "knight_m",
    classId: "knight",
    elapsedMs,
    layout: ENTRY_HERO_NICHE_LAYOUT,
  });
  const background = { ...baseBackground, ...niche };

  drawOpaquePanel(context, tileset, LANGUAGE_PANEL, "#71b7ff");
  drawCenteredPixelText(
    context,
    t("language.control"),
    LANGUAGE_PANEL.x + Math.round(LANGUAGE_PANEL.width / 2),
    8,
    { color: "#96cdff" },
  );

  // When Discord is unavailable (no client id configured), hide the Discord row entirely
  // and vertically re-centre the single "Continue as Guest" option.
  const discordOption  = options.find((o) => o.id === "discord");
  const discordHidden  = discordOption?.disabled === true;
  const visibleOptions = discordHidden ? options.filter((o) => o.id !== "discord") : options;

  // Re-centre the sole option when Discord is hidden: move it down 12 px so it
  // sits in the vertical midpoint of the space that previously held two rows.
  const SINGLE_OPTION_OFFSET_Y = discordHidden ? 12 : 0;

  const optionPanels = [];
  visibleOptions.forEach((option, index) => {
    const logicalIndex = options.indexOf(option);
    const baseRect = OPTION_RECTS[index];
    const rect = SINGLE_OPTION_OFFSET_Y
      ? { ...baseRect, y: baseRect.y + SINGLE_OPTION_OFFSET_Y }
      : baseRect;
    optionPanels.push(drawLoginOption(context, option, rect, {
      selected: logicalIndex === selectedIndex,
      authorizing,
      tileset,
      statusKey,
      t,
    }));
  });

  // No Discord-unavailable note rendered — the footer line already explains it.

  drawOpaquePanel(context, tileset, FOOTER_PANEL, OPTION_ACCENT);
  drawCenteredPixelText(
    context,
    t(discordHidden ? "entry.footerGuest" : "entry.footer"),
    Math.round(width / 2),
    167,
    { color: "#ffe3a3" },
  );
  context.restore();

  return {
    options: options.map((option) => ({ ...option })),
    selectedOptionId: options[selectedIndex].id,
    statusText,
    authorizing,
    background,
    optionRects: OPTION_RECTS.slice(0, visibleOptions.length).map((rect, i) =>
      i === 0 && SINGLE_OPTION_OFFSET_Y
        ? { ...rect, y: rect.y + SINGLE_OPTION_OFFSET_Y }
        : { ...rect },
    ),
    informationPanels: [SUBTITLE_PANEL, LANGUAGE_PANEL, ...optionPanels, FOOTER_PANEL]
      .map((panel) => ({ ...panel })),
  };
}

function drawLoginOption(context, option, rect, renderState = {}) {
  const { selected, authorizing, tileset, statusKey, t } = renderState;
  const disabled = option.disabled || authorizing;
  const fill = selected ? "#3a2d35" : "#211827";
  drawOpaquePanel(
    context,
    tileset,
    { ...rect, fill },
    OPTION_ACCENT,
  );

  if (selected) {
    drawPixelText(context, "▶", rect.x + 7, rect.y + 2, {
      color: disabled ? "#7b737f" : "#ffe3a3",
    });
  }
  const lineY = rect.y + 2;
  drawPixelText(context, option.label, rect.x + 20, lineY, {
    color: disabled ? "#8f8793" : selected ? "#fff0b3" : "#f7efd0",
  });
  const stateLabel = t(option.disabled ? "entry.option.unavailable" : "entry.option.available");
  const stateWidth = Math.ceil(context.measureText(stateLabel).width);
  drawPixelText(context, stateLabel, rect.x + rect.width - stateWidth - 8, lineY, {
    color: option.disabled ? "#8f8793" : "#a9c18e",
  });
  const detail = createOptionDetail(option, { selected, authorizing, statusKey, t });
  if (detail) {
    drawCenteredPixelText(context, detail, rect.x + rect.width / 2, rect.y + 12, {
      color: option.disabled ? "#8f8793" : authorizing ? "#71b7ff" : "#b7aeb9",
    });
  }
  return { id: `option-${option.id}`, ...rect, fill };
}

function createOptionDetail(option, { selected, authorizing, statusKey, t }) {
  if (option.disabled) return option.disabledReason;
  if (!selected) return null;
  if (authorizing) return t("entry.option.requesting");
  if (statusKey === "entry.status.authorizationFailedContinue") {
    return t("entry.option.authorizationFailed");
  }
  return null;
}

function drawOpaquePanel(context, tileset, panel, accent) {
  context.fillStyle = panel.fill;
  context.fillRect(
    Math.round(panel.x),
    Math.round(panel.y),
    Math.round(panel.width),
    Math.round(panel.height),
  );
  drawPixelPanel(context, { tileset, ...panel, accent });
}

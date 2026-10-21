# Branding Spec — Bounty Dungeon

## Requirements

- **Product name**: "Bounty Dungeon" everywhere. The Arc name must never appear in the product name, logo, favicon, HTML title, or aria-label.
- **Original mark**: A 16×15 pixel chest-sword-coin mark defined in `core/branding.js` as `LOGO_BLOCKS` + `LOGO_COLORS`. The same data generates both the Canvas rendering (`createBountyLogoMark`) and the SVG icon (`bounty-logo.svg`).
- **Arc mentions**: descriptive only ("built on Arc", "Built with Arc Studio"). Never in a product name or icon.
- **Non-affiliation disclaimer**: displayed in the RulesModal and in both README files: "Bounty Dungeon is an independent project built on Arc. It is not affiliated with, sponsored or endorsed by Circle or Arc."

## Shared mark data

`createBountyLogoMark(x, y, unit)` returns `{ kind: "bounty-chest-sword", parts: [...] }`. Each part has `x, y, width, height, role, color`. The SVG is generated from `createBountyLogoMark(0, 0, 1).parts` with integer coordinates.

## Hub wall sign

`guildBrand.shortLabel` ("BOUNTY") is used on the hub wall relief, not the full title.

## Onboarding / entry screen

`guildBrand.label` ("BOUNTY DUNGEON") is drawn at the entry lintel. Font size is chosen by fit: try candidates `[30, 20, 10]` (logoUnit ≥ 3) or `[20, 10]`; keep the first that fits the available width.

## Tiers / scenarios

| Scenario | Expected |
|---|---|
| `createBountyLogoMark(0,0,1)` | `kind === "bounty-chest-sword"`, all parts integer, inside 16×15 |
| hub branding | draws `guildBrand.shortLabel`; no "ARC" text |
| onboarding logoUnit 1.5/2/3 | draws "BOUNTY DUNGEON"; no "ARC" or "rialo" text |
| SVG rect count | equals `createBountyLogoMark(0,0,1).parts.length` |
| `createArcLogoMark` | undefined (not exported) |

# Proposal: Polish Round — Phone layout, onboarding, title screen

## Status: Done

## Summary

Pre-submission polish pass focused on phone usability and first-visit UX:

1. **Title screen** (game, render-only): hide Discord rows when no Discord client id is configured; re-centre the sole "Continue as Guest" option.
2. **Onboarding card**: on first visit to the Bounties tab, show a dismissible card explaining the mechanic. Dismissal persisted in `localStorage` key `bd.onboarding.v1`.
3. **Phone layout**: fractional pixel scale on phones that clear 1.25× threshold; keyboard notice below 768 px; drawer toggle moved to bottom-right so it clears the game canvas.
4. **pixelSurface**: fractional scale (≥ 1.25×) for small-but-not-tiny containers; backing pixel counts rounded to integers.

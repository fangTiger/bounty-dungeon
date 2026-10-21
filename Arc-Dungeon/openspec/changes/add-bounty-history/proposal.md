# Proposal: Bounty History, Leaderboard & Player Profiles

## Summary

Add a read-only history layer to the Bounty Dungeon web app: a chain-scanning API, panel tabs (History / Hunters), in-panel player profiles, and a participation-tier system. Inspired by The Beacon's companion site (explore/ranking page, past-events history, player profiles).

## Motivation

- Players have no way to see past bounties, who won, or the amounts paid out.
- There is no leaderboard or sense of community progression.
- Sharing a player profile requires exiting the app.

## Scope

- **API**: GET /api/history — scans DungeonBounty events from the deploy block, caches in-process, returns totals, bounty list, and player rankings. Production: Vercel serverless. Dev: Vite dev-server plugin.
- **Panel tabs**: "Bounties" (unchanged), "History" (completed bounties), "Hunters" (leaderboard).
- **Player profiles**: in-panel view with stats, tier, recent activity; deep-linkable via ?player=…&tab=hunters.
- **Participation tiers**: Recruit (1 pt), Hunter (3), Veteran (10), Legend (25); points = posted + won.
- **Mainnet support**: BOUNTY_DEPLOY_BLOCK env var (default testnet deploy block; set 26921133 for mainnet).
- **Approve→post latency fix**: removed awaited allowance re-read after approve receipt; approve toast added.
- **Title**: index.html updated to "Bounty Dungeon · ARC Dungeon on Arc" (network-neutral).

## Non-goals

- No new contract; no new keys or .env changes.
- History is read-only; no writes from the API.
- SIM_VERSION unchanged.

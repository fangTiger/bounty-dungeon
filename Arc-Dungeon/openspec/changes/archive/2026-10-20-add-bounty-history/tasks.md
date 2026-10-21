# Tasks: Bounty History, Leaderboard & Player Profiles

## Status: Done

- [x] Arc Mainnet DungeonBounty v3 deployment recorded in AGENTS.md
- [x] api/history.js — GET handler with in-process cache, 9 000-block chunks, pooled concurrency, block-timestamp cache, event decode, player aggregation, ranking
- [x] api/history.js — planChunks, aggregatePlayers, rankPlayers, participationTier exported as pure functions
- [x] vite.config.ts — GET /api/history mounted in dev-server plugin
- [x] src/bounty/useHistory.ts — hook with 60 s auto-refetch, manual refetch, abort on re-fetch
- [x] src/components/HistoryTab.tsx — totals line, newest-first completed bounty cards, explorer tx links, relative timestamps, address click → profile
- [x] src/components/HuntersTab.tsx — top 20 leaderboard ranked by USDC won / wins / earliest first win; tier badges; connected-wallet row pinned at bottom when not in top 20
- [x] src/components/PlayerProfile.tsx — stats grid, tier badge + progress, recent activity list, copy address/link, explorer link, back button
- [x] src/components/BountyPanel.tsx — tab row (Bounties | History | Hunters), URL sync via replaceState, "My profile" link, profile modal inside panel
- [x] Part 3: Arc-Dungeon/apps/web/index.html title updated to "Bounty Dungeon · ARC Dungeon on Arc"
- [x] Part 3: LastRun.tsx approve→post latency fix (no awaited allowance re-read; approve toast; confirmations: 1)
- [x] test/history-logic.test.js — planChunks, aggregatePlayers, rankPlayers, participationTier unit tests
- [x] OpenSpec docs added under openspec/changes/add-bounty-history/

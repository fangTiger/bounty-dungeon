# Design: History API, Paced Scanner & Participation Tiers

## History API (`Arc-Dungeon/api/history.js`)

Entry point: `GET /api/history`. Both the Vercel serverless function and the Vite dev-server plugin mount the same `handleHistory(query, env)` export.

### In-process cache

Each Vercel function instance maintains a module-level `_cache` object keyed by `chainId:contract`. It holds:
- `events`: decoded event objects (BountyPosted, BountyClaimed, BountyRefunded, ScoreAttested)
- `lastScannedBlock`: the highest block fully processed
- `blockTimestamps`: a Map from blockNumber → Unix timestamp
- `updatedAt`: ISO timestamp of the last successful scan

### Sequential paced scanner

`scanHistory(opts)` processes chunks **one at a time** in ascending block order (no parallelism). A `_pace(sleep)` wrapper enforces a minimum 340 ms between any two RPC calls (getLogs, eth_blockNumber, eth_getBlockByNumber). On HTTP 429 or network error the call is retried with 1 s / 2 s / 4 s / 8 s delays (5 attempts max). Both the `sleep` function and the `fetch` function are injectable for test isolation.

When the invocation budget (default 45 s, checked before each chunk) expires, `scanHistory` returns `{ complete: false, scannedTo, head }` with whatever events are cached so far. The caller returns HTTP 200 with this partial data; the next call automatically resumes from `scannedTo`.

`_cache.lastScannedBlock` is advanced only after each chunk fully completes, so an interrupted scan never loses progress.

### Decoding

All four events are decoded manually from `topics` + `data` hex words, using topic0 hashes computed at module load from the Solidity event signature strings via the vendored `noble-hashes` keccak_256. Indexed parameters come from topics[1..]; non-indexed come from data words in declaration order.

### Aggregation

`aggregatePlayers(events)` builds a per-address record by walking all events once. ScoreAttested credits the `player` field (not the poster). `rankPlayers(playerMap)` sorts by USDC won desc → wins desc → firstWinBlock asc, attaches tier badges.

## Participation Tiers

Tiers are point-based (not result-based). Points = posted + won. Thresholds: Recruit 1, Hunter 3, Veteran 10, Legend 25. The UI shows "N more to [NextTier]" on the profile view.

## Cache-Control strategy

`s-maxage=30` lets the CDN serve a cached response immediately for up to 30 s, while `stale-while-revalidate=86400` allows stale serving for 24 h while a background refresh is in flight. This means the first call after a cold function start returns partial data quickly; subsequent CDN-cached calls are instant.

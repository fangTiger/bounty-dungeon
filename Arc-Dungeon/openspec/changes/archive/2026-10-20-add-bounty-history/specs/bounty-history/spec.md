# Spec: Bounty History API, Leaderboard & Player Profiles

## Status: ADDED

---

## 1. History API — GET /api/history

### Requirements

- **REQ-H1**: The API scans `BountyPosted`, `BountyClaimed`, `BountyRefunded`, and `ScoreAttested` events from `BOUNTY_DEPLOY_BLOCK` to the chain head.
- **REQ-H2**: Scanning uses 9 000-block chunks (Arc public RPC rejects ranges larger than approximately 9 000 blocks with -32012). Chunks are fetched with pooled concurrency of up to 6.
- **REQ-H3**: Decoded events are cached in-process per `chainId:contract`. Subsequent calls only scan new blocks (incremental).
- **REQ-H4**: Block timestamps are fetched only for blocks that contain events, and are cached in-process.
- **REQ-H5**: Response includes `totals`, `bounties` (newest-first), and `players` (ranked).
- **REQ-H6**: Cache-Control header: `public, s-maxage=15, stale-while-revalidate=120`.
- **REQ-H7**: USDC amounts are decimal strings in base units (6 decimals).
- **REQ-H8**: Environment variables: `CHAIN_ID`, `BOUNTY_CONTRACT`, `BOUNTY_DEPLOY_BLOCK` (defaults: testnet chain/contract/block).

### Scenarios

**SC-H1**: First call on a fresh instance scans from `BOUNTY_DEPLOY_BLOCK` to head.
**SC-H2**: Second call within the same function instance only scans blocks since the last scanned block.
**SC-H3**: If a chunk fails with code -32012, it is split into two half-size chunks and retried.
**SC-H4**: A bounty with `deadline <= now` and `status === "open"` has `expired: true`.

---

## 2. Participation Tiers

### Requirements

- **REQ-T1**: Points = bounties posted + bounties won (claimed).
- **REQ-T2**: Tiers: none (0 pts), Recruit (1), Hunter (3), Veteran (10), Legend (25).
- **REQ-T3**: Player profile shows tier badge and "N more to [NextTier]" progress.

### Scenarios

**SC-T1**: A player with 0 points has tier "none".
**SC-T2**: A player with 2 points (1 posted, 1 won) has tier "Recruit" and needs 1 more for "Hunter".
**SC-T3**: A player with 25 points has tier "Legend" and "Max tier reached".

---

## 3. Panel Tabs

### Requirements

- **REQ-P1**: The panel has a compact tab row: Bounties | History | Hunters. Active tab is underlined in amber.
- **REQ-P2**: History tab shows totals (USDC paid out, total bounties) and newest-first cards for completed bounties (claimed, refunded, expired).
- **REQ-P3**: Hunters tab shows top 20 players ranked by USDC won desc, then wins desc, then earliest first win. Connected wallet row is highlighted; if not in top 20, pinned at the bottom.
- **REQ-P4**: Tab and profile state are reflected in the URL via `history.replaceState` (?tab=, ?player=). Opening the app with ?player=0x… goes straight to that profile.
- **REQ-P5**: Clicking any address anywhere in the panel opens the in-panel profile view.
- **REQ-P6**: "My profile" link appears in the wallet section header when a wallet is connected.

---

## 4. Player Profile

### Requirements

- **REQ-PP1**: Shows short address + copy + explorer link + "Copy link" button.
- **REQ-PP2**: Tier badge + progress to next tier.
- **REQ-PP3**: Stats grid: posted, won, USDC won, USDC posted, best attested score, points.
- **REQ-PP4**: Recent activity list (last 10 bounties participated in), with relative timestamps and explorer tx links.
- **REQ-PP5**: Back button closes the profile, returning to the previous tab.

---

## 5. Approve→Post Latency Fix

### Requirements

- **REQ-AP1**: After the approve receipt is confirmed (confirmations: 1), the `postBounty` transaction is sent immediately without awaiting an allowance re-read.
- **REQ-AP2**: A loading toast is shown during the approve step.
- **REQ-AP3**: The allowance is refreshed in the background (non-blocking) after approve, so the UI stays consistent on the next interaction.

---

## 6. Title

### Requirements

- **REQ-TL1**: `Arc-Dungeon/apps/web/index.html` `<title>` is "Bounty Dungeon · ARC Dungeon on Arc" (network-neutral).

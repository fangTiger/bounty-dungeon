# Spec: Bounty History API, Leaderboard & Player Profiles

## Status: FINAL (merged from add-bounty-history change, 2026-10-20)

---

## 1. History API — GET /api/history

### Requirements

- **REQ-H1**: Scans `BountyPosted`, `BountyClaimed`, `BountyRefunded`, `ScoreAttested` from `BOUNTY_DEPLOY_BLOCK` to head.
- **REQ-H2**: Chunks are ≤ 9 000 blocks (Arc public RPC -32012 limit), processed **sequentially one at a time**, paced at ≤ 3 requests/second (one request every ≥ 340 ms). On HTTP 429 or network error, retry up to 5 times with 1 s → 2 s → 4 s → 8 s backoff.
- **REQ-H3**: In-process cache per `chainId:contract`. Only new blocks scanned on subsequent calls (contiguous advancement).
- **REQ-H4**: Block timestamps fetched only for event-containing blocks; cached in-process. Timestamp fetches are also paced.
- **REQ-H5**: Response: `{ chainId, contract, scannedTo, head, complete, updatedAt, totals, bounties, players }`. `complete: false` + partial data returned when the per-invocation time budget (~45 s) is exhausted.
- **REQ-H6**: Cache-Control: `public, s-maxage=30, stale-while-revalidate=86400`.
- **REQ-H7**: Amounts as decimal strings in base units (6 decimals).
- **REQ-H8**: Env vars: `CHAIN_ID`, `BOUNTY_CONTRACT`, `BOUNTY_DEPLOY_BLOCK`, `HISTORY_RPC_URL` (optional dedicated RPC override).

### Scenarios

**SC-H1**: First call scans from deploy block to head.
**SC-H2**: Second call resumes from `scannedTo`; earlier chunks not re-fetched.
**SC-H3**: Budget exhausted mid-scan → 200 with `complete: false`; next call continues from `scannedTo`.
**SC-H4**: HTTP 429 → retry with backoff; succeeds after burst.
**SC-H5**: No more than 3 `getLogs` requests in any 1 s window (pacing).
**SC-H6**: Bounty with `deadline <= now` and `status === "open"` has `expired: true`.

---

## 2. Participation Tiers

### Requirements

- **REQ-T1**: Points = bounties posted + bounties won.
- **REQ-T2**: Tiers: none (0), Recruit (1+), Hunter (3+), Veteran (10+), Legend (25+).
- **REQ-T3**: Profile shows tier badge + "N more to [NextTier]" or "Max tier reached".

---

## 3. Panel Tabs (Bounties | History | Hunters)

### Requirements

- **REQ-P1**: Compact tab row under the wallet header; active tab underlined amber.
- **REQ-P2**: History: totals line (USDC paid out, bounty count), newest-first completed-bounty cards with relative timestamps, explorer tx links, address → profile.
- **REQ-P3**: Hunters: top 20 by USDC won / wins / earliest first win; tier badges; connected wallet highlighted; pinned at bottom if not in top 20.
- **REQ-P4**: URL sync via `history.replaceState` (?tab=, ?player=, ?bounty=).
- **REQ-P5**: ?bounty=<id>: if open → Bounties tab highlights card; if closed → History tab highlights card.
- **REQ-P6**: Deep-link highlight cleared when user explicitly changes tab or opens a profile.

---

## 4. Player Profile

- **REQ-PP1**: Short address + copy + explorer link + "Copy link" (?player=…).
- **REQ-PP2**: Tier badge + progress to next tier.
- **REQ-PP3**: Stats: posted, won, USDC won, USDC posted, best attested score, points.
- **REQ-PP4**: Recent activity (last 10), relative timestamps, tx links.
- **REQ-PP5**: Back button returns to prior tab.

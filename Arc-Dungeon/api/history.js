/**
 * GET /api/history
 *
 * Read-only onchain history scanner for DungeonBounty events.
 * Scans BountyPosted, BountyClaimed, BountyRefunded, ScoreAttested events
 * from the deploy block forward, using 9,000-block chunks (Arc public RPC
 * rejects ranges > ~9,000 blocks with -32012 "requested range too large").
 *
 * Keeps an in-process cache so subsequent calls only scan new blocks.
 *
 * Environment variables:
 *   CHAIN_ID            - integer chain id (default 5042002, Arc Testnet)
 *   BOUNTY_CONTRACT     - contract address
 *   BOUNTY_DEPLOY_BLOCK - block to start scanning from (default testnet v3)
 *
 * Response JSON:
 *   { chainId, contract, scannedTo, updatedAt, totals, bounties, players }
 *
 * Cache-Control: public, s-maxage=30, stale-while-revalidate=86400
 *
 * Rate limiting: Arc public RPC allows ~3 req/s sustained. Scanner runs
 * chunks strictly in order, one at a time, paced to ≤3 req/s (configurable).
 * On HTTP 429 or transient network error, retries with 1→2→4→8 s backoff
 * (max 5 tries). Time budget per invocation: 45 s (INVOKE_BUDGET_MS). When
 * the budget runs out the handler returns partial data with complete:false so
 * the CDN/client can serve stale while the next invocation resumes from where
 * the previous one stopped.
 *
 * Injectable clock/sleep: scanHistory accepts { now, sleep } overrides so
 * unit tests can run at wall-clock speed with a virtual clock.
 *
 * Optional env: HISTORY_RPC_URL — overrides the public RPC (plug in a
 * dedicated RPC later without redeploying).
 */

// Keccak-256 from the vendored noble-hashes (same copy used by api/verify.js)
import { keccak_256 } from "../apps/web/vendor/noble-hashes/sha3.js";

// RPC URLs keyed by chain ID — public Arc RPC endpoints, not secrets
const RPC_URLS = {
  5042002: "https://rpc.testnet.arc.io", // arc-studio-allow-onchain-literal
  5042:    "https://rpc.mainnet.arc.io",  // arc-studio-allow-onchain-literal
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_CHAIN_ID    = 5042002;
const DEFAULT_CONTRACT    = "0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4"; // arc-studio-allow-onchain-literal
const DEFAULT_DEPLOY_BLOCK = 67857284; // Arc Testnet v3 deploy block
const CHUNK_SIZE          = 9000;      // max range Arc public RPC accepts
const MIN_REQ_INTERVAL_MS = 340;       // ~3 req/s sustained (340ms between requests)
const MAX_RETRIES         = 5;
const INVOKE_BUDGET_MS    = 45_000;    // return partial after this many ms

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---------------------------------------------------------------------------
// Pure aggregate helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Plan chunk ranges from startBlock to endBlock inclusive, CHUNK_SIZE at most.
 * Returns [{from, to}] — always at least one entry.
 */
export function planChunks(startBlock, endBlock, chunkSize = CHUNK_SIZE) {
  if (endBlock < startBlock) return [];
  const chunks = [];
  for (let from = startBlock; from <= endBlock; from += chunkSize) {
    chunks.push({ from, to: Math.min(from + chunkSize - 1, endBlock) });
  }
  return chunks;
}

/**
 * Tier from participation points (posted + won).
 * Returns "none" | "Recruit" | "Hunter" | "Veteran" | "Legend"
 */
export function participationTier(points) {
  if (points >= 25) return "Legend";
  if (points >= 10) return "Veteran";
  if (points >= 3)  return "Hunter";
  if (points >= 1)  return "Recruit";
  return "none";
}

/**
 * Aggregate player stats from a list of decoded events.
 * events: [{ type, bountyId, poster, claimer, amount, score, blockNumber, txHash }]
 * Returns Map<address, player>
 */
export function aggregatePlayers(events) {
  const players = new Map();

  function getPlayer(addr) {
    const a = addr.toLowerCase();
    if (!players.has(a)) {
      players.set(a, {
        address: addr,
        posted: 0,
        won: 0,
        refunded: 0,
        usdcPosted: 0n,
        usdcWon: 0n,
        bestScore: 0,
        firstWinBlock: null,
      });
    }
    return players.get(a);
  }

  for (const ev of events) {
    if (ev.type === "BountyPosted") {
      const p = getPlayer(ev.poster);
      p.posted++;
      p.usdcPosted += BigInt(ev.amount);
    } else if (ev.type === "BountyClaimed") {
      const p = getPlayer(ev.claimer);
      p.won++;
      p.usdcWon += BigInt(ev.amount);
      if (ev.score > p.bestScore) p.bestScore = ev.score;
      if (p.firstWinBlock === null || ev.blockNumber < p.firstWinBlock) {
        p.firstWinBlock = ev.blockNumber;
      }
    } else if (ev.type === "BountyRefunded") {
      const p = getPlayer(ev.poster);
      p.refunded++;
    } else if (ev.type === "ScoreAttested") {
      const p = getPlayer(ev.player);
      if (ev.score > p.bestScore) p.bestScore = ev.score;
    }
  }

  return players;
}

/**
 * Rank players: desc usdcWon, then desc won, then asc firstWinBlock.
 * Attaches points and tier. Returns sorted array.
 */
export function rankPlayers(playerMap) {
  return [...playerMap.values()]
    .map((p) => ({
      address: p.address,
      posted: p.posted,
      won: p.won,
      refunded: p.refunded,
      usdcPosted: String(p.usdcPosted),
      usdcWon: String(p.usdcWon),
      bestScore: p.bestScore,
      points: p.posted + p.won,
      tier: participationTier(p.posted + p.won),
      firstWinBlock: p.firstWinBlock,
    }))
    .sort((a, b) => {
      const usdcDiff = BigInt(b.usdcWon) - BigInt(a.usdcWon);
      if (usdcDiff !== 0n) return usdcDiff > 0n ? 1 : -1;
      if (b.won !== a.won) return b.won - a.won;
      // earliest first win comes first (lower block number)
      const ab = a.firstWinBlock ?? Infinity;
      const bb = b.firstWinBlock ?? Infinity;
      return ab - bb;
    });
}

// ---------------------------------------------------------------------------
// Event topic hashes — computed at module load from the exact Solidity
// event signatures using the same keccak_256 vendored in the game source.
// Real values verified against Arc mainnet logs (test/history-topics.test.js).
// ---------------------------------------------------------------------------

function keccakHex(str) {
  const bytes = new TextEncoder().encode(str);
  const hash  = keccak_256(bytes);
  return "0x" + Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Event signature strings — must match contracts/DungeonBounty.sol exactly
export const SIG_BOUNTY_POSTED    = "BountyPosted(uint256,address,bytes32,uint64,uint256,uint256)";
export const SIG_BOUNTY_CLAIMED   = "BountyClaimed(uint256,address,uint64)";
export const SIG_BOUNTY_REFUNDED  = "BountyRefunded(uint256,address,uint256)";
export const SIG_SCORE_ATTESTED   = "ScoreAttested(uint256,address,bytes32,uint64,bytes32)";

// Computed — verified against mainnet logs in test/history-topics.test.js
export const TOPIC_BOUNTY_POSTED   = keccakHex(SIG_BOUNTY_POSTED);
export const TOPIC_BOUNTY_CLAIMED  = keccakHex(SIG_BOUNTY_CLAIMED);
export const TOPIC_BOUNTY_REFUNDED = keccakHex(SIG_BOUNTY_REFUNDED);
export const TOPIC_SCORE_ATTESTED  = keccakHex(SIG_SCORE_ATTESTED);

// ---------------------------------------------------------------------------
// Data layout (non-indexed args, in declaration order):
// BountyPosted:   seed(bytes32), target(uint64), amount(uint256), deadline(uint256)
// BountyClaimed:  score(uint64)
// BountyRefunded: amount(uint256)
// ScoreAttested:  seed(bytes32), score(uint64), runId(bytes32)

// ---------------------------------------------------------------------------
// Tiny ABI decode helpers (no external deps)
// ---------------------------------------------------------------------------
// All we need: decode topics (indexed) and data (non-indexed) for our 4 events.
// Topics are already 32-byte hex strings. Data is ABI-encoded non-indexed args.

function decodeAddress(hex32) {
  return "0x" + hex32.slice(26); // last 20 bytes of 32-byte slot
}
function decodeUint256(hex32) {
  return BigInt("0x" + hex32.slice(2));
}
function decodeUint64(hex32) {
  return Number(BigInt("0x" + hex32.slice(2)));
}
function decodeBytes32(hex32) {
  return hex32; // already 0x + 64 hex
}

/**
 * Decode non-indexed data words (each 32 bytes).
 * dataHex: "0x" + N*64 hex chars
 */
function dataWords(dataHex) {
  const raw = dataHex.slice(2);
  const words = [];
  for (let i = 0; i < raw.length; i += 64) {
    words.push("0x" + raw.slice(i, i + 64));
  }
  return words;
}

export function decodeLog(log) {
  const topic0 = log.topics[0]?.toLowerCase();

  if (topic0 === TOPIC_BOUNTY_POSTED) {
    // indexed: bountyId(uint256), poster(address)
    // data:    seed(bytes32), target(uint64), amount(uint256), deadline(uint256)
    const words = dataWords(log.data);
    return {
      type:     "BountyPosted",
      bountyId: Number(decodeUint256(log.topics[1])),
      poster:   decodeAddress(log.topics[2]),
      seed:     decodeBytes32(words[0]),
      target:   decodeUint64(words[1]),
      amount:   String(decodeUint256(words[2])),
      deadline: Number(decodeUint256(words[3])),
    };
  }

  if (topic0 === TOPIC_BOUNTY_CLAIMED) {
    // indexed: bountyId(uint256), claimer(address)
    // data:    score(uint64)
    const words = dataWords(log.data);
    return {
      type:     "BountyClaimed",
      bountyId: Number(decodeUint256(log.topics[1])),
      claimer:  decodeAddress(log.topics[2]),
      score:    decodeUint64(words[0]),
    };
  }

  if (topic0 === TOPIC_BOUNTY_REFUNDED) {
    // indexed: bountyId(uint256), poster(address)
    // data:    amount(uint256)
    const words = dataWords(log.data);
    return {
      type:     "BountyRefunded",
      bountyId: Number(decodeUint256(log.topics[1])),
      poster:   decodeAddress(log.topics[2]),
      amount:   String(decodeUint256(words[0])),
    };
  }

  if (topic0 === TOPIC_SCORE_ATTESTED) {
    // indexed: bountyId(uint256), player(address)
    // data:    seed(bytes32), score(uint64), runId(bytes32)
    const words = dataWords(log.data);
    return {
      type:     "ScoreAttested",
      bountyId: Number(decodeUint256(log.topics[1])),
      player:   decodeAddress(log.topics[2]),
      seed:     decodeBytes32(words[0]),
      score:    decodeUint64(words[1]),
      runId:    decodeBytes32(words[2]),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client with retry + pacing
// ---------------------------------------------------------------------------

/**
 * Make a single JSON-RPC call with exponential-backoff retry on 429 or
 * transient errors. Injectable sleep/now for tests.
 */
async function rpcCall(rpcUrl, method, params, { sleep = defaultSleep, fetch: fetchFn = globalThis.fetch } = {}) {
  let delay = 1000;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (networkErr) {
      // Network error — retry with backoff
      if (attempt === MAX_RETRIES - 1) throw networkErr;
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
      continue;
    }

    if (res.status === 429) {
      if (attempt === MAX_RETRIES - 1) throw new Error("RPC HTTP 429: rate limited");
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
      continue;
    }

    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message ?? "RPC error");
      err.code = json.error.code;
      throw err;
    }
    return json.result;
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getBlockNumber(rpcUrl, opts) {
  const hex = await rpcCall(rpcUrl, "eth_blockNumber", [], opts);
  return Number(BigInt(hex));
}

async function getBlockTimestamp(rpcUrl, blockHex, opts) {
  const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [blockHex, false], opts);
  return block ? Number(BigInt(block.timestamp)) : null;
}

/** Fetch all logs in [fromBlock, toBlock] matching one of our topics. */
async function getLogs(rpcUrl, contractAddr, fromBlock, toBlock, opts) {
  return rpcCall(rpcUrl, "eth_getLogs", [{
    address: contractAddr,
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock:   "0x" + toBlock.toString(16),
    topics: [[
      TOPIC_BOUNTY_POSTED,
      TOPIC_BOUNTY_CLAIMED,
      TOPIC_BOUNTY_REFUNDED,
      TOPIC_SCORE_ATTESTED,
    ]],
  }], opts);
}

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------
const _cache = new Map(); // key = `${chainId}:${contract}`

// ---------------------------------------------------------------------------
// Core scanner
//
// Processes chunks STRICTLY IN ORDER, one at a time, paced to MIN_REQ_INTERVAL_MS
// between RPC calls. Advances the cache contiguously so progress is never lost.
// Returns early when invokeBudgetMs is exhausted, with complete: false.
// ---------------------------------------------------------------------------
export async function scanHistory(rpcUrl, contract, deployBlock, env, {
  now   = () => Date.now(),
  sleep = defaultSleep,
  fetch: fetchFn = globalThis.fetch,
  invoiceBudgetMs = INVOKE_BUDGET_MS, // alias kept for compat
  invokeBudgetMs  = INVOKE_BUDGET_MS,
} = {}) {
  const budget = invokeBudgetMs ?? invoiceBudgetMs;
  const cacheKey = `${env.CHAIN_ID ?? DEFAULT_CHAIN_ID}:${contract.toLowerCase()}`;
  const cached = _cache.get(cacheKey) ?? {
    events: [],
    blockTimestamps: {},
    lastScannedBlock: deployBlock - 1,
  };

  const opts = { sleep, fetch: fetchFn };
  const deadline = now() + budget;

  const head = await getBlockNumber(rpcUrl, opts);
  const startBlock = cached.lastScannedBlock + 1;

  let complete = startBlock > head;

  if (!complete) {
    const chunks = planChunks(startBlock, head);
    let lastReqTime = 0; // wall-clock ms of last RPC call

    for (const { from, to } of chunks) {
      // Time-budget check
      if (now() >= deadline) { complete = false; break; }

      // Pace to ≤ 3 req/s
      const elapsed = now() - lastReqTime;
      if (elapsed < MIN_REQ_INTERVAL_MS) await sleep(MIN_REQ_INTERVAL_MS - elapsed);

      lastReqTime = now();
      let logs;
      try {
        logs = await getLogs(rpcUrl, contract, from, to, opts);
      } catch (err) {
        if (err.code === -32012) {
          // Range too large — split in half, each half paced separately
          const mid = Math.floor((from + to) / 2);

          if (now() >= deadline) { complete = false; break; }
          const elapsed2 = now() - lastReqTime;
          if (elapsed2 < MIN_REQ_INTERVAL_MS) await sleep(MIN_REQ_INTERVAL_MS - elapsed2);
          lastReqTime = now();
          const logsA = await getLogs(rpcUrl, contract, from, mid, opts);

          if (now() >= deadline) {
            // Commit the first half then stop
            appendLogs(logsA, cached, null);
            cached.lastScannedBlock = mid;
            complete = false; break;
          }
          const elapsed3 = now() - lastReqTime;
          if (elapsed3 < MIN_REQ_INTERVAL_MS) await sleep(MIN_REQ_INTERVAL_MS - elapsed3);
          lastReqTime = now();
          const logsB = await getLogs(rpcUrl, contract, mid + 1, to, opts);
          logs = [...logsA, ...logsB];
        } else {
          throw err;
        }
      }

      appendLogs(logs, cached, null);
      cached.lastScannedBlock = to; // advance contiguously after each chunk

      // Fetch timestamps for newly seen blocks, paced
      const blocksNeeded = new Set();
      for (const log of logs) {
        const bn = Number(BigInt(log.blockNumber));
        if (!(bn in cached.blockTimestamps)) blocksNeeded.add(bn);
      }
      for (const bn of blocksNeeded) {
        if (now() >= deadline) break;
        const elapsed4 = now() - lastReqTime;
        if (elapsed4 < MIN_REQ_INTERVAL_MS) await sleep(MIN_REQ_INTERVAL_MS - elapsed4);
        lastReqTime = now();
        const ts = await getBlockTimestamp(rpcUrl, "0x" + bn.toString(16), opts);
        if (ts !== null) cached.blockTimestamps[bn] = ts;
      }

      // Back-fill timestamps onto already-appended events from this chunk
      for (const ev of cached.events) {
        if (ev.timestamp === null && ev.blockNumber in cached.blockTimestamps) {
          ev.timestamp = cached.blockTimestamps[ev.blockNumber];
        }
      }

      complete = (to === head || to >= head);
    }

    // Final sort
    cached.events.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });
  }

  _cache.set(cacheKey, cached);
  return { events: cached.events, scannedTo: cached.lastScannedBlock, head, complete };
}

/** Append decoded logs to the cache (timestamps resolved later). */
function appendLogs(logs, cached, _blockTimestamps) {
  for (const log of logs) {
    const decoded = decodeLog(log);
    if (!decoded) continue;
    decoded.blockNumber = Number(BigInt(log.blockNumber));
    decoded.txHash = log.transactionHash;
    decoded.logIndex = log.logIndex != null ? Number(BigInt(log.logIndex)) : 0;
    decoded.timestamp = cached.blockTimestamps[decoded.blockNumber] ?? null;
    cached.events.push(decoded);
  }
}

// ---------------------------------------------------------------------------
// Build response from events
// ---------------------------------------------------------------------------
export function buildResponse(chainId, contract, events, scannedTo) {
  // Build bounty map from events (most fields from BountyPosted)
  const bountyMap = new Map();

  for (const ev of events) {
    if (ev.type === "BountyPosted") {
      bountyMap.set(ev.bountyId, {
        id: ev.bountyId,
        poster: ev.poster,
        seed: ev.seed,
        target: String(ev.target),
        amount: ev.amount,
        deadline: ev.deadline,
        status: "open",
        expired: false,
        postTx: ev.txHash,
        postTime: ev.timestamp,
        claimer: null,
        claimScore: null,
        claimTx: null,
        claimTime: null,
        refundTx: null,
        refundTime: null,
      });
    } else if (ev.type === "BountyClaimed") {
      const b = bountyMap.get(ev.bountyId);
      if (b) {
        b.status = "claimed";
        b.claimer = ev.claimer;
        b.claimScore = String(ev.score);
        b.claimTx = ev.txHash;
        b.claimTime = ev.timestamp;
      }
    } else if (ev.type === "BountyRefunded") {
      const b = bountyMap.get(ev.bountyId);
      if (b) {
        b.status = "refunded";
        b.refundTx = ev.txHash;
        b.refundTime = ev.timestamp;
      }
    }
  }

  // Mark expired (deadline passed, still open)
  const nowSec = Math.floor(Date.now() / 1000);
  for (const b of bountyMap.values()) {
    if (b.status === "open" && b.deadline <= nowSec) {
      b.expired = true;
    }
  }

  const bountiesArr = [...bountyMap.values()].sort((a, b) => b.id - a.id);

  // Attach claimAmount for aggregation (from BountyClaimed events)
  const claimAmounts = new Map();
  for (const ev of events) {
    if (ev.type === "BountyClaimed") {
      const b = bountyMap.get(ev.bountyId);
      if (b) claimAmounts.set(ev.bountyId, b.amount);
    }
  }

  // Build enriched events for player aggregation
  const enrichedEvents = events.map((ev) => {
    if (ev.type === "BountyClaimed") {
      return { ...ev, amount: claimAmounts.get(ev.bountyId) ?? "0" };
    }
    if (ev.type === "BountyRefunded") {
      return { ...ev, poster: bountyMap.get(ev.bountyId)?.poster ?? ev.poster };
    }
    if (ev.type === "ScoreAttested") {
      // player is already set on the event; pass through unchanged
      return ev;
    }
    return ev;
  });

  const playerMap = aggregatePlayers(enrichedEvents);
  const players = rankPlayers(playerMap);

  // Totals
  let totalUsdcPosted = 0n;
  let totalUsdcPaidOut = 0n;
  let claimed = 0, refunded = 0, open = 0;
  for (const b of bountiesArr) {
    totalUsdcPosted += BigInt(b.amount);
    if (b.status === "claimed") { claimed++; totalUsdcPaidOut += BigInt(b.amount); }
    else if (b.status === "refunded") { refunded++; }
    else { open++; }
  }

  return {
    chainId,
    contract,
    scannedTo,
    updatedAt: Date.now(),
    totals: {
      bounties: bountiesArr.length,
      claimed,
      refunded,
      open,
      usdcPosted: String(totalUsdcPosted),
      usdcPaidOut: String(totalUsdcPaidOut),
    },
    bounties: bountiesArr,
    players,
  };
}

// ---------------------------------------------------------------------------
// Core handler — exported for tests
// ---------------------------------------------------------------------------
export async function handleHistory(query, env = {}, scanOpts = {}) {
  const chainId     = parseInt(env.CHAIN_ID ?? String(DEFAULT_CHAIN_ID), 10);
  const contract    = (env.BOUNTY_CONTRACT ?? DEFAULT_CONTRACT).toLowerCase();
  const deployBlock = parseInt(env.BOUNTY_DEPLOY_BLOCK ?? String(DEFAULT_DEPLOY_BLOCK), 10);

  // Resolve RPC URL — env override > chain table > error
  const rpcUrl = env.HISTORY_RPC_URL ?? RPC_URLS[chainId];
  if (!rpcUrl) {
    return { status: 500, body: { error: `No RPC URL for chain ${chainId}` } };
  }

  try {
    const { events, scannedTo, head, complete } = await scanHistory(
      rpcUrl, contract, deployBlock, env, scanOpts,
    );
    const response = buildResponse(chainId, contract, events, scannedTo);
    response.complete = complete;
    response.head = head;
    return { status: 200, body: response };
  } catch (err) {
    return { status: 500, body: { error: String(err?.message ?? err) } };
  }
}

// ---------------------------------------------------------------------------
// Vercel serverless export
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.status(204).end();
  }
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=86400");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { status, body } = await handleHistory(req.query ?? {}, process.env);
  return res.status(status).json(body);
}

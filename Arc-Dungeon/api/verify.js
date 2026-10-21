/**
 * POST /api/verify
 *
 * Vercel Node serverless function.  Validates a bounty-run package, replays
 * it server-side using the game's own headlessRunner (never duplicates sim
 * logic), then signs an EIP-712 RunResult with VERIFIER_PRIVATE_KEY.
 *
 * Environment variables (set in Vercel dashboard — never committed):
 *   VERIFIER_PRIVATE_KEY   - 0x-prefixed 32-byte secp256k1 private key
 *   CHAIN_ID               - integer chain id (default 5042002, Arc Testnet)
 *   BOUNTY_CONTRACT        - deployed DungeonBounty contract address
 *
 * Request  (POST, JSON):
 *   { player: address, package: RunPackageV2 }
 *
 * Response 200:
 *   { runResult, signature, chainId, contract, replayMismatch }
 *
 * Errors: 400 (bad input), 422 (replay invalid), 503 (key missing).
 */

// ---------------------------------------------------------------------------
// Shared imports from the game's own source tree.
// ---------------------------------------------------------------------------
import { runBountyReplay } from "../apps/web/src/core/simulation/headlessRunner.js";
import { SIM_VERSION } from "../apps/web/src/core/simulation/dungeonSim.js";
import { keccak_256 } from "../apps/web/vendor/noble-hashes/sha3.js";
import { bytesToHex } from "../apps/web/vendor/noble-hashes/utils.js";

// viem for address handling, ABI encoding, EIP-712 signing
import {
  getAddress,
  isAddress,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const KNOWN_CLASSES = new Set(["knight", "wizzard"]);
const MAX_REPLAY_BYTES = 256 * 1024; // 256 KB decoded limit

const DEFAULT_CHAIN_ID = 5042002;
// Default contract is the v3 DungeonBounty on Arc Testnet. Override via BOUNTY_CONTRACT env var.
const DEFAULT_CONTRACT = "0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4"; // arc-studio-allow-onchain-literal

// EIP-712 typed-data descriptors (must match the contract exactly)
const DOMAIN_TYPE = [
  { name: "name",              type: "string"  },
  { name: "version",           type: "string"  },
  { name: "chainId",           type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const RUN_RESULT_TYPE = [
  { name: "player",     type: "address" },
  { name: "seed",       type: "bytes32" },
  { name: "score",      type: "uint64"  },
  { name: "replayHash", type: "bytes32" },
  { name: "runId",      type: "bytes32" },
];

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** base64 → Uint8Array using Node's Buffer (no browser btoa). */
function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * runId = keccak256(abi.encode(address player, bytes32 seed, bytes32 replayHash))
 * This mirrors the Solidity: keccak256(abi.encode(run.player, run.seed, run.replayHash))
 */
function computeRunId(player, seed, replayHash) {
  const encoded = encodeAbiParameters(
    parseAbiParameters("address, bytes32, bytes32"),
    [player, seed, replayHash],
  );
  return keccak256(encoded);
}

/** Sign the EIP-712 RunResult struct. */
async function signRunResult({ account, chainId, contract, runResult }) {
  const domain = {
    name:              "DungeonBounty",
    version:           "1",
    chainId:           BigInt(chainId),
    verifyingContract: contract,
  };
  const types = { RunResult: RUN_RESULT_TYPE };
  const message = {
    player:     runResult.player,
    seed:       runResult.seed,
    score:      BigInt(runResult.score),  // uint64 in contract
    replayHash: runResult.replayHash,
    runId:      runResult.runId,
  };
  return account.signTypedData({ domain, types, primaryType: "RunResult", message });
}

// ---------------------------------------------------------------------------
// Core handler — exported for test use without the Vercel request wrapper
// ---------------------------------------------------------------------------
/**
 * @param {{ player: string, package: object }} body
 * @param {{ VERIFIER_PRIVATE_KEY?: string, CHAIN_ID?: string, BOUNTY_CONTRACT?: string }} env
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleVerify(body, env = {}) {
  const chainId  = parseInt(env.CHAIN_ID ?? String(DEFAULT_CHAIN_ID), 10);
  const contract = getAddress(env.BOUNTY_CONTRACT ?? DEFAULT_CONTRACT);

  // 1. Private key — return 503 if absent (not a client error)
  const rawKey = env.VERIFIER_PRIVATE_KEY;
  if (!rawKey) {
    return { status: 503, body: { error: "Verifier key not configured" } };
  }
  const account = privateKeyToAccount(rawKey);

  // 2. Player address
  if (!body?.player || !isAddress(body.player)) {
    return { status: 400, body: { error: "player must be a valid EVM address" } };
  }
  const player = getAddress(body.player);

  // 3. Package shape checks
  const pkg = body?.package;
  if (!pkg || typeof pkg !== "object") {
    return { status: 400, body: { error: "package is required" } };
  }

  if (pkg.v !== 2) {
    return { status: 400, body: { error: `package.v must be 2, got ${pkg.v}` } };
  }
  if (pkg.simVersion !== SIM_VERSION) {
    return {
      status: 422,
      body: { error: `simVersion mismatch: server expects ${SIM_VERSION}, got ${pkg.simVersion}` },
    };
  }

  if (typeof pkg.seed !== "string" || !/^0x[0-9a-f]{64}$/.test(pkg.seed)) {
    return { status: 400, body: { error: "package.seed must be 0x + 64 lowercase hex chars" } };
  }
  const seed = pkg.seed;

  if (!KNOWN_CLASSES.has(pkg.heroClass)) {
    return {
      status: 400,
      body: { error: `package.heroClass must be one of: ${[...KNOWN_CLASSES].join(", ")}` },
    };
  }
  const heroClass = pkg.heroClass;

  if (typeof pkg.replay !== "string") {
    return { status: 400, body: { error: "package.replay must be a base64 string" } };
  }
  let replayBytes;
  try {
    replayBytes = base64ToBytes(pkg.replay);
  } catch {
    return { status: 400, body: { error: "package.replay is not valid base64" } };
  }
  if (replayBytes.length > MAX_REPLAY_BYTES) {
    return {
      status: 400,
      body: { error: `Replay too large: ${replayBytes.length} bytes (max ${MAX_REPLAY_BYTES})` },
    };
  }

  if (typeof pkg.replayHash !== "string") {
    return { status: 400, body: { error: "package.replayHash is required" } };
  }
  const expectedHash = "0x" + bytesToHex(keccak_256(replayBytes));
  if (expectedHash !== pkg.replayHash) {
    return { status: 422, body: { error: "replayHash does not match keccak256(replay bytes)" } };
  }
  const replayHash = pkg.replayHash;

  // 4. Server-side replay
  let replayResult;
  try {
    replayResult = runBountyReplay({ seed, heroClass, gameVersion: "verify", replayBytes });
  } catch (err) {
    return { status: 422, body: { error: `Replay execution failed: ${err?.message ?? err}` } };
  }

  const VALID_REASONS = new Set(["death", "evacuated", "timeLimit"]);
  if (!VALID_REASONS.has(replayResult.settlementReason)) {
    return {
      status: 422,
      body: {
        error: `Run did not settle properly: settlementReason=${replayResult.settlementReason}`,
      },
    };
  }

  // Score from server replay only — never trust pkg.result
  const score = replayResult.dailyScore ?? 0;

  const replayMismatch =
    typeof pkg.result?.score === "number" && pkg.result.score !== score
      ? { clientScore: pkg.result.score, serverScore: score }
      : null;

  // 5. Compute runId and build RunResult
  const runId = computeRunId(player, seed, replayHash);
  const runResult = {
    player,
    seed,
    score: String(score),  // string to avoid JSON precision loss for large uint64
    replayHash,
    runId,
  };

  // 6. EIP-712 sign
  const signature = await signRunResult({ account, chainId, contract, runResult });

  return {
    status: 200,
    body: { runResult, signature, chainId, contract, replayMismatch },
  };
}

// ---------------------------------------------------------------------------
// Vercel serverless export (req/res style)
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.status(204).end();
  }

  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const { status, body: responseBody } = await handleVerify(body, process.env);
  return res.status(status).json(responseBody);
}

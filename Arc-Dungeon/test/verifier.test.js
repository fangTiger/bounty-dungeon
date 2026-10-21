/**
 * verifier.test.js
 *
 * Tests for api/verify.js handleVerify():
 *   - domain separator vector (matches on-chain value)
 *   - full happy path: recordRun → build package → handleVerify → recover signer
 *   - rejection cases: bad replayHash, incomplete run, wrong simVersion, bad seed,
 *     bad address, oversize replay, missing key (503)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/src");
const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/vendor");

// Game modules
const { recordRun } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
const { SIM_VERSION } = await import(`${ROOT}/core/simulation/dungeonSim.js`);
const { keccak_256 } = await import(`${VENDOR}/noble-hashes/sha3.js`);
const { bytesToHex } = await import(`${VENDOR}/noble-hashes/utils.js`);

// Verifier handler
const { handleVerify } = await import(`../api/verify.js`);

// viem utilities for recovery
const {
  recoverTypedDataAddress,
  hashTypedData,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  getAddress,
} = await import("viem");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");

// ---------------------------------------------------------------------------
// Stable test fixtures
// ---------------------------------------------------------------------------
const SEED       = "0x4be1cc855dfeacd0e7778c8d8d83fc826b6942ea35f872eebf01c8da0e3945ef";
const HERO       = "knight";
const PLAYER     = "0xb65C38313bB2aF4c1346E416939658718FE729c4"; // arbitrary valid address

// Random throwaway key — generated fresh per test run
const TEST_KEY    = generatePrivateKey();
const TEST_ACCT   = privateKeyToAccount(TEST_KEY);
const TEST_ENV    = { VERIFIER_PRIVATE_KEY: TEST_KEY };

// Contract constants matching the deployed v3
const CHAIN_ID   = 5042002;
// arc-studio-allow-onchain-literal
const CONTRACT   = "0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4";

// EIP-712 domain + types (mirrors api/verify.js)
const DOMAIN = {
  name:              "DungeonBounty",
  version:           "1",
  chainId:           BigInt(CHAIN_ID),
  verifyingContract: CONTRACT,
};
const RUN_RESULT_TYPE = {
  RunResult: [
    { name: "player",     type: "address" },
    { name: "seed",       type: "bytes32" },
    { name: "score",      type: "uint64"  },
    { name: "replayHash", type: "bytes32" },
    { name: "runId",      type: "bytes32" },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uint8ToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function buildPackage(replayBytes, result) {
  const replayHash = "0x" + bytesToHex(keccak_256(replayBytes));
  return {
    v:          2,
    simVersion: SIM_VERSION,
    seed:       SEED,
    heroClass:  HERO,
    ticks:      result.ticks ?? 0,
    replay:     uint8ToBase64(replayBytes),
    replayHash,
    result: {
      score:            result.dailyScore ?? 0,
      settlementReason: result.settlementReason,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Domain separator vector
// ---------------------------------------------------------------------------
describe("domain separator", () => {
  it("matches the on-chain value 0x21b93e639ce7b9eac25611766471fe9da3a5b426c54f420090b2317f061c3060", () => {
    // Compute via viem hashTypedData with an empty message
    // The domain separator is the first 32 bytes of the EIP-712 encoding.
    // We compute it directly:
    const domainSeparator = hashTypedData({
      domain: DOMAIN,
      types:  RUN_RESULT_TYPE,
      primaryType: "RunResult",
      message: {
        player:     "0x0000000000000000000000000000000000000000",
        seed:       "0x0000000000000000000000000000000000000000000000000000000000000000",
        score:      0n,
        replayHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        runId:      "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
    // The domain separator is not the full hash; we need to extract it.
    // The EIP-712 encoding is: \x19\x01 ++ domainSep ++ structHash.
    // The easiest cross-check is to compute the domain separator directly
    // as keccak256(encodeAbiParameters(domainType, domainValues)):
    const DOMAIN_TYPE_HASH = keccak256(
      Buffer.from(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        "utf8",
      ),
    );
    const encodedDomain = encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        DOMAIN_TYPE_HASH,
        keccak256(Buffer.from("DungeonBounty", "utf8")),
        keccak256(Buffer.from("1", "utf8")),
        BigInt(CHAIN_ID),
        CONTRACT,
      ],
    );
    const domainSep = keccak256(encodedDomain);
    assert.equal(
      domainSep,
      "0x21b93e639ce7b9eac25611766471fe9da3a5b426c54f420090b2317f061c3060",
      `Domain separator mismatch: got ${domainSep}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Full happy path
// ---------------------------------------------------------------------------
describe("handleVerify — happy path", () => {
  it("signs a valid run and the signer recovers to the key address", async () => {
    // Produce a real run with recordRun (produces death settlement)
    const { result, replayBytes } = recordRun({
      seed: SEED, heroClass: HERO,
      script: [{ ticks: 5, wasPressed: { confirm: true } }, { ticks: 300 }],
    });

    const pkg = buildPackage(replayBytes, result);
    const body = { player: PLAYER, package: pkg };

    const { status, body: resp } = await handleVerify(body, TEST_ENV);
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(resp)}`);

    // Recover signer
    const { runResult, signature } = resp;
    const recovered = await recoverTypedDataAddress({
      domain:      DOMAIN,
      types:       RUN_RESULT_TYPE,
      primaryType: "RunResult",
      message: {
        player:     runResult.player,
        seed:       runResult.seed,
        score:      BigInt(runResult.score),
        replayHash: runResult.replayHash,
        runId:      runResult.runId,
      },
      signature,
    });
    assert.equal(
      recovered.toLowerCase(),
      TEST_ACCT.address.toLowerCase(),
      "Recovered address does not match signing key",
    );

    // Score must come from the server replay, not from the package
    // (they may differ since recordRun does not use runBountyReplay)
    assert.equal(typeof runResult.score, "string", "score should be a string");
    assert.ok(Number(runResult.score) >= 0, "score must be non-negative");
  });

  it("score in response equals runBountyReplay score for the same run", async () => {
    const { runBountyReplay } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
    const { result, replayBytes } = recordRun({
      seed: SEED, heroClass: HERO,
      script: [{ ticks: 5, wasPressed: { confirm: true } }, { ticks: 300 }],
    });
    const pkg = buildPackage(replayBytes, result);
    const { status, body: resp } = await handleVerify({ player: PLAYER, package: pkg }, TEST_ENV);
    assert.equal(status, 200);
    const replayResult = runBountyReplay({ seed: SEED, heroClass: HERO, replayBytes });
    assert.equal(Number(resp.runResult.score), replayResult.dailyScore ?? 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Rejection cases
// ---------------------------------------------------------------------------
describe("handleVerify — rejections", () => {
  async function run(body, env = TEST_ENV) {
    return handleVerify(body, env);
  }

  // Helper: build a valid base body
  async function validBase() {
    const { result, replayBytes } = recordRun({
      seed: SEED, heroClass: HERO,
      script: [{ ticks: 5, wasPressed: { confirm: true } }, { ticks: 300 }],
    });
    return { pkg: buildPackage(replayBytes, result), replayBytes };
  }

  it("503 when VERIFIER_PRIVATE_KEY is missing", async () => {
    const { pkg } = await validBase();
    const { status, body } = await run({ player: PLAYER, package: pkg }, {});
    assert.equal(status, 503);
    assert.match(body.error, /key/i);
  });

  it("400 for invalid player address", async () => {
    const { pkg } = await validBase();
    const { status } = await run({ player: "not-an-address", package: pkg });
    assert.equal(status, 400);
  });

  it("400 for bad seed (not 0x + 64 hex)", async () => {
    const { pkg } = await validBase();
    const { status, body } = await run({ player: PLAYER, package: { ...pkg, seed: "short" } });
    assert.equal(status, 400);
    assert.match(body.error, /seed/i);
  });

  it("400 for bad seed (uppercase hex — rejected by regex)", async () => {
    const { pkg } = await validBase();
    const badSeed = SEED.toUpperCase(); // uppercase not allowed
    const { status } = await run({ player: PLAYER, package: { ...pkg, seed: badSeed } });
    assert.equal(status, 400);
  });

  it("422 for wrong simVersion", async () => {
    const { pkg } = await validBase();
    const { status } = await run({
      player: PLAYER,
      package: { ...pkg, simVersion: "99" },
    });
    assert.equal(status, 422);
  });

  it("422 for bad replayHash (tampered)", async () => {
    const { pkg } = await validBase();
    const { status } = await run({
      player: PLAYER,
      package: { ...pkg, replayHash: "0x" + "aa".repeat(32) },
    });
    assert.equal(status, 422);
  });

  it("400 for oversize replay (> 256 KB)", async () => {
    const { pkg } = await validBase();
    // Build a > 256 KB base64 blob
    const oversizeBytes = new Uint8Array(256 * 1024 + 1);
    const oversizeB64   = Buffer.from(oversizeBytes).toString("base64");
    // Recompute hash so it passes hash check (it won't — hash check comes first)
    const hash = "0x" + bytesToHex(keccak_256(oversizeBytes));
    const { status } = await run({
      player:  PLAYER,
      package: { ...pkg, replay: oversizeB64, replayHash: hash },
    });
    assert.equal(status, 400);
  });

  it("422 for incomplete run (replay too short to settle)", async () => {
    // 1-tick replay — player does not die
    const { recordRun: rr } = await import(`${ROOT}/core/simulation/headlessRunner.js`);
    const { replayBytes } = rr({
      seed: SEED, heroClass: HERO,
      script: [{ ticks: 1 }],
      maxTicks: 1,
    });
    const replayHash = "0x" + bytesToHex(keccak_256(replayBytes));
    const pkg = {
      v: 2, simVersion: SIM_VERSION, seed: SEED, heroClass: HERO,
      ticks: 1, replay: uint8ToBase64(replayBytes), replayHash,
      result: { score: 0, settlementReason: "incomplete" },
    };
    const { status, body } = await run({ player: PLAYER, package: pkg });
    assert.equal(status, 422);
    assert.match(body.error, /settle/i);
  });
});

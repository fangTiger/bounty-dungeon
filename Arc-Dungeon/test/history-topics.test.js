/**
 * test/history-topics.test.js
 *
 * 1. Asserts that the computed topic0 hashes match the verified mainnet values.
 * 2. Decodes the four real mainnet logs from bounty #1 (post, 2x attest, claim)
 *    end-to-end through decodeLog → buildResponse and checks poster, claimer,
 *    amounts, scores, and totals.
 *
 * No network calls; all data is from real mainnet logs pasted verbatim.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const {
  TOPIC_BOUNTY_POSTED,
  TOPIC_BOUNTY_CLAIMED,
  TOPIC_BOUNTY_REFUNDED,
  TOPIC_SCORE_ATTESTED,
  decodeLog,
  buildResponse,
} = await import(`${ROOT}/api/history.js`);

// ---------------------------------------------------------------------------
// 1. Verified topic0 hashes (from Arc mainnet logs)
// ---------------------------------------------------------------------------
describe("event topic hashes", () => {
  it("BountyPosted topic0 matches mainnet", () => {
    assert.equal(
      TOPIC_BOUNTY_POSTED,
      "0x734b94fd869d3c2ad8f45344715fe4991c8e7ca4df07459d5867a1dec4646c23",
    );
  });

  it("BountyClaimed topic0 matches mainnet", () => {
    assert.equal(
      TOPIC_BOUNTY_CLAIMED,
      "0xf17a1aed6097d4b0eacf636edafcaa34b334a8437688cbcebbc50729b787ef6f",
    );
  });

  it("BountyRefunded topic0 matches mainnet", () => {
    assert.equal(
      TOPIC_BOUNTY_REFUNDED,
      "0xf1ed347f033f54c0d6f1589c933d81b4256cf2f72a785106e3653a565f7433a2",
    );
  });

  it("ScoreAttested topic0 matches mainnet", () => {
    assert.equal(
      TOPIC_SCORE_ATTESTED,
      "0x31cb9d250e07a0173d0049058f28080a215c95bee25ab5c71215431fde7a03e7",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Real mainnet logs — bounty #1 lifecycle
// ---------------------------------------------------------------------------
// Poster: 0xcbd446461c305def344599fe4d1818a95c3a2473 (lower-cased from topics)
// Claimer: 0x2c67cced14015c3e957d6b61c2671e2a8b944ae2
// amount: 0x2710 = 10000 (base units, 6-dec → 0.01 USDC)
// poster target: 0x1924a = 102986
// claimer score: 0x1924c = 102988

const POSTER  = "0xcbd446461c305def344599fe4d1818a95c3a2473";
const CLAIMER = "0x2c67cced14015c3e957d6b61c2671e2a8b944ae2";

const RAW_LOGS = [
  // BountyPosted — bounty #1, logIndex 0x4
  {
    blockNumber: "0x19ac9dd",
    transactionHash: "0x00ec01d09d1054be2dd16f4156ee0039439d44171550b777bacead4b99a93c6a",
    logIndex: "0x4",
    topics: [
      "0x734b94fd869d3c2ad8f45344715fe4991c8e7ca4df07459d5867a1dec4646c23",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x000000000000000000000000cbd446461c305def344599fe4d1818a95c3a2473",
    ],
    data: "0xf342aed5d70ca36159d6dbc8075aeb09493754cb71d02a26fbf53938389dc9a7000000000000000000000000000000000000000000000000000000000001924a0000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000006ad884e6",
  },
  // ScoreAttested — poster's run, same tx as post
  {
    blockNumber: "0x19ac9dd",
    transactionHash: "0x00ec01d09d1054be2dd16f4156ee0039439d44171550b777bacead4b99a93c6a",
    logIndex: "0x5",
    topics: [
      "0x31cb9d250e07a0173d0049058f28080a215c95bee25ab5c71215431fde7a03e7",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x000000000000000000000000cbd446461c305def344599fe4d1818a95c3a2473",
    ],
    data: "0xf342aed5d70ca36159d6dbc8075aeb09493754cb71d02a26fbf53938389dc9a7000000000000000000000000000000000000000000000000000000000001924a1e2564f217d70e6bddc3dc183d45dd8ae6c7d0cab3fd134f953b921fe9b71f9f",
  },
  // BountyClaimed — claimer claims bounty #1
  {
    blockNumber: "0x19acbbb",
    transactionHash: "0x4be71262bf36c908c388fbc19ed3254da545b23a678da10c95f57884e769d01f",
    logIndex: "0x3",
    topics: [
      "0xf17a1aed6097d4b0eacf636edafcaa34b334a8437688cbcebbc50729b787ef6f",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000002c67cced14015c3e957d6b61c2671e2a8b944ae2",
    ],
    data: "0x000000000000000000000000000000000000000000000000000000000001924c",
  },
  // ScoreAttested — claimer's run
  {
    blockNumber: "0x19acbbb",
    transactionHash: "0x4be71262bf36c908c388fbc19ed3254da545b23a678da10c95f57884e769d01f",
    logIndex: "0x4",
    topics: [
      "0x31cb9d250e07a0173d0049058f28080a215c95bee25ab5c71215431fde7a03e7",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000002c67cced14015c3e957d6b61c2671e2a8b944ae2",
    ],
    data: "0xf342aed5d70ca36159d6dbc8075aeb09493754cb71d02a26fbf53938389dc9a7000000000000000000000000000000000000000000000000000000000001924c7393425c8a164f9a474b9e84a903c609de5570d4ce5dda19b2d64c51f4f9d1ce",
  },
];

// Enrich with blockNumber+logIndex for sorting (matches scanHistory output)
const EVENTS = RAW_LOGS.map((log) => {
  const decoded = decodeLog(log);
  if (!decoded) throw new Error(`Failed to decode log ${log.logIndex}`);
  decoded.blockNumber = Number(BigInt(log.blockNumber));
  decoded.txHash = log.transactionHash;
  decoded.timestamp = null;
  decoded.logIndex = Number(BigInt(log.logIndex));
  return decoded;
});

describe("decodeLog — real mainnet logs", () => {
  it("BountyPosted: bountyId=1, poster, seed, target, amount", () => {
    const ev = EVENTS[0];
    assert.equal(ev.type, "BountyPosted");
    assert.equal(ev.bountyId, 1);
    assert.equal(ev.poster.toLowerCase(), POSTER);
    assert.equal(ev.target, 102986);      // 0x1924a
    assert.equal(ev.amount, "10000");     // 0x2710
  });

  it("BountyPosted: deadline is a positive integer", () => {
    const ev = EVENTS[0];
    assert.ok(ev.deadline > 0, "deadline should be positive");
  });

  it("ScoreAttested (poster): player=poster, score=target", () => {
    const ev = EVENTS[1];
    assert.equal(ev.type, "ScoreAttested");
    assert.equal(ev.player.toLowerCase(), POSTER);
    assert.equal(ev.score, 102986);
  });

  it("BountyClaimed: bountyId=1, claimer, score=102988", () => {
    const ev = EVENTS[2];
    assert.equal(ev.type, "BountyClaimed");
    assert.equal(ev.bountyId, 1);
    assert.equal(ev.claimer.toLowerCase(), CLAIMER);
    assert.equal(ev.score, 102988);       // 0x1924c
  });

  it("ScoreAttested (claimer): player=claimer, score=102988", () => {
    const ev = EVENTS[3];
    assert.equal(ev.type, "ScoreAttested");
    assert.equal(ev.player.toLowerCase(), CLAIMER);
    assert.equal(ev.score, 102988);
  });
});

describe("buildResponse — end-to-end from mainnet logs", () => {
  const CONTRACT = "0x53b8512e4124089c88aab379c64cb8dc05b344ba";
  // Attach claim amount from the bounty's posted amount (done by buildResponse internals)
  const resp = buildResponse(5042, CONTRACT, EVENTS, 0x19acbbb);

  it("totals.usdcPaidOut = '10000'", () => {
    assert.equal(resp.totals.usdcPaidOut, "10000");
  });

  it("totals.claimed = 1", () => {
    assert.equal(resp.totals.claimed, 1);
  });

  it("bounty #1 claimer and claimScore", () => {
    const b = resp.bounties.find((b) => b.id === 1);
    assert.ok(b, "bounty #1 should be present");
    assert.equal(b?.claimer?.toLowerCase(), CLAIMER);
    assert.equal(b?.claimScore, "102988");
  });

  it("poster bestScore = 102986 (from ScoreAttested)", () => {
    const p = resp.players.find((p) => p.address.toLowerCase() === POSTER);
    assert.ok(p, "poster should be in players");
    assert.equal(p?.bestScore, 102986);
  });

  it("claimer bestScore = 102988 (from ScoreAttested, not BountyClaimed)", () => {
    const p = resp.players.find((p) => p.address.toLowerCase() === CLAIMER);
    assert.ok(p, "claimer should be in players");
    assert.equal(p?.bestScore, 102988);
  });

  it("claimer usdcWon = '10000'", () => {
    const p = resp.players.find((p) => p.address.toLowerCase() === CLAIMER);
    assert.equal(p?.usdcWon, "10000");
  });
});

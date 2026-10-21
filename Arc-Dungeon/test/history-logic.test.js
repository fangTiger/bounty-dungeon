/**
 * test/history-logic.test.js
 *
 * Unit tests for the pure functions exported by api/history.js:
 *   planChunks, participationTier, aggregatePlayers, rankPlayers
 *
 * No network calls; no RPC mock needed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const { planChunks, participationTier, aggregatePlayers, rankPlayers } =
  await import(`${ROOT}/api/history.js`);

// ---------------------------------------------------------------------------
// planChunks
// ---------------------------------------------------------------------------
describe("planChunks", () => {
  it("single chunk when range fits", () => {
    const chunks = planChunks(100, 200, 9000);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { from: 100, to: 200 });
  });

  it("splits into multiple chunks", () => {
    const chunks = planChunks(0, 17999, 9000);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[0], { from: 0, to: 8999 });
    assert.deepEqual(chunks[1], { from: 9000, to: 17999 });
  });

  it("last chunk is clipped to endBlock", () => {
    const chunks = planChunks(0, 9500, 9000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1].to, 9500);
  });

  it("empty array when startBlock > endBlock", () => {
    assert.deepEqual(planChunks(500, 100), []);
  });

  it("single block range produces one chunk", () => {
    const chunks = planChunks(42, 42, 9000);
    assert.deepEqual(chunks, [{ from: 42, to: 42 }]);
  });

  it("chunk size boundary: from + chunkSize - 1 = to exactly", () => {
    const chunks = planChunks(0, 8999, 9000);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { from: 0, to: 8999 });
  });

  it("three chunks", () => {
    const chunks = planChunks(0, 26999, 9000);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[2].from, 18000);
    assert.equal(chunks[2].to, 26999);
  });
});

// ---------------------------------------------------------------------------
// participationTier
// ---------------------------------------------------------------------------
describe("participationTier", () => {
  it("0 points → none", () => assert.equal(participationTier(0), "none"));
  it("1 point → Recruit", () => assert.equal(participationTier(1), "Recruit"));
  it("2 points → Recruit", () => assert.equal(participationTier(2), "Recruit"));
  it("3 points → Hunter", () => assert.equal(participationTier(3), "Hunter"));
  it("9 points → Hunter", () => assert.equal(participationTier(9), "Hunter"));
  it("10 points → Veteran", () => assert.equal(participationTier(10), "Veteran"));
  it("24 points → Veteran", () => assert.equal(participationTier(24), "Veteran"));
  it("25 points → Legend", () => assert.equal(participationTier(25), "Legend"));
  it("100 points → Legend", () => assert.equal(participationTier(100), "Legend"));
});

// ---------------------------------------------------------------------------
// aggregatePlayers
// ---------------------------------------------------------------------------
describe("aggregatePlayers", () => {
  const ALICE = "0xAAAA000000000000000000000000000000000001";
  const BOB   = "0xBBBB000000000000000000000000000000000002";
  const CAROL = "0xCCCC000000000000000000000000000000000003";

  const fixture = [
    { type: "BountyPosted",   bountyId: 1, poster: ALICE, amount: "100000",  blockNumber: 100, txHash: "0xabc1" },
    { type: "BountyPosted",   bountyId: 2, poster: BOB,   amount: "200000",  blockNumber: 101, txHash: "0xabc2" },
    { type: "BountyClaimed",  bountyId: 1, claimer: BOB,  amount: "100000",  score: 50000, blockNumber: 110, txHash: "0xabc3" },
    { type: "BountyRefunded", bountyId: 2, poster: BOB,   blockNumber: 120, txHash: "0xabc4" },
    // ScoreAttested uses `player`, not `poster`
    { type: "ScoreAttested",  bountyId: 1, player: ALICE, score: 75000, blockNumber: 115, txHash: "0xabc5" },
    { type: "BountyPosted",   bountyId: 3, poster: CAROL, amount: "50000",   blockNumber: 130, txHash: "0xabc6" },
    { type: "BountyClaimed",  bountyId: 3, claimer: CAROL, amount: "50000",  score: 90000, blockNumber: 140, txHash: "0xabc7" },
  ];

  it("counts posted correctly", () => {
    const m = aggregatePlayers(fixture);
    assert.equal(m.get(ALICE.toLowerCase())?.posted, 1);
    assert.equal(m.get(BOB.toLowerCase())?.posted, 1);
    assert.equal(m.get(CAROL.toLowerCase())?.posted, 1);
  });

  it("counts won correctly", () => {
    const m = aggregatePlayers(fixture);
    assert.equal(m.get(BOB.toLowerCase())?.won, 1);
    assert.equal(m.get(CAROL.toLowerCase())?.won, 1);
    assert.equal(m.get(ALICE.toLowerCase())?.won, 0);
  });

  it("counts refunded correctly", () => {
    const m = aggregatePlayers(fixture);
    assert.equal(m.get(BOB.toLowerCase())?.refunded, 1);
    assert.equal(m.get(ALICE.toLowerCase())?.refunded, 0);
  });

  it("sums usdcPosted correctly", () => {
    const m = aggregatePlayers(fixture);
    assert.equal(String(m.get(BOB.toLowerCase())?.usdcPosted), "200000");
  });

  it("sums usdcWon correctly", () => {
    const m = aggregatePlayers(fixture);
    assert.equal(String(m.get(BOB.toLowerCase())?.usdcWon), "100000");
    assert.equal(String(m.get(CAROL.toLowerCase())?.usdcWon), "50000");
  });

  it("bestScore from BountyClaimed", () => {
    const m = aggregatePlayers(fixture);
    assert.equal(m.get(BOB.toLowerCase())?.bestScore, 50000);
    assert.equal(m.get(CAROL.toLowerCase())?.bestScore, 90000);
  });

  it("bestScore updated by ScoreAttested", () => {
    const m = aggregatePlayers(fixture);
    // ALICE had ScoreAttested with score 75000
    assert.equal(m.get(ALICE.toLowerCase())?.bestScore, 75000);
  });

  it("firstWinBlock set to earliest claim block", () => {
    const m = aggregatePlayers([
      { type: "BountyClaimed", bountyId: 5, claimer: BOB, amount: "1", score: 1, blockNumber: 200, txHash: "0x1" },
      { type: "BountyClaimed", bountyId: 6, claimer: BOB, amount: "1", score: 2, blockNumber: 150, txHash: "0x2" },
    ]);
    assert.equal(m.get(BOB.toLowerCase())?.firstWinBlock, 150);
  });
});

// ---------------------------------------------------------------------------
// rankPlayers
// ---------------------------------------------------------------------------
describe("rankPlayers", () => {
  const A = "0xAAAA000000000000000000000000000000000001";
  const B = "0xBBBB000000000000000000000000000000000002";
  const C = "0xCCCC000000000000000000000000000000000003";

  it("ranks by usdcWon desc", () => {
    const events = [
      { type: "BountyPosted", bountyId: 1, poster: A, amount: "300000", blockNumber: 1, txHash: "0x1" },
      { type: "BountyClaimed", bountyId: 1, claimer: A, amount: "300000", score: 1, blockNumber: 2, txHash: "0x2" },
      { type: "BountyPosted", bountyId: 2, poster: B, amount: "100000", blockNumber: 3, txHash: "0x3" },
      { type: "BountyClaimed", bountyId: 2, claimer: B, amount: "100000", score: 1, blockNumber: 4, txHash: "0x4" },
    ];
    const map = aggregatePlayers(events);
    const ranked = rankPlayers(map);
    assert.equal(ranked[0].address.toLowerCase(), A.toLowerCase());
    assert.equal(ranked[1].address.toLowerCase(), B.toLowerCase());
  });

  it("tiebreak by wins desc when usdcWon equal", () => {
    const events = [
      { type: "BountyClaimed", bountyId: 1, claimer: A, amount: "100000", score: 1, blockNumber: 10, txHash: "0x1" },
      { type: "BountyClaimed", bountyId: 2, claimer: A, amount: "100000", score: 1, blockNumber: 20, txHash: "0x2" },
      { type: "BountyClaimed", bountyId: 3, claimer: B, amount: "200000", score: 1, blockNumber: 5,  txHash: "0x3" },
    ];
    // A: 200000 won, 2 wins. B: 200000 won, 1 win. A should rank higher.
    const ranked = rankPlayers(aggregatePlayers(events));
    assert.equal(ranked[0].address.toLowerCase(), A.toLowerCase());
  });

  it("tier attached correctly", () => {
    const events = [
      { type: "BountyPosted", bountyId: 1, poster: C, amount: "1", blockNumber: 1, txHash: "0x1" },
      { type: "BountyPosted", bountyId: 2, poster: C, amount: "1", blockNumber: 2, txHash: "0x2" },
    ];
    const ranked = rankPlayers(aggregatePlayers(events));
    const c = ranked.find((p) => p.address.toLowerCase() === C.toLowerCase());
    assert.ok(c, "C should be in ranked list");
    // 2 points → Recruit
    assert.equal(c.tier, "Recruit");
    assert.equal(c.points, 2);
  });

  it("points = posted + won", () => {
    const events = [
      { type: "BountyPosted",  bountyId: 1, poster: A, amount: "1", blockNumber: 1, txHash: "0x1" },
      { type: "BountyClaimed", bountyId: 1, claimer: A, amount: "1", score: 1, blockNumber: 2, txHash: "0x2" },
    ];
    const ranked = rankPlayers(aggregatePlayers(events));
    assert.equal(ranked[0].points, 2); // 1 posted + 1 won
  });
});

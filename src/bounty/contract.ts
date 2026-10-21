/**
 * src/bounty/contract.ts
 * Single source of truth for DungeonBounty v3 contract config.
 * ABI is sourced directly from the Foundry artifact.
 */

export { ACTIVE_BOUNTY_ADDRESS as BOUNTY_ADDRESS } from "./network";

export const VERIFIER_URL =
  (import.meta.env.VITE_VERIFIER_URL as string | undefined) ?? "/api/verify";

/** Must match SIM_VERSION in dungeonSim.js. Bump here when bumped there. */
export const CURRENT_SIM_VERSION = "2";

/** Minimal ERC-20 ABI for allowance + approve */
export const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

/** DungeonBounty v3 ABI — taken verbatim from contracts/out/DungeonBounty.sol/DungeonBounty.json */
export const BOUNTY_ABI = [
  { type: "function", name: "bountyCount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "bounties", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "poster", type: "address" }, { name: "seed", type: "bytes32" }, { name: "target", type: "uint64" }, { name: "amount", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "status", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "minAmount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "maxAmount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "verifierActiveAt", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "usdc", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "postBounty", inputs: [{ name: "myRun", type: "tuple", components: [{ name: "player", type: "address" }, { name: "seed", type: "bytes32" }, { name: "score", type: "uint64" }, { name: "replayHash", type: "bytes32" }, { name: "runId", type: "bytes32" }] }, { name: "sig", type: "bytes" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "claimBounty", inputs: [{ name: "bountyId", type: "uint256" }, { name: "run", type: "tuple", components: [{ name: "player", type: "address" }, { name: "seed", type: "bytes32" }, { name: "score", type: "uint64" }, { name: "replayHash", type: "bytes32" }, { name: "runId", type: "bytes32" }] }, { name: "sig", type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "refund", inputs: [{ name: "bountyId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "error", name: "AmountOutOfRange", inputs: [] },
  { type: "error", name: "BountyExpired", inputs: [] },
  { type: "error", name: "BountyNotOpen", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "RunIdAlreadyUsed", inputs: [] },
  { type: "error", name: "ScoreNotHighEnough", inputs: [] },
  { type: "error", name: "SelfClaim", inputs: [] },
  { type: "error", name: "VerifierRotationPending", inputs: [] },
  { type: "error", name: "WrongSeed", inputs: [] },
  { type: "error", name: "DeadlineNotPassed", inputs: [] },
] as const;

/** BountyStatus enum values from the contract */
export const BountyStatus = { Open: 0, Claimed: 1, Refunded: 2 } as const;

/** Decode a contract revert or wallet error into a plain English sentence. */
export function decodeContractError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const matchers: [RegExp, string][] = [
    // Contract custom errors
    [/WrongSeed/, "This run was played on a different seed than the bounty requires."],
    [/ScoreNotHighEnough/, "Your score doesn't beat the bounty's target score."],
    [/BountyExpired/, "This bounty has already expired."],
    [/BountyNotOpen/, "This bounty is no longer open (already claimed or refunded)."],
    [/SelfClaim/, "You posted this bounty — you can't claim your own."],
    [/AmountOutOfRange/, "The wager amount must be between the contract's min and max."],
    [/VerifierRotationPending/, "A verifier rotation is pending — new bounties are paused."],
    [/InvalidSignature/, "The verifier signature is invalid."],
    [/RunIdAlreadyUsed/, "This replay has already been used to claim a bounty."],
    [/DeadlineNotPassed/, "The deadline hasn't passed yet — the bounty can't be refunded yet."],
    // ERC-20 reverts
    [/ERC20InsufficientBalance|insufficient balance/i, "Your USDC balance is too low."],
    [/ERC20InsufficientAllowance|insufficient allowance/i, "Allowance too low — approve USDC first."],
    // Wallet / user rejections
    [/user rejected|User rejected|4001/, "You rejected the wallet request."],
    [/UserRejectedRequest/, "You rejected the wallet request."],
  ];
  for (const [re, text] of matchers) {
    if (re.test(msg)) return text;
  }
  // Surface verifier HTTP errors (e.g. "verifier: Score mismatch")
  const verifierMatch = msg.match(/verifier[:\s]+(.+)/i);
  if (verifierMatch) return verifierMatch[1];
  return msg.slice(0, 120);
}

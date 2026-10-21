/**
 * src/bounty/network.ts
 * Single source of truth for which Arc network the app targets.
 *
 * Set VITE_ARC_NETWORK="mainnet" to switch to Arc mainnet.
 * Default is "testnet".
 *
 * Arc mainnet and Arc testnet both ship as named exports in viem/chains
 * (arc and arcTestnet), so no defineChain is needed.
 *
 * All values (chain IDs, RPC URLs, explorer URLs, USDC addresses) come from
 * @/onchain-facts — the Arc Studio generated registry — not from typed
 * literals here.
 */

import { arc, arcTestnet } from "viem/chains";
import { getUsdc, buildTxExplorerUrl, requireChain } from "@/onchain-facts";

const isMainnet =
  (import.meta.env.VITE_ARC_NETWORK as string | undefined) === "mainnet";

// ---------- chain -----------------------------------------------------------
export const ACTIVE_CHAIN = isMainnet ? arc : arcTestnet;

// ---------- bounty contract address ----------------------------------------
// Testnet: fixed default from the last Studio deploy.
// Mainnet: MUST be provided via VITE_BOUNTY_ADDRESS; missing = unconfigured.
const TESTNET_BOUNTY =
  "0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4" as const; // arc-studio-allow-onchain-literal

const _mainnetBounty = import.meta.env.VITE_BOUNTY_ADDRESS as
  | `0x${string}`
  | undefined;

/** True when mainnet is selected but VITE_BOUNTY_ADDRESS is not set. */
export const BOUNTY_UNCONFIGURED = isMainnet && !_mainnetBounty;

export const ACTIVE_BOUNTY_ADDRESS: `0x${string}` = isMainnet
  ? (_mainnetBounty ?? "0x0000000000000000000000000000000000000000")
  : TESTNET_BOUNTY;

// ---------- USDC ERC-20 address ---------------------------------------------
// Both Arc mainnet and Arc testnet use the same USDC predeploy address
// (0x3600000000000000000000000000000000000000), read from the facts registry.
const _usdcFact = getUsdc(ACTIVE_CHAIN.id);
export const USDC_ADDRESS = _usdcFact?.address as `0x${string}` | undefined;

// ---------- display helpers -------------------------------------------------
const _chainFact = requireChain(ACTIVE_CHAIN.id);
export const NETWORK_LABEL = isMainnet ? "Arc Mainnet" : "Arc Testnet";
export const EXPLORER_URL = _chainFact.explorerBase;

/** Build a full explorer URL for a tx hash. */
export function explorerTxUrl(txHash: string): string {
  return buildTxExplorerUrl(ACTIVE_CHAIN.id, txHash);
}

/**
 * src/bounty/useBounties.ts
 * Reads all bounties from DungeonBounty v3 via wagmi multicall.
 */

import { useReadContracts } from "wagmi";
import { useCallback } from "react";
import { BOUNTY_ABI, BountyStatus } from "./contract";
import { ACTIVE_CHAIN, ACTIVE_BOUNTY_ADDRESS as BOUNTY_ADDRESS } from "./network";

// Module-level stable reference — avoids react/purity in component render
const getNow: () => number = Date.now.bind(Date);

const BOUNTY_COUNT_CONTRACT = {
  address: BOUNTY_ADDRESS,
  abi: BOUNTY_ABI,
  chainId: ACTIVE_CHAIN.id,
} as const;

export interface OnchainBounty {
  id: number;
  poster: string;
  seed: string;       // bytes32 hex
  target: bigint;
  amount: bigint;
  deadline: bigint;
  status: number;
  isOpen: boolean;
  isExpired: boolean; // deadline passed but still Open
}

/** Read bountyCount, then all bounties(i) in one multicall. */
export function useBounties() {
  const { data: countData, refetch: refetchCount } = useReadContracts({
    contracts: [{ ...BOUNTY_COUNT_CONTRACT, functionName: "bountyCount" }],
  });

  const count = Number(countData?.[0]?.result ?? 0n);

  const bountyContracts = Array.from({ length: count }, (_, i) => ({
    ...BOUNTY_COUNT_CONTRACT,
    functionName: "bounties" as const,
    args: [BigInt(i + 1)] as const,
  }));

  const { data: bountiesData, refetch: refetchBounties } = useReadContracts({
    contracts: bountyContracts,
    query: { enabled: count > 0 },
  });

  const bounties: OnchainBounty[] = (bountiesData ?? [])
    .map((item, i) => {
      const r = item.result as [string, string, bigint, bigint, bigint, number] | undefined;
      if (!r) return null;
      const [poster, seed, target, amount, deadline, status] = r;
      const nowSec = BigInt(Math.floor(getNow() / 1000));
      return {
        id: i + 1,
        poster,
        seed,
        target,
        amount,
        deadline,
        status,
        isOpen: status === BountyStatus.Open,
        isExpired: status === BountyStatus.Open && deadline <= nowSec,
      } satisfies OnchainBounty;
    })
    .filter((b): b is OnchainBounty => b !== null);

  // useCallback so the identity is stable across renders — prevents infinite
  // re-fire in effects that depend on `refetch`.
  const refetch = useCallback(() => {
    void refetchCount();
    void refetchBounties();
  }, [refetchCount, refetchBounties]);

  return { bounties, refetch };
}

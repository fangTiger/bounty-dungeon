/**
 * src/components/OpenBounties.tsx
 * Lists all Open bounties from DungeonBounty v3.
 * - Challenge: sends seed to iframe.
 * - Refund: awaits receipt in handler (no isSuccess effect → no loop).
 * - Shows "Your bounty" when connected wallet is the poster.
 */

import { useState, useCallback } from "react";
import { useAccount, useConfig } from "wagmi";
import { useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { toast } from "sonner";
import { formatUsdc } from "@/onchain-money";
import { BOUNTY_ABI, decodeContractError } from "@/bounty/contract";
import { ACTIVE_BOUNTY_ADDRESS as BOUNTY_ADDRESS, explorerTxUrl } from "@/bounty/network";
import type { OnchainBounty } from "@/bounty/useBounties";

function getBountyLink(id: number): string {
  return `${window.location.origin}${window.location.pathname}?bounty=${id}`;
}

async function shareBounty(b: OnchainBounty) {
  const link = getBountyLink(b.id);
  const text = `Beat my ${b.target.toLocaleString()} pts in Bounty Dungeon on Arc and take ${formatUsdc(b.amount)} USDC`;
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(text + " " + link)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Bounty Dungeon", text, url: link });
      return;
    } catch {
      // fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    toast.success("Link copied!", { description: link, duration: 3000 });
  } catch {
    window.open(xUrl, "_blank", "noopener,noreferrer");
  }
}

interface Props {
  bounties: OnchainBounty[];
  refetch: () => void;
  challengeId: number | null;
  highlightId?: number | null;
  onChallenge: (bountyId: number, seed: string) => void;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function shortSeed(seed: string) {
  return seed.slice(0, 10) + "…";
}

function formatTimeLeft(deadlineSec: bigint): string {
  const left = Number(deadlineSec) - Math.floor(Date.now() / 1000);
  if (left <= 0) return "Expired";
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function OpenBounties({ bounties, refetch, challengeId, highlightId, onChallenge, iframeRef }: Props) {
  const { address } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  // Track per-bounty refund pending state by id
  const [refundingId, setRefundingId] = useState<number | null>(null);

  const openBounties = bounties.filter((b) => b.isOpen);

  const handleChallenge = useCallback(
    (b: OnchainBounty) => {
      onChallenge(b.id, b.seed);
      iframeRef.current?.contentWindow?.postMessage(
        { type: "arc-dungeon:start", seed: b.seed },
        "*",
      );
    },
    [onChallenge, iframeRef],
  );

  const handleRefund = useCallback(
    async (b: OnchainBounty) => {
      setRefundingId(b.id);
      try {
        const tx = await writeContractAsync({
          address: BOUNTY_ADDRESS,
          abi: BOUNTY_ABI,
          functionName: "refund",
          args: [BigInt(b.id)],
        });
        const receipt = await waitForTransactionReceipt(config, { hash: tx });
        if (receipt.status !== "success") throw new Error("Refund transaction failed.");
        toast.success("Refund sent!", { description: explorerTxUrl(tx), duration: 8000 });
        refetch();
      } catch (err) {
        toast.error(decodeContractError(err));
      } finally {
        setRefundingId(null);
      }
    },
    [writeContractAsync, config, refetch],
  );

  if (openBounties.length === 0) {
    return (
      <div className="text-sm text-amber-200/50 py-3 text-center">
        No open bounties yet.
      </div>
    );
  }

  const connectedLower = address?.toLowerCase();

  return (
    <div className="space-y-2">
      {openBounties.map((b) => {
        const isActive = challengeId === b.id;
        const isHighlighted = highlightId === b.id;
        const canRefund = b.isExpired && !!address;
        const isPoster = !!connectedLower && b.poster.toLowerCase() === connectedLower;
        const isRefunding = refundingId === b.id;
        return (
          <div
            key={b.id}
            id={`bounty-${b.id}`}
            className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              isActive
                ? "border-amber-400/60 bg-amber-400/10"
                : isHighlighted
                ? "border-sky-400/60 bg-sky-400/10 ring-1 ring-sky-400/30"
                : "border-white/10 bg-white/5"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-amber-300/80 font-mono text-xs">#{b.id}</span>
                  <span className="text-white/60 font-mono text-xs">
                    {isPoster ? "You" : shortAddr(b.poster)}
                  </span>
                </div>
                <div className="text-white font-semibold tabular-nums">
                  {b.target.toLocaleString()} pts
                  <span className="ml-2 text-amber-300 font-normal">
                    {formatUsdc(b.amount)} USDC
                  </span>
                </div>
                <div className="flex gap-2 mt-0.5 text-xs text-white/40 font-mono">
                  <span>seed {shortSeed(b.seed)}</span>
                  <span>{formatTimeLeft(b.deadline)}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                {!b.isExpired && (
                  isPoster ? (
                    <span className="px-3 py-1 rounded text-xs font-medium text-white/40 bg-white/5">
                      Your bounty
                    </span>
                  ) : (
                    <button
                      onClick={() => { handleChallenge(b); }}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                        isActive
                          ? "bg-amber-400 text-stone-900"
                          : "bg-amber-400/20 text-amber-300 hover:bg-amber-400/30"
                      }`}
                    >
                      {isActive ? "Challenging" : "Challenge"}
                    </button>
                  )
                )}
                {canRefund && (
                  <button
                    onClick={() => { void handleRefund(b); }}
                    disabled={isRefunding}
                    className="px-3 py-1 rounded text-xs font-medium bg-white/10 text-white/60 hover:bg-white/20 disabled:opacity-50 transition-colors"
                  >
                    {isRefunding ? "Refunding…" : "Refund to poster"}
                  </button>
                )}
                {/* Share row */}
                <div className="flex gap-1">
                  <button
                    onClick={() => { void shareBounty(b); }}
                    className="flex-1 px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors"
                    title="Copy link or share"
                  >
                    Share
                  </button>
                  <a
                    href={`https://x.com/intent/post?text=${encodeURIComponent(`Beat my ${b.target.toLocaleString()} pts in Bounty Dungeon on Arc and take ${formatUsdc(b.amount)} USDC ${getBountyLink(b.id)}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors"
                    title="Post on X"
                  >
                    𝕏
                  </a>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

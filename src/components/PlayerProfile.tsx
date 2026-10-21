/**
 * src/components/PlayerProfile.tsx
 * In-panel player profile: stats, tier progress, recent activity, copy/share.
 */

import { useCallback } from "react";
import { formatUsdc } from "@/onchain-money";
import { explorerTxUrl, EXPLORER_URL } from "@/bounty/network";
import type { HistoryData, HistoryPlayer, HistoryBounty } from "@/bounty/useHistory";
import { ArrowLeft, Copy, ExternalLink } from "lucide-react";

interface Props {
  address: string;
  data: HistoryData | null;
  onBack: () => void;
}

const TIER_ORDER = ["none", "Recruit", "Hunter", "Veteran", "Legend"];
const TIER_THRESHOLDS: Record<string, number> = {
  none: 0, Recruit: 1, Hunter: 3, Veteran: 10, Legend: 25,
};
const TIER_COLORS: Record<string, string> = {
  Legend:  "bg-amber-400/20 text-amber-300 border-amber-400/30",
  Veteran: "bg-purple-400/20 text-purple-300 border-purple-400/30",
  Hunter:  "bg-blue-400/20 text-blue-300 border-blue-400/30",
  Recruit: "bg-green-400/20 text-green-300 border-green-400/30",
  none:    "bg-white/5 text-white/30 border-white/10",
};

function shortAddr(addr: string) { return addr.slice(0, 6) + "…" + addr.slice(-4); }

function relativeTime(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function tierProgress(points: number): { tier: string; nextTier: string | null; needed: number } {
  let currentTier = "none";
  for (const t of TIER_ORDER) {
    if (points >= TIER_THRESHOLDS[t]) currentTier = t;
  }
  const nextIdx = TIER_ORDER.indexOf(currentTier) + 1;
  if (nextIdx >= TIER_ORDER.length) return { tier: currentTier, nextTier: null, needed: 0 };
  const next = TIER_ORDER[nextIdx];
  return { tier: currentTier, nextTier: next, needed: TIER_THRESHOLDS[next] - points };
}

export function PlayerProfile({ address, data, onBack }: Props) {
  const addrLower = address.toLowerCase();

  const player: HistoryPlayer | null = data
    ? (data.players.find((p) => p.address.toLowerCase() === addrLower) ?? null)
    : null;

  // Recent activity: bounties the player participated in (newest first)
  const recentBounties: HistoryBounty[] = data
    ? data.bounties
        .filter(
          (b) =>
            b.poster.toLowerCase() === addrLower ||
            (b.claimer && b.claimer.toLowerCase() === addrLower),
        )
        .slice(0, 10)
    : [];

  const { tier, nextTier, needed } = player
    ? tierProgress(player.points)
    : { tier: "none", nextTier: "Recruit", needed: 1 };

  const copyAddress = useCallback(() => {
    void navigator.clipboard?.writeText(address).catch(() => undefined);
  }, [address]);

  const copyLink = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("player", address);
    url.searchParams.set("tab", "hunters");
    void navigator.clipboard?.writeText(url.toString()).catch(() => undefined);
  }, [address]);

  const explorerAddr = `${EXPLORER_URL}/address/${address}`;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="text-white/40 hover:text-white/70 transition-colors"
          aria-label="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="font-mono text-sm text-white font-semibold">{shortAddr(address)}</span>
        <button onClick={copyAddress} className="text-white/30 hover:text-white/60 transition-colors" title="Copy address">
          <Copy size={12} />
        </button>
        <a
          href={explorerAddr}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/30 hover:text-amber-300 transition-colors"
          title="View on explorer"
        >
          <ExternalLink size={12} />
        </a>
        <button
          onClick={copyLink}
          className="ml-auto text-xs text-amber-400/60 hover:text-amber-300 transition-colors"
        >
          Copy link
        </button>
      </div>

      {/* Tier badge + progress */}
      <div className="flex items-center gap-2">
        {tier !== "none" && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${TIER_COLORS[tier]}`}>
            {tier}
          </span>
        )}
        <span className="text-xs text-white/40">
          {nextTier
            ? `${needed} more to ${nextTier}`
            : "Max tier reached"}
        </span>
      </div>

      {/* Stats grid */}
      {player ? (
        <div className="grid grid-cols-2 gap-2">
          {[
            ["Posted", player.posted],
            ["Won", player.won],
            ["USDC won", formatUsdc(BigInt(player.usdcWon))],
            ["USDC posted", formatUsdc(BigInt(player.usdcPosted))],
            ["Best score", player.bestScore ? player.bestScore.toLocaleString() : "—"],
            ["Points", player.points],
          ].map(([label, val]) => (
            <div key={label as string} className="rounded-md bg-white/5 px-2 py-1.5">
              <div className="text-[10px] text-white/40 uppercase tracking-wider">{label}</div>
              <div className="text-sm font-semibold text-white tabular-nums">{val}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-white/30 text-center py-2">
          {data ? "No on-chain activity yet." : "Loading…"}
        </div>
      )}

      {/* Recent activity */}
      {recentBounties.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs text-white/40 uppercase tracking-wider">Recent activity</div>
          {recentBounties.map((b) => {
            const isWinner = b.claimer?.toLowerCase() === addrLower;
            const isPoster = b.poster.toLowerCase() === addrLower;
            const tx = isWinner ? b.claimTx : b.refundTx ?? b.postTx;
            const ts = isWinner ? b.claimTime : b.refundTime ?? b.postTime;
            return (
              <div key={b.id} className="flex items-baseline gap-2 text-xs">
                <span className="text-white/30 font-mono w-6">#{b.id}</span>
                <span className={isWinner ? "text-green-400" : isPoster ? "text-amber-400" : "text-white/40"}>
                  {isWinner ? `Won ${formatUsdc(BigInt(b.amount))} USDC` : `Posted ${formatUsdc(BigInt(b.amount))} USDC`}
                </span>
                <span className="text-white/25 ml-auto">{relativeTime(ts)}</span>
                {tx && (
                  <a href={explorerTxUrl(tx)} target="_blank" rel="noopener noreferrer" className="text-amber-400/50 hover:text-amber-300">
                    ↗
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

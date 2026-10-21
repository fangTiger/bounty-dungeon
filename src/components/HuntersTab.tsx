/**
 * src/components/HuntersTab.tsx
 * Leaderboard: ranked by USDC won desc, then wins desc, then earliest first win.
 * Connected wallet row is highlighted; if not in top 20, pinned at the bottom.
 */

import { formatUsdc } from "@/onchain-money";
import type { HistoryData, HistoryPlayer } from "@/bounty/useHistory";

interface Props {
  data: HistoryData | null;
  loading: boolean;
  error: string | null;
  connectedAddress: string | undefined;
  onAddressClick: (addr: string) => void;
}

const TIER_COLORS: Record<string, string> = {
  Legend:  "bg-amber-400/20 text-amber-300 border-amber-400/30",
  Veteran: "bg-purple-400/20 text-purple-300 border-purple-400/30",
  Hunter:  "bg-blue-400/20 text-blue-300 border-blue-400/30",
  Recruit: "bg-green-400/20 text-green-300 border-green-400/30",
  none:    "bg-white/5 text-white/30 border-white/10",
};

function TierBadge({ tier }: { tier: string }) {
  if (tier === "none") return null;
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${TIER_COLORS[tier] ?? TIER_COLORS.none}`}>
      {tier}
    </span>
  );
}

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function PlayerRow({
  rank,
  player,
  isMe,
  onAddressClick,
}: {
  rank: number;
  player: HistoryPlayer;
  isMe: boolean;
  onAddressClick: (a: string) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${
        isMe ? "bg-amber-400/10 border border-amber-400/30" : "border border-transparent hover:bg-white/5"
      }`}
    >
      <span className="w-5 text-right text-white/30 tabular-nums shrink-0">{rank}</span>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => onAddressClick(player.address)}
          className="font-mono text-amber-300/80 hover:text-amber-300 truncate block"
        >
          {shortAddr(player.address)}
        </button>
      </div>
      <TierBadge tier={player.tier} />
      <div className="text-right shrink-0 tabular-nums">
        <span className="text-white font-semibold">{formatUsdc(BigInt(player.usdcWon))}</span>
        <span className="text-white/40 ml-0.5 text-[10px]">USDC</span>
      </div>
      <div className="text-right w-12 text-white/50 tabular-nums shrink-0">
        {player.won}{" "}<span className="text-white/30 text-[10px]">{player.won === 1 ? "win" : "wins"}</span>
      </div>
    </div>
  );
}

export function HuntersTab({ data, loading, error, connectedAddress, onAddressClick }: Props) {
  if (error) {
    return <div className="px-1 py-4 text-xs text-red-400/70 text-center">{error}</div>;
  }
  if (loading && !data) {
    return <div className="px-1 py-4 text-xs text-white/30 text-center animate-pulse">Scanning chain…</div>;
  }
  if (!data) return null;

  const { players } = data;
  const top20 = players.slice(0, 20);
  const myAddr = connectedAddress?.toLowerCase();
  const myRank = myAddr ? players.findIndex((p) => p.address.toLowerCase() === myAddr) : -1;
  const myPlayer = myRank >= 0 ? players[myRank] : null;
  const myInTop20 = myRank >= 0 && myRank < 20;

  return (
    <div className="space-y-1">
      {/* Column headers */}
      <div className="flex items-center gap-2 px-2 pb-1 border-b border-white/10 text-[10px] text-white/25 uppercase tracking-wider">
        <span className="w-5 shrink-0 text-right">#</span>
        <span className="flex-1">Hunter</span>
        <span className="shrink-0">USDC won</span>
        <span className="w-12 text-right shrink-0">Wins</span>
        {loading && <span className="ml-1 animate-pulse">↻</span>}
      </div>

      {top20.length === 0 ? (
        <div className="text-xs text-white/30 text-center py-4">No hunters yet.</div>
      ) : (
        <div className="space-y-0.5">
          {top20.map((p, i) => (
            <PlayerRow
              key={p.address}
              rank={i + 1}
              player={p}
              isMe={p.address.toLowerCase() === myAddr}
              onAddressClick={onAddressClick}
            />
          ))}
        </div>
      )}

      {/* Pinned "my row" when not in top 20 */}
      {!myInTop20 && myPlayer && (
        <div className="mt-2 pt-2 border-t border-white/10">
          <PlayerRow
            rank={myRank + 1}
            player={myPlayer}
            isMe
            onAddressClick={onAddressClick}
          />
        </div>
      )}
    </div>
  );
}

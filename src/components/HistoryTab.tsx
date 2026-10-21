/**
 * src/components/HistoryTab.tsx
 * Shows totals + newest-first list of completed bounties (claimed/refunded/expired).
 */

import { useEffect, useRef } from "react";
import { formatUsdc } from "@/onchain-money";
import { explorerTxUrl } from "@/bounty/network";
import type { HistoryData, HistoryBounty } from "@/bounty/useHistory";

interface Props {
  data: HistoryData | null;
  loading: boolean;
  error: string | null;
  highlightId?: number | null;
  onAddressClick: (addr: string) => void;
}

function relativeTime(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function TxLink({ hash, label }: { hash: string | null; label: string }) {
  if (!hash) return null;
  return (
    <a
      href={explorerTxUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber-400/70 hover:text-amber-300 underline"
    >
      {label}
    </a>
  );
}

function BountyCard({ b, onAddressClick, highlight }: { b: HistoryBounty; onAddressClick: (a: string) => void; highlight?: boolean }) {
  const statusColor =
    b.status === "claimed" ? "text-green-400" :
    b.status === "refunded" ? "text-amber-400" :
    "text-white/40";
  const statusLabel =
    b.status === "claimed" ? "Claimed" :
    b.status === "refunded" ? "Refunded" :
    b.expired ? "Expired" : "Open";

  return (
    <div
      data-bounty-id={b.id}
      className={`rounded-md border px-3 py-2.5 text-xs space-y-1.5 ${
        highlight ? "border-sky-400/60 bg-sky-900/10" : "border-white/10 bg-white/3"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-white/50">#{b.id}</span>
        <span className={`font-semibold ${statusColor}`}>{statusLabel}</span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-white font-semibold tabular-nums">{formatUsdc(BigInt(b.amount))} USDC</span>
        <span className="text-white/40">target {Number(b.target).toLocaleString()} pts</span>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-white/50">
        <span>
          By{" "}
          <button onClick={() => onAddressClick(b.poster)} className="text-amber-300/80 hover:text-amber-300 font-mono">
            {shortAddr(b.poster)}
          </button>
        </span>
        {b.claimer && (
          <span>
            →{" "}
            <button onClick={() => onAddressClick(b.claimer!)} className="text-green-300/80 hover:text-green-300 font-mono">
              {shortAddr(b.claimer)}
            </button>
            {b.claimScore && (
              <span className="ml-1 text-white/40">{Number(b.claimScore).toLocaleString()} pts</span>
            )}
          </span>
        )}
      </div>
      <div className="flex gap-x-3 gap-y-0.5 flex-wrap text-white/35">
        <TxLink hash={b.postTx} label={`posted ${relativeTime(b.postTime)}`} />
        {b.claimTx && <TxLink hash={b.claimTx} label={`claimed ${relativeTime(b.claimTime)}`} />}
        {b.refundTx && <TxLink hash={b.refundTx} label={`refunded ${relativeTime(b.refundTime)}`} />}
      </div>
    </div>
  );
}

export function HistoryTab({ data, loading, error, highlightId, onAddressClick }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll to highlighted card once data loads
  useEffect(() => {
    if (!highlightId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-bounty-id="${highlightId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlightId, data]);

  if (error) {
    return (
      <div className="px-1 py-4 text-xs text-red-400/70 text-center">
        {error}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="px-1 py-4 text-xs text-white/30 text-center animate-pulse">
        Scanning chain…
      </div>
    );
  }

  if (!data) return null;

  const { totals } = data;
  const paidOut = formatUsdc(BigInt(totals.usdcPaidOut));
  const completed = data.bounties.filter((b) => b.status !== "open" || b.expired);

  return (
    <div className="space-y-3">
      {/* Totals */}
      <div className="text-xs text-white/50 pb-1 border-b border-white/10">
        <span className="text-white font-semibold">{paidOut} USDC</span> paid out to challengers
        {" · "}
        <span className="text-white font-semibold">{totals.bounties}</span>{" "}
        {totals.bounties === 1 ? "bounty" : "bounties"} total
        {loading && <span className="ml-2 text-white/25 animate-pulse">↻</span>}
      </div>

      {completed.length === 0 ? (
        <div className="text-xs text-white/30 text-center py-4">No completed bounties yet.</div>
      ) : (
        <div ref={listRef} className="space-y-2">
          {completed.map((b) => (
            <BountyCard key={b.id} b={b} highlight={b.id === highlightId} onAddressClick={onAddressClick} />
          ))}
        </div>
      )}
    </div>
  );
}

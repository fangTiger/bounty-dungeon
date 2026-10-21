/**
 * src/bounty/useHistory.ts
 * Fetches /api/history with 60s auto-refetch.
 * Exposes a manual refetch function (stable reference).
 */

import { useState, useEffect, useCallback, useRef } from "react";

export interface HistoryPlayer {
  address: string;
  posted: number;
  won: number;
  refunded: number;
  usdcPosted: string;
  usdcWon: string;
  bestScore: number;
  points: number;
  tier: string;
  firstWinBlock: number | null;
}

export interface HistoryBounty {
  id: number;
  poster: string;
  seed: string;
  target: string;
  amount: string;
  deadline: number;
  status: "open" | "claimed" | "refunded";
  expired: boolean;
  postTx: string;
  postTime: number | null;
  claimer: string | null;
  claimScore: string | null;
  claimTx: string | null;
  claimTime: number | null;
  refundTx: string | null;
  refundTime: number | null;
}

export interface HistoryTotals {
  bounties: number;
  claimed: number;
  refunded: number;
  open: number;
  usdcPosted: string;
  usdcPaidOut: string;
}

export interface HistoryData {
  chainId: number;
  contract: string;
  scannedTo: number;
  head?: number;
  complete?: boolean;
  updatedAt: number;
  totals: HistoryTotals;
  bounties: HistoryBounty[];
  players: HistoryPlayer[];
}

interface UseHistoryResult {
  data: HistoryData | null;
  loading: boolean;
  error: string | null;
  /** 0-100, only set while complete===false */
  indexingProgress: number | null;
  refetch: () => void;
}

let _refetchCallback: (() => void) | null = null;
export function triggerHistoryRefetch() { _refetchCallback?.(); }

export function useHistory(): UseHistoryResult {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetch_ = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/history", { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as HistoryData;
      setData(json);
      // If indexing is not complete, schedule a retry in 5 s
      if (json.complete === false && !signal.aborted) {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          abortRef.current?.abort();
          abortRef.current = new AbortController();
          void fetch_(abortRef.current.signal);
        }, 5_000);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message ?? "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, []);

  const refetch = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    void fetch_(abortRef.current.signal);
  }, [fetch_]);

  // Expose for external trigger (post/claim success) — update via effect, not during render
  useEffect(() => {
    _refetchCallback = refetch;
    return () => { _refetchCallback = null; };
  }, [refetch]);

  // Initial fetch
  useEffect(() => {
    refetch();
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [refetch]);

  // 60 s auto-refetch (only when already complete)
  useEffect(() => {
    const id = setInterval(() => {
      if (data?.complete !== false) refetch();
    }, 60_000);
    return () => clearInterval(id);
  }, [refetch, data?.complete]);

  // Compute indexing progress 0-100
  const deployBlock = data?.scannedTo != null && data?.head != null && data?.complete === false
    ? null  // will compute below
    : null;
  void deployBlock; // used below in expression
  const indexingProgress: number | null = (() => {
    if (!data || data.complete !== false) return null;
    const { scannedTo, head } = data;
    if (!head || !scannedTo) return 0;
    // We don't have deployBlock here, so approximate from scannedTo vs head
    // The server populates scannedTo as the last completed chunk, head as chain tip.
    // Progress = scannedTo / head (rough but monotone)
    return Math.min(99, Math.round((scannedTo / head) * 100));
  })();

  return { data, loading, error, indexingProgress, refetch };
}

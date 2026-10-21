/**
 * src/components/LastRun.tsx
 * Shows the last completed run and lets the player post or claim a bounty.
 *
 * Approve + post is a single click:
 *   1. Call verifier.
 *   2. If allowance < amount: send approve tx, wait for receipt (must be success).
 *   3. Refetch allowance, then send postBounty tx, wait for receipt.
 * Claim is also a single handler with its own state machine.
 * Post state and Claim state are independent — confirming a claim never
 * affects the Post button.
 */

import { useState, useCallback } from "react";
import { useAccount, useReadContract, useConfig } from "wagmi";
import { useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { toast } from "sonner";
import { parseUsdc, formatUsdc } from "@/onchain-money";
import { BOUNTY_ABI, ERC20_ABI, decodeContractError, CURRENT_SIM_VERSION } from "@/bounty/contract";
import { ACTIVE_CHAIN, ACTIVE_BOUNTY_ADDRESS as BOUNTY_ADDRESS, explorerTxUrl } from "@/bounty/network";
import { callVerifier } from "@/bounty/useVerifier";
import type { OnchainBounty } from "@/bounty/useBounties";

interface RunPackage {
  v: number;
  simVersion: string;
  seed: string;
  heroClass: string;
  ticks: number;
  replay: string;
  replayHash: string;
  result: {
    score: number;
    depth: number;
    bossesDefeated: number;
    visitedRoomCount: number;
    settlementReason: string;
  };
  selfCheck: { passed: boolean; error: string | null };
}

interface Props {
  pkg: RunPackage | null;
  challenge: OnchainBounty | null;
  refetchBounties: () => void;
  refetchBalance: () => void;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

type PostState = "idle" | "verifying" | "approving" | "posting" | "done" | "error";
type ClaimState = "idle" | "verifying" | "claiming" | "done" | "error";

function shortSeed(seed: string) {
  return seed.slice(0, 10) + "…";
}

const REASON_LABEL: Record<string, string> = {
  death: "Died",
  evacuated: "Evacuated",
  timeLimit: "Time limit",
  incomplete: "Incomplete",
};

export function LastRun({ pkg, challenge, refetchBounties, refetchBalance, iframeRef }: Props) {
  const { address } = useAccount();
  const config = useConfig();
  const [amount, setAmount] = useState("");

  // Independent state machines for post and claim
  const [postState, setPostState] = useState<PostState>("idle");
  const [postError, setPostError] = useState("");
  const [claimState, setClaimState] = useState<ClaimState>("idle");
  const [claimError, setClaimError] = useState("");

  const [verifiedResult, setVerifiedResult] = useState<Awaited<ReturnType<typeof callVerifier>> | null>(null);

  const { data: minRaw } = useReadContract({ address: BOUNTY_ADDRESS, abi: BOUNTY_ABI, functionName: "minAmount", chainId: ACTIVE_CHAIN.id });
  const { data: maxRaw } = useReadContract({ address: BOUNTY_ADDRESS, abi: BOUNTY_ABI, functionName: "maxAmount", chainId: ACTIVE_CHAIN.id });
  const { data: verifierActiveAt } = useReadContract({ address: BOUNTY_ADDRESS, abi: BOUNTY_ABI, functionName: "verifierActiveAt", chainId: ACTIVE_CHAIN.id });
  const { data: usdcAddr } = useReadContract({ address: BOUNTY_ADDRESS, abi: BOUNTY_ABI, functionName: "usdc", chainId: ACTIVE_CHAIN.id });
  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    address: usdcAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address && usdcAddr ? [address, BOUNTY_ADDRESS] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!address && !!usdcAddr },
  });

  const { writeContractAsync } = useWriteContract();

  const minUsdc = minRaw ?? 100000n;
  const maxUsdc = maxRaw ?? 10000000n;

  // Initialise the wager input from minAmount on first render (or when minRaw
  // first resolves). Because LastRun is keyed by replayHash, this runs fresh
  // for every new package — no useEffect needed.
  if (amount === "" && minRaw) {
    setAmount(formatUsdc(minRaw));
  }
  const rotationPending = verifierActiveAt != null && verifierActiveAt !== 0n;

  const canClaim =
    challenge !== null &&
    pkg !== null &&
    pkg.seed === challenge.seed &&
    pkg.result.score > Number(challenge.target);

  const startBountyRun = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "arc-dungeon:start", seed: null },
      "*",
    );
  }, [iframeRef]);

  const handlePostBounty = useCallback(async () => {
    if (!pkg || !address) return;
    setPostState("verifying");
    setPostError("");
    try {
      const vr = await callVerifier({ player: address, package: pkg });
      setVerifiedResult(vr);

      const amountRaw = parseUsdc(amount || formatUsdc(minUsdc));
      const clamped = amountRaw < minUsdc ? minUsdc : amountRaw > maxUsdc ? maxUsdc : amountRaw;

      // Approve if needed (single atomic flow — no user re-click).
      // After the approve receipt succeeds we skip the allowance re-read
      // (we know the approved amount) so postBounty goes out immediately.
      const currentAllowance = allowanceRaw ?? 0n;
      if (currentAllowance < clamped && usdcAddr) {
        setPostState("approving");
        toast.loading("Approving USDC…", { id: "approve-toast" });
        const approveTx = await writeContractAsync({
          address: usdcAddr,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [BOUNTY_ADDRESS, clamped],
        });
        const approveReceipt = await waitForTransactionReceipt(config, {
          hash: approveTx,
          confirmations: 1,
        });
        toast.dismiss("approve-toast");
        if (approveReceipt.status !== "success") throw new Error("Approve transaction failed.");
        // Refresh stored allowance in background — do NOT await (posting continues)
        void refetchAllowance();
      }

      setPostState("posting");
      const rr = vr.runResult;
      const postTx = await writeContractAsync({
        address: BOUNTY_ADDRESS,
        abi: BOUNTY_ABI,
        functionName: "postBounty",
        args: [
          {
            player: rr.player as `0x${string}`,
            seed: rr.seed as `0x${string}`,
            score: BigInt(rr.score),
            replayHash: rr.replayHash as `0x${string}`,
            runId: rr.runId as `0x${string}`,
          },
          vr.signature as `0x${string}`,
          clamped,
        ],
      });
      const postReceipt = await waitForTransactionReceipt(config, { hash: postTx });
      if (postReceipt.status !== "success") throw new Error("Post bounty transaction failed.");

      toast.success(
        `Bounty posted! View tx`,
        { description: explorerTxUrl(postTx), duration: 8000 },
      );
      refetchBounties();
      refetchBalance();
      setPostState("done");
    } catch (err) {
      setPostError(decodeContractError(err));
      setPostState("error");
    }
  }, [pkg, address, amount, minUsdc, maxUsdc, allowanceRaw, usdcAddr, writeContractAsync, config, refetchBounties, refetchBalance, refetchAllowance]);

  const handleClaimBounty = useCallback(async () => {
    if (!pkg || !address || !challenge) return;
    setClaimState("verifying");
    setClaimError("");
    try {
      const vr = await callVerifier({ player: address, package: pkg });
      setVerifiedResult(vr);
      setClaimState("claiming");
      const rr = vr.runResult;
      const claimTx = await writeContractAsync({
        address: BOUNTY_ADDRESS,
        abi: BOUNTY_ABI,
        functionName: "claimBounty",
        args: [
          BigInt(challenge.id),
          {
            player: rr.player as `0x${string}`,
            seed: rr.seed as `0x${string}`,
            score: BigInt(rr.score),
            replayHash: rr.replayHash as `0x${string}`,
            runId: rr.runId as `0x${string}`,
          },
          vr.signature as `0x${string}`,
        ],
      });
      const claimReceipt = await waitForTransactionReceipt(config, { hash: claimTx });
      if (claimReceipt.status !== "success") throw new Error("Claim transaction failed.");

      toast.success(
        `Bounty #${challenge.id} claimed!`,
        { description: explorerTxUrl(claimTx), duration: 8000 },
      );
      refetchBounties();
      refetchBalance();
      setClaimState("done");
    } catch (err) {
      setClaimError(decodeContractError(err));
      setClaimState("error");
    }
  }, [pkg, address, challenge, writeContractAsync, config, refetchBounties, refetchBalance]);

  // Reset error states (e.g. after a failed tx the user wants to retry)
  const resetErrors = useCallback(() => {
    setPostState("idle");
    setPostError("");
    setClaimState("idle");
    setClaimError("");
    setVerifiedResult(null);
  }, []);

  // "Start bounty run" button — always available at the top of this section
  const startButton = (
    <button
      onClick={startBountyRun}
      className="w-full py-2 rounded-md text-sm font-semibold bg-stone-700 text-amber-200 hover:bg-stone-600 transition-colors mb-3"
    >
      Start bounty run
    </button>
  );

  if (!pkg) {
    return (
      <div className="space-y-2">
        {startButton}
        <div className="text-sm text-amber-200/50 py-3 text-center">
          Complete a Bounty Run to see your result here.
        </div>
      </div>
    );
  }

  const isStale = pkg.simVersion !== CURRENT_SIM_VERSION;
  const postBusy = postState === "verifying" || postState === "approving" || postState === "posting";
  const claimBusy = claimState === "verifying" || claimState === "claiming";

  return (
    <div className="space-y-3">
      {startButton}

      {/* Stale simVersion warning */}
      {pkg.simVersion !== CURRENT_SIM_VERSION && (
        <div className="rounded-md bg-red-900/30 border border-red-500/30 px-3 py-2 text-xs text-red-300">
          This replay was made with sim v{pkg.simVersion} but the current engine is v{CURRENT_SIM_VERSION}. It cannot be submitted — please play a new run.
        </div>
      )}

      {/* Run summary */}
      <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-xl font-bold tabular-nums text-white">
            {pkg.result.score.toLocaleString()}
            <span className="text-sm font-normal text-white/50 ml-1">pts</span>
          </span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            pkg.result.settlementReason === "death" ? "bg-red-900/40 text-red-300" :
            pkg.result.settlementReason === "evacuated" ? "bg-green-900/40 text-green-300" :
            "bg-amber-900/40 text-amber-300"
          }`}>
            {REASON_LABEL[pkg.result.settlementReason] ?? pkg.result.settlementReason}
          </span>
        </div>
        <div className="text-xs text-white/50 font-mono flex flex-wrap gap-x-3 gap-y-0.5">
          <span>Depth {pkg.result.depth}</span>
          <span>{pkg.result.bossesDefeated} boss</span>
          <span>{pkg.result.visitedRoomCount} rooms</span>
          <span>seed {shortSeed(pkg.seed)}</span>
        </div>
        <div className={`mt-1.5 text-xs ${pkg.selfCheck.passed ? "text-green-400/70" : "text-red-400/70"}`}>
          {pkg.selfCheck.passed ? "Self-check passed" : `Self-check failed${pkg.selfCheck.error ? `: ${pkg.selfCheck.error}` : ""}`}
        </div>
        {/* new-run button to discard and start fresh */}
        {(postState === "error" || claimState === "error") && (
          <button
            onClick={resetErrors}
            className="mt-2 text-xs text-white/30 hover:text-white/60 transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {rotationPending && (
        <div className="rounded-md bg-amber-900/30 border border-amber-400/30 px-3 py-2 text-xs text-amber-300">
          Verifier rotation pending — new bounties are paused until the timelock elapses.
        </div>
      )}

      {verifiedResult?.replayMismatch && (
        <div className="rounded-md bg-red-900/30 border border-red-400/30 px-3 py-2 text-xs text-red-300">
          Score mismatch: server replay scored {verifiedResult.runResult.score} — that score will be used on-chain.
        </div>
      )}

      {/* Post bounty */}
      {!rotationPending && address && (
        <div className="space-y-1.5">
          <label className="text-xs text-white/50 uppercase tracking-wider">Wager (USDC)</label>
          <div className="flex gap-2">
            <input
              type="number"
              min={formatUsdc(minUsdc)}
              max={formatUsdc(maxUsdc)}
              step="0.01"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); }}
              className="flex-1 bg-white/5 border border-white/15 rounded-md px-3 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:border-amber-400/60"
              disabled={postBusy}
            />
            <button
              onClick={() => { void handlePostBounty(); }}
              disabled={postBusy || postState === "done" || isStale}
              className="px-4 py-1.5 rounded-md text-sm font-semibold bg-amber-400 text-stone-900 hover:bg-amber-300 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {postState === "verifying" ? "Verifying…"
                : postState === "approving" ? "Approving…"
                : postState === "posting" ? "Posting…"
                : postState === "done" ? "Posted!"
                : "Post bounty"}
            </button>
          </div>
          <div className="text-xs text-white/30">
            Min {formatUsdc(minUsdc)} · Max {formatUsdc(maxUsdc)} USDC
          </div>
          {postState === "error" && postError && (
            <div className="rounded-md bg-red-900/30 border border-red-400/30 px-3 py-2 text-xs text-red-300">
              {postError}
            </div>
          )}
        </div>
      )}

      {/* Claim bounty */}
      {canClaim && address && (
        <div className="space-y-1">
          <button
            onClick={() => { void handleClaimBounty(); }}
            disabled={claimBusy || claimState === "done" || isStale}
            className="w-full py-2 rounded-md text-sm font-semibold bg-green-500 text-white hover:bg-green-400 disabled:opacity-50 transition-colors"
          >
            {claimState === "verifying" ? "Verifying…"
              : claimState === "claiming" ? "Claiming…"
              : claimState === "done" ? "Claimed!"
              : `Claim bounty #${challenge.id} (${formatUsdc(challenge.amount)} USDC)`}
          </button>
          {claimState === "error" && claimError && (
            <div className="rounded-md bg-red-900/30 border border-red-400/30 px-3 py-2 text-xs text-red-300">
              {claimError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

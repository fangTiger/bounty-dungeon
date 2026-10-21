/**
 * src/components/BountyPanel.tsx
 * Side panel: wallet, USDC balance, tab row (Bounties | History | Hunters),
 * last run, and player profile.
 *
 * Tab and profile state are reflected in the URL (?tab=, ?player=) via
 * history.replaceState so links are shareable without reloading the iframe.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { ConnectKitButton } from "connectkit";
import { useAccount, useReadContract } from "wagmi";
import { formatUsdc } from "@/onchain-money";
import { useBounties } from "@/bounty/useBounties";
import { useHistory, triggerHistoryRefetch } from "@/bounty/useHistory";
import {
  ACTIVE_CHAIN,
  NETWORK_LABEL,
  USDC_ADDRESS,
  BOUNTY_UNCONFIGURED,
} from "@/bounty/network";
import { OpenBounties } from "./OpenBounties";
import { LastRun } from "./LastRun";
import { HistoryTab } from "./HistoryTab";
import { HuntersTab } from "./HuntersTab";
import { PlayerProfile } from "./PlayerProfile";
import { ChevronRight, ChevronLeft, User, HelpCircle } from "lucide-react";
import { RulesModal } from "./RulesModal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  isNarrow?: boolean;
}

type Tab = "bounties" | "history" | "hunters";

const BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function readUrlState(): { tab: Tab; player: string | null; bountyId: number | null } {
  if (typeof window === "undefined") return { tab: "bounties", player: null, bountyId: null };
  const p = new URLSearchParams(window.location.search);
  const tab = (p.get("tab") ?? "bounties") as Tab;
  const validTabs: Tab[] = ["bounties", "history", "hunters"];
  const rawBounty = p.get("bounty");
  const bountyId = rawBounty && /^\d+$/.test(rawBounty) ? parseInt(rawBounty, 10) : null;
  return {
    tab: validTabs.includes(tab) ? tab : "bounties",
    player: p.get("player"),
    bountyId,
  };
}

function pushUrlState(tab: Tab, player: string | null) {
  if (typeof window === "undefined") return;
  const p = new URLSearchParams(window.location.search);
  if (tab === "bounties") p.delete("tab"); else p.set("tab", tab);
  if (player) p.set("player", player); else p.delete("player");
  const qs = p.toString();
  const url = window.location.pathname + (qs ? "?" + qs : "");
  window.history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Safe localStorage wrapper (storage quota / private mode can throw)
// ---------------------------------------------------------------------------
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

const ONBOARDING_KEY = "bd.onboarding.v1";

export function BountyPanel({ iframeRef, isNarrow = false }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showRules, setShowRules] = useState(false);
  // Onboarding card: shown until dismissed; persisted in localStorage.
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => safeGet(ONBOARDING_KEY) === "1",
  );
  const dismissOnboarding = useCallback(() => {
    safeSet(ONBOARDING_KEY, "1");
    setOnboardingDismissed(true);
  }, []);
  const [lastPkg, setLastPkg] = useState<RunPackage | null>(null);
  const [challengeId, setChallengeId] = useState<number | null>(null);
  const [challengeSeed, setChallengeSeed] = useState<string | null>(null);
  const { address } = useAccount();

  // Tab and profile state — initialised from URL
  const initialUrl = readUrlState();
  const [tab, setTabState] = useState<Tab>(() => initialUrl.tab);
  const [profileAddr, setProfileAddrState] = useState<string | null>(() => initialUrl.player);
  // bounty highlight — set from ?bounty= URL param; cleared once routed
  const [highlightBountyId, setHighlightBountyId] = useState<number | null>(() => initialUrl.bountyId);

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    setProfileAddrState(null);
    setHighlightBountyId(null); // clear deep-link highlight when user navigates
    // Remove ?bounty= from URL
    const p2 = new URLSearchParams(window.location.search);
    p2.delete("bounty");
    if (t === "bounties") p2.delete("tab"); else p2.set("tab", t);
    p2.delete("player");
    const qs2 = p2.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs2 ? "?" + qs2 : ""));
  }, []);

  const openProfile = useCallback((addr: string) => {
    setProfileAddrState(addr);
    setHighlightBountyId(null); // clear deep-link highlight when user opens a profile
    pushUrlState(tab, addr);
    // Switch to hunters tab when opening profile from bounties/history
    if (tab === "bounties") {
      setTabState("hunters");
      pushUrlState("hunters", addr);
    }
  }, [tab]);

  const closeProfile = useCallback(() => {
    setProfileAddrState(null);
    pushUrlState(tab, null);
  }, [tab]);

  const { bounties, refetch } = useBounties();
  const { data: historyData, loading: historyLoading, error: historyError, indexingProgress, refetch: refetchHistory } = useHistory();

  // USDC balance
  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: BALANCE_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!USDC_ADDRESS },
  });

  const refetchBalanceCb = useCallback(() => { void refetchBalance(); }, [refetchBalance]);

  const refetchAll = useCallback(() => {
    refetch();
    refetchHistory();
  }, [refetch, refetchHistory]);

  // Also trigger history refetch after successful post/claim (via triggerHistoryRefetch())
  // This is called from LastRun's refetchBounties prop which we extend below.
  const refetchWithHistory = useCallback(() => {
    refetch();
    triggerHistoryRefetch();
  }, [refetch]);

  // iframe message listener
  const onMessageRef = useRef<((evt: MessageEvent) => void) | null>(null);
  useEffect(() => {
    function onMessage(evt: MessageEvent) {
      if (iframeRef.current && evt.source !== iframeRef.current.contentWindow) return;
      const data = evt.data as { type?: string; package?: RunPackage } | null;
      if (!data || data.type !== "arc-dungeon:run-result") return;
      const pkg = data.package;
      if (pkg?.v === 2) setLastPkg(pkg);
    }
    onMessageRef.current = onMessage;
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef]);

  // Bounties auto-refresh every 15 s
  useEffect(() => {
    const id = setInterval(() => { refetch(); }, 15_000);
    return () => clearInterval(id);
  }, [refetch]);

  // Derive effective tab: if ?bounty=<id> is set, route to the right tab once
  // bounties load. Computed at render time to avoid setState-in-effect lint.
  const derivedTab: Tab = (() => {
    if (highlightBountyId !== null && bounties.length > 0) {
      const isOpen = bounties.some((b) => b.id === highlightBountyId && b.isOpen);
      if (isOpen) return "bounties";
      if (historyData) return "history";
    }
    return tab;
  })();

  const activeBounty = bounties.find(
    (b) => b.id === challengeId && b.seed === challengeSeed,
  ) ?? null;

  const handleChallenge = useCallback((id: number, seed: string) => {
    setChallengeId(id);
    setChallengeSeed(seed);
  }, []);

  // ---------------------------------------------------------------------------
  // Tab content
  // ---------------------------------------------------------------------------
  const tabContent = (() => {
    // Profile view takes over any tab
    if (profileAddr) {
      return (
        <PlayerProfile
          address={profileAddr}
          data={historyData}
          onBack={closeProfile}
        />
      );
    }

    if (derivedTab === "history") {
      return (
        <HistoryTab
          data={historyData}
          loading={historyLoading}
          error={historyError}
          highlightId={highlightBountyId}
          onAddressClick={openProfile}
        />
      );
    }

    if (derivedTab === "hunters") {
      return (
        <HuntersTab
          data={historyData}
          loading={historyLoading}
          error={historyError}
          connectedAddress={address}
          onAddressClick={openProfile}
        />
      );
    }

    // "bounties" tab — original content
    return (
      <>
        {/* First-visit onboarding card */}
        {!onboardingDismissed && (
          <div className="mb-4 rounded-md bg-stone-800/80 border border-amber-400/20 px-3 py-3 text-xs text-white/80">
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="font-semibold text-amber-300/90">How it works</span>
              <button
                onClick={dismissOnboarding}
                className="text-white/30 hover:text-white/70 text-base leading-none flex-shrink-0"
                aria-label="Dismiss"
              >×</button>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-white/70 mb-2">
              <li>Pick an open bounty and press <strong className="text-white/90">Challenge</strong>.</li>
              <li>Beat the target score on the same dungeon in one run.</li>
              <li>Claim the USDC — paid by the contract instantly.</li>
            </ol>
            <p className="text-white/60 mb-2">
              Or press <strong className="text-white/80">Start bounty run</strong> and post your own score (0.01–10 USDC).
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={dismissOnboarding}
                className="px-3 py-1 rounded bg-amber-500/20 border border-amber-400/30 text-amber-300 hover:bg-amber-500/30 transition-colors text-xs font-semibold"
              >
                Got it
              </button>
              <button
                onClick={() => { dismissOnboarding(); setShowRules(true); }}
                className="text-xs text-white/40 hover:text-white/70 underline transition-colors"
              >
                Full rules
              </button>
            </div>
          </div>
        )}

        {/* Open bounties */}
        <div className="border-b border-white/10 pb-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-300/70">
              Open bounties
            </h2>
            <button
              onClick={refetchAll}
              className="text-xs text-white/30 hover:text-white/60 transition-colors"
            >
              Refresh
            </button>
          </div>
          <OpenBounties
            bounties={bounties}
            refetch={refetch}
            challengeId={challengeId}
            highlightId={highlightBountyId}
            onChallenge={handleChallenge}
            iframeRef={iframeRef}
          />
        </div>

        {/* Last run */}
        <div className="flex-1">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-300/70 mb-2">
            Your last run
          </h2>
          <LastRun
            key={lastPkg?.replayHash ?? "none"}
            pkg={lastPkg}
            challenge={activeBounty}
            refetchBounties={refetchWithHistory}
            refetchBalance={refetchBalanceCb}
            iframeRef={iframeRef}
          />
        </div>
      </>
    );
  })();

  return (
    <>
      {/* Mobile toggle — pinned bottom-right so it doesn't cover the game canvas */}
      <button
        onClick={() => setMobileOpen((o) => !o)}
        aria-label={mobileOpen ? "Close bounty panel" : "Open bounty panel"}
        className="lg:hidden fixed bottom-16 right-3 z-40 flex items-center justify-center w-9 h-9 rounded-full bg-stone-900/90 border border-white/15 text-white/70 hover:text-white backdrop-blur-sm transition-colors shadow-md"
      >
        {mobileOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>

      {/* Panel */}
      <aside
        className={`
          flex-shrink-0 flex flex-col
          bg-stone-950 border-l border-white/10 overflow-y-auto
          transition-transform duration-300 ease-in-out
          lg:static lg:translate-x-0 lg:w-80 lg:h-full
          fixed top-0 right-0 h-full w-80 z-30
          ${mobileOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0"}
        `}
      >
        {/* Phone keyboard notice */}
        {isNarrow && (
          <div className="mx-4 mt-3 rounded-md bg-stone-800/60 border border-white/10 px-3 py-2 text-xs text-white/50 leading-relaxed">
            Best on desktop — the game uses keyboard controls. You can still browse bounties, history and hunters here.
          </div>
        )}

        {/* Unconfigured mainnet notice */}
        {BOUNTY_UNCONFIGURED && (
          <div className="mx-4 mt-4 rounded-md bg-red-900/40 border border-red-400/40 px-3 py-2 text-xs text-red-300">
            Bounty contract not configured. Set <code>VITE_BOUNTY_ADDRESS</code> for Arc mainnet.
          </div>
        )}

        {/* Wallet section */}
        <div className="px-4 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-amber-300/70">
              {NETWORK_LABEL}
            </span>
            <div className="flex items-center gap-2">
              {/* My profile link */}
              {address && (
                <button
                  onClick={() => openProfile(address)}
                  className="flex items-center gap-1 text-xs text-white/40 hover:text-amber-300 transition-colors"
                  title="My profile"
                >
                  <User size={12} />
                  My profile
                </button>
              )}
              {/* Rules button */}
              <button
                onClick={() => setShowRules(true)}
                className="flex items-center gap-1 text-xs text-white/30 hover:text-white/70 transition-colors"
                title="How it works"
                aria-label="Rules"
              >
                <HelpCircle size={13} />
              </button>
            </div>
          </div>
          <ConnectKitButton />
          {address && usdcBalance != null && (
            <div className="mt-2 text-sm text-white/70 tabular-nums">
              Balance: <span className="text-white font-semibold">{formatUsdc(usdcBalance)} USDC</span>
            </div>
          )}
        </div>

        {/* Tab row */}
        <div className="flex border-b border-white/10">
          {(["bounties", "history", "hunters"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                derivedTab === t && !profileAddr
                  ? "text-amber-300 border-b-2 border-amber-400"
                  : "text-white/40 hover:text-white/70"
              }`}
            >
              {t === "bounties" ? "Bounties" : t === "history" ? "History" : "Hunters"}
            </button>
          ))}
        </div>

        {/* Indexing progress banner */}
        {indexingProgress !== null && (
          <div className="px-4 py-1.5 text-xs text-amber-300/70 bg-amber-900/10 border-b border-amber-900/20">
            Indexing chain… {indexingProgress}%
          </div>
        )}

        {/* Tab content */}
        <div className="px-4 py-4 flex-1 flex flex-col">
          {tabContent}
        </div>
      </aside>
      {/* Rules modal */}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
    </>
  );
}

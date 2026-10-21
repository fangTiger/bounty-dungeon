/**
 * src/components/RulesModal.tsx
 * "How it works" rules modal for Bounty Dungeon.
 * Opened via the "?" button in the panel header.
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ACTIVE_BOUNTY_ADDRESS, EXPLORER_URL } from "@/bounty/network";

interface Props {
  onClose: () => void;
}

const CONTRACT_URL = `${EXPLORER_URL}/address/${ACTIVE_BOUNTY_ADDRESS}`;

const SECTIONS = [
  {
    title: "Post a bounty",
    body:
      "Play a bounty run — the verifier replays your full input log using the deterministic sim and signs an EIP-712 result. " +
      "Your USDC is escrowed in the contract. The seed of your run is public so anyone can attempt the same dungeon layout.",
  },
  {
    title: "Challenge",
    body:
      "Any wallet can challenge any open bounty using the same seed. You have 24 hours and unlimited attempts. " +
      "You must score strictly higher than the poster. The first valid claim takes the full escrowed amount.",
  },
  {
    title: "Refund",
    body:
      "If no one beats the score before the deadline, anyone may call Refund on-chain — " +
      "the USDC always goes back to the original poster. " +
      "The contract enforces the deadline; it rejects a refund call before the deadline expires.",
  },
  {
    title: "Fees",
    body:
      "No platform fee. You pay only the Arc network gas fee, which is denominated in USDC (Arc's native gas token). " +
      "Gas is typically a fraction of a cent per transaction.",
  },
  {
    title: "Trust model",
    body:
      "One verifier key signs results off-chain. The contract checks the EIP-712 signature on both post and claim. " +
      "The verifier can be rotated by the contract owner only through a 25-hour timelock, giving players time to notice a change. " +
      "Server-side replay proves the run is valid under the game rules, but cannot prove a human played it. " +
      "Scores are deterministic: the same seed and inputs always produce the same result.",
  },
] as const;

export function RulesModal({ onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Close on backdrop click
  function onBackdropClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    <div
      ref={overlayRef}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-modal-title"
        className="relative w-full max-w-sm bg-stone-950 border border-white/15 rounded-xl shadow-2xl max-h-[80vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/10 shrink-0">
          <h2 id="rules-modal-title" className="text-sm font-semibold text-white tracking-wide">How it works</h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/80 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="overflow-y-auto px-5 py-4 space-y-5 text-xs leading-relaxed">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3 className="font-semibold text-amber-300/90 mb-1">{s.title}</h3>
              <p className="text-white/60">{s.body}</p>
            </section>
          ))}

          {/* Contract link */}
          <section>
            <h3 className="font-semibold text-amber-300/90 mb-1">Contract</h3>
            <p className="text-white/60">
              Deployed on Arc.{" "}
              <a
                href={CONTRACT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400/80 hover:text-amber-300 underline break-all"
              >
                {ACTIVE_BOUNTY_ADDRESS.slice(0, 10)}…{ACTIVE_BOUNTY_ADDRESS.slice(-8)}
              </a>
            </p>
          </section>

          {/* Non-affiliation disclaimer */}
          <p className="text-white/30 text-[10px] leading-relaxed border-t border-white/10 pt-3 mt-1">
            Bounty Dungeon is an independent project built on Arc. It is not affiliated with,
            sponsored or endorsed by Circle or Arc.
          </p>
        </div>
      </div>
    </div>
  );
}

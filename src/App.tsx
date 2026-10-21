import { useRef, useState, useEffect } from "react";
import { BountyPanel } from "./components/BountyPanel";

/**
 * Flex-row layout: game iframe takes all remaining width; BountyPanel is a
 * fixed 320 px column on screens >= 1024 px, collapsible drawer below that.
 * The panel never overlaps the iframe — no z-index stacking needed.
 */
export default function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Detect phone-width viewport for the keyboard notice
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", handler);
    // Initial value already set in useState initializer; only future changes need this handler.
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div
      style={{ width: "100vw", height: "100dvh", margin: 0, padding: 0, background: "#0c0a09" }}
      className="flex flex-row overflow-hidden"
    >
      {/* Game iframe — takes all remaining width */}
      <div className="flex-1 min-w-0 relative">
        <iframe
          ref={iframeRef}
          src="/game/"
          title="Bounty Dungeon"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          allow="fullscreen"
        />
      </div>

      {/* Bounty side panel — 320 px fixed column, collapsible on narrow screens */}
      <BountyPanel iframeRef={iframeRef} isNarrow={isNarrow} />
    </div>
  );
}

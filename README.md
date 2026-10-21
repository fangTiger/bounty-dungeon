# Bounty Dungeon

**Beat my run, take my USDC.** A pixel roguelike where any player can post a USDC bounty on a run they just finished. Challengers replay the **exact same dungeon seed**. The first one to score strictly higher within 24 hours is paid by the contract. If nobody beats it, the poster takes the bounty back.

- **Play:** https://bounty-dungeon.vercel.app (Arc mainnet, real USDC)
- **Contract:** [`0x53b8512e4124089c88aab379c64cb8dc05b344ba`](https://explorer.arc.io/address/0x53b8512e4124089c88aab379c64cb8dc05b344ba) on Arc mainnet (chain 5042)
- **Built with:** Arc Studio. Contract, tests, web app, verifier and history indexer were written in Studio; see [Built with Arc Studio](#built-with-arc-studio).

---

## Try it in 2 minutes

**Without a wallet:** open the site. The game runs in the browser. The right-hand panel shows live open bounties, past bounties (**History**) and the **Hunters** leaderboard, all read from Arc mainnet.

**With a wallet (a little USDC on Arc mainnet):**

1. **Challenge a bounty.** Click **Challenge** on an open bounty. The game loads that bounty's seed. Score higher than the target, then click **Claim**. The bounty USDC goes to your wallet in the same transaction.
2. **Post your own.** Click **Start bounty run** and play a run. When it ends, choose an amount (0.01–10 USDC) and click **Post bounty**. Your wallet asks you to approve the USDC, then to post. Your score becomes the target for the next 24 hours.
3. **Share it.** Every bounty has a link (`/?bounty=<id>`) and a one-click post to X. Every player has a profile (`/?player=<address>`).

Controls: WASD or arrow keys to move, J or Space to attack, K to dodge, U/I/O/P for skills, E to interact, L to switch language (EN/中文).

---

## How it works

```
 player finishes a run                       challenger replays the same seed
        │                                                  │
        ▼                                                  ▼
  input log + seed ──► /api/verify ◄────────────── input log + seed
                       re-simulates the run
                       with the game's own
                       deterministic engine
                            │ EIP-712 RunResult(player, seed, score, replayHash, runId)
                            ▼
              DungeonBounty.postBounty()        DungeonBounty.claimBounty()
              locks USDC, target = score        pays if seed matches and
              deadline = now + 24h              score > target
                            │
                            └── after 24h with no winner: refund() → USDC back to poster
```

- **Deterministic simulation.** Combat, movement and dungeon generation run in a seeded, fixed-step simulation (`Arc-Dungeon/apps/web/src/core/simulation`). The browser and the server run the same code, so a run can be checked by replaying its input log. Replays match bit-for-bit across Chromium, Firefox and WebKit in our test harness.
- **Score attestation.** `api/verify.js` (a Vercel function) replays the submitted input log on the server. It rejects runs that are tampered with, incomplete, oversized (over 256 KB) or from an old engine version (`SIM_VERSION`). Only then does it sign an EIP-712 `RunResult`.
- **Escrow.** `DungeonBounty.sol` holds the USDC. It checks the verifier signature, the seed, the deadline and that the score is strictly higher.
- **History indexer.** `api/history.js` scans contract events (`BountyPosted`, `BountyClaimed`, `BountyRefunded`, `ScoreAttested`) from the deploy block onward. It stays inside the public RPC's limits (≤9,000 blocks per call, paced requests, backoff on 429) and caches incrementally. This powers History, Hunters and player profiles.

## Trust model

What the contract guarantees, with no trusted party involved:

- Bounty USDC can only go to a challenger with a valid, strictly higher score on the same seed before the deadline, or back to the poster after the deadline.
- **There is no owner withdraw function.** The owner cannot touch escrowed funds.
- `refund()` can be called by anyone once the deadline has passed, and the funds always go to the poster. A bounty cannot get stuck.
- The poster cannot claim their own bounty (`SelfClaim`), and a run cannot be used twice on the same bounty (`RunIdAlreadyUsed`).
- The poster's target score must also be attested, so nobody can post a fake low target.
- Amounts are bounded on chain to between 0.01 and 10 USDC.

What you have to trust:

- **The verifier key.** Scores are attested by one server-side key (`0xb65C…29c4`). A leaked key could sign fake scores and drain open bounties. Mitigations:
  - Each bounty is capped at 10 USDC and lives for only 24 hours.
  - The key is never in the repo; it lives only in a sensitive (encrypted) Vercel environment variable.
  - Rotating the verifier has a **25-hour timelock**, longer than any bounty's life, and new bounties are paused while a rotation is pending. So a rotation can never change the rules of a bounty that is already open.
- **Roadmap:** multiple independent verifiers (k-of-n signatures), then a proof of the simulation so that no trusted verifier is needed.

## Live on Arc mainnet

| What | Transaction |
| --- | --- |
| Deploy `DungeonBounty` v3 (block 26921133) | [`0xaca6e171…13e8`](https://explorer.arc.io/tx/0xaca6e171b1f34b8fdff0e298230b4541d8bf716905d30533274fa9dbb9e813e8) |
| Approve USDC | [`0xf29d605d…5206`](https://explorer.arc.io/tx/0xf29d605db956905df079fa2c415e81946c05904167256286f23cf28f47345206) |
| Post bounty #1: 0.01 USDC, target 102,986 | [`0x00ec01d0…3c6a`](https://explorer.arc.io/tx/0x00ec01d09d1054be2dd16f4156ee0039439d44171550b777bacead4b99a93c6a) |
| Claim bounty #1: score 102,988, paid 0.01 USDC | [`0x4be71262…d01f`](https://explorer.arc.io/tx/0x4be71262bf36c908c388fbc19ed3254da545b23a678da10c95f57884e769d01f) |
| Post bounty #2: 0.01 USDC, target 102,986 | [`0x5cc2fef6…ac90`](https://explorer.arc.io/tx/0x5cc2fef608d9a3d76b408db36289124cc5ef50766aaaef6d3d4af22c412bac90) |

Every approve, post and claim above went through the live site's UI in a browser. The deploy was done by a script. The full, current list is on the site's **History** tab and at `https://bounty-dungeon.vercel.app/api/history`.

Constructor arguments: USDC `0x3600000000000000000000000000000000000000`, verifier `0xb65C38313bB2aF4c1346E416939658718FE729c4`, owner `0x81d48d2c5D0744e8eF7A5c35cDceB0A27A1c707B`, min `10000` (0.01 USDC), max `10000000` (10 USDC). The deployed runtime bytecode is identical to the Studio-compiled artifact (`contracts/out/DungeonBounty.sol/DungeonBounty.json`) and to the testnet v3 deployment [`0x2ff27f2d…5ce4`](https://explorer.testnet.arc.io/address/0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4).

## Built with Arc Studio

The whole app was developed in one Arc Studio project, over 20+ agent turns driven from the `arc-studio` CLI:

| Turns | What Studio built |
| --- | --- |
| Contract v1 → v3 | `DungeonBounty.sol` with an EIP-712 verifier, 25-hour verifier timelock and seed-per-bounty design; 46 Foundry tests; testnet deployments |
| Verifier | `api/verify.js`: server-side replay with the game's own headless runner, then EIP-712 signing |
| Bounty UI | React + wagmi panel next to the game iframe: open bounties, approve/post/claim/refund, toasts |
| Gameplay fixes | Foot-based collision (the engine bumped `SIM_VERSION` to "2"), pillar art alignment, settlement screen |
| Visual polish | Crisp pixel rendering at integer scale, brighter lighting, torches, hit sparks; render-only, so replays stay deterministic |
| History & social | `api/history.js` indexer, History / Hunters tabs, player profiles, participation tiers, share links, rules modal |

Done outside Studio, and stated here for transparency:

- **Mainnet deployment.** Studio's deploy tool targets testnet, so the Studio-compiled artifact was deployed with a short viem script. The bytecode is identical, as noted above.
- **Hosting** on Vercel.
- **A few small hotfixes**, applied live first and then sent back to Studio as prompts so the Studio project matches what is deployed.

## Repository layout

```
contracts/                 DungeonBounty.sol + Foundry tests (contracts/test)
src/                       React shell: bounty panel, history, hunters, profiles (wagmi/viem)
api/                       Vercel entry points (re-export Arc-Dungeon/api)
Arc-Dungeon/
  apps/web/                the game (vanilla JS + Canvas, 320×180 pixel art)
    src/core/simulation/   deterministic simulation shared by browser and server
  api/verify.js            score verifier (replay + EIP-712 signature)
  api/history.js           on-chain event indexer
  test/                    427 node tests (sim, replay, verifier, history, UI logic)
  openspec/                specs and change proposals
```

## Run locally

```bash
bun install
(cd Arc-Dungeon && npm run dev)  # game on http://localhost:5174
bun run dev                      # shell + /api/verify + /api/history on http://localhost:5173 (proxies /game)
cd Arc-Dungeon && npm test       # 427 tests
forge install foundry-rs/forge-std --no-git   # once, for the contract tests
bun run contracts:test         # Foundry tests (46)
```

By default the app targets Arc testnet. For mainnet, set `VITE_ARC_NETWORK=mainnet` and `VITE_BOUNTY_ADDRESS`. The verifier needs `VERIFIER_PRIVATE_KEY`, `CHAIN_ID` and `BOUNTY_CONTRACT` in the server environment. The history indexer also reads `BOUNTY_DEPLOY_BLOCK`. Never commit keys.

## Credits

Built on top of an earlier pixel roguelike of ours; the game code lives in `Arc-Dungeon/` (folder name kept from its testnet edition for path compatibility). The Bounty Dungeon chest-and-sword logo is an original pixel mark. Pixel art tiles come from the 0x72 dungeon tilesets; the original asset and vendor licenses are kept under `Arc-Dungeon/apps/web/assets` and `Arc-Dungeon/apps/web/vendor`.

## Disclaimer

Bounty Dungeon is an independent project built on Arc. It is not affiliated with, sponsored or endorsed by Circle or Arc. "Arc" and "Arc Studio" are used only to describe the network and tools the project runs on.

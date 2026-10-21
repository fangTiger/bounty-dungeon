# Bounty Dungeon

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Bounty Dungeon — player-posted USDC bounties on replay-verified Arc-Dungeon runs. A player locks 0.01–10 USDC on a finished run; challengers replay the same seed and the first strictly higher score within 24 h claims it; otherwise anyone can call refund() to return it to the poster.

## Deployed Contracts

| Contract | Version | Network | Address | Explorer |
|---|---|---|---|---|
| DungeonBounty | v1 (no timelock) | Arc Testnet | 0x7ceda67cbab25ba224da864d865cb46eee74175c | https://explorer.testnet.arc.io/address/0x7ceda67cbab25ba224da864d865cb46eee74175c |
| DungeonBounty | v2 (with timelock) | Arc Testnet | 0x084422ce04bf2b60889ebbc6fba444e9441a507b | https://explorer.testnet.arc.io/address/0x084422ce04bf2b60889ebbc6fba444e9441a507b |
| DungeonBounty | v3 (seed-per-bounty) | Arc Testnet | 0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4 | https://explorer.testnet.arc.io/address/0x2ff27f2d99c85926e5f013f1967a94d5a1de5ce4 |
| DungeonBounty | v3 (seed-per-bounty) | Arc Mainnet | 0x53b8512e4124089c88aab379c64cb8dc05b344ba | https://explorer.arc.io/address/0x53b8512e4124089c88aab379c64cb8dc05b344ba |

### v3 mainnet deploy (2026-10-20)
- network: Arc Mainnet (chain ID 5042)
- address: 0x53b8512e4124089c88aab379c64cb8dc05b344ba
- deploy tx: 0xaca6e171b1f34b8fdff0e298230b4541d8bf716905d30533274fa9dbb9e813e8
- deploy block: 26921133
- `_usdc`: 0x3600000000000000000000000000000000000000 (Arc Mainnet USDC, 6 dec)
- `_verifier`: 0xb65C38313bB2aF4c1346E416939658718FE729c4
- `_initialOwner`: 0x81d48d2c5D0744e8eF7A5c35cDceB0A27A1c707B
- `_minAmount`: 10000 (0.01 USDC), `_maxAmount`: 10000000 (10 USDC)
- Runtime bytecode identical to testnet v3 artifact (`contracts/out/DungeonBounty.sol/DungeonBounty.json`)
- Confirmed live: approve 0xf29d605d…, post #1 0x00ec01d0…, claim 0x4be71262…, post #2 0x5cc2fef608d9a3d76b408db36289124cc5ef50766aaaef6d3d4af22c412bac90

### v3 testnet deploy (2026-10-18)
- tx: 0x5b5414a3f1a3e837741657c71a1205aae8267a139a91dc28adddadcef0093837
- `_usdc`: 0x3600000000000000000000000000000000000000 (Arc Testnet USDC, 6 dec)
- `_verifier`: 0xb65C38313bB2aF4c1346E416939658718FE729c4
- `_initialOwner`: 0x81d48d2c5D0744e8eF7A5c35cDceB0A27A1c707B
- `_minAmount`: 100000 (0.1 USDC)
- `_maxAmount`: 10000000 (10 USDC)

### v3 key changes vs v2
- `RunResult.dayId` (uint32) replaced by `RunResult.seed` (bytes32) — each bounty carries its own map seed
- `Bounty.dayId` replaced by `Bounty.seed`; `seedOf()` view removed
- `WrongDay` error replaced by `WrongSeed`; `claimBounty` checks `run.seed == bounty.seed`
- `BountyPosted` event now emits `seed` instead of `dayId`; `ScoreAttested` likewise
- EIP-712 typehash updated: `RunResult(address player,bytes32 seed,uint64 score,bytes32 replayHash,bytes32 runId)`
- All day-based restrictions removed: posters can submit any freely-chosen seed

### v2 deploy (2026-10-18)
- tx: 0x92c13bd8638332e8fc4faaca9dc4e72fe0bc97b7bb68bf4766b311f08e2ec932
- `_usdc`: 0x3600000000000000000000000000000000000000
- `_verifier`: 0xb65C38313bB2aF4c1346E416939658718FE729c4
- `_initialOwner`: 0x81d48d2c5D0744e8eF7A5c35cDceB0A27A1c707B
- `_minAmount`: 100000, `_maxAmount`: 10000000

### v2 key changes vs v1
- `setVerifier` replaced by `proposeVerifier` / `acceptVerifier` / `cancelVerifierProposal` with 25-hour timelock
- `postBounty` blocks while a verifier rotation is pending (`VerifierRotationPending`)
- `refund` is direct push transfer

## Production Environment Variables

Set these in the Vercel dashboard (never commit values). Names only are listed here.

| Variable | Used by | Notes |
|---|---|---|
| `VERIFIER_PRIVATE_KEY` | `api/verify.js` | 0x-prefixed secp256k1 key; signs EIP-712 RunResult; 503 if missing |
| `CHAIN_ID` | `api/verify.js`, `api/history.js` | Integer chain id; default 5042002 (Arc Testnet), use 5042 for mainnet |
| `BOUNTY_CONTRACT` | `api/verify.js`, `api/history.js` | Deployed DungeonBounty address; default testnet v3 |
| `BOUNTY_DEPLOY_BLOCK` | `api/history.js` | Block to start event scan from; testnet default 67857284, mainnet 26921133 |
| `VITE_ARC_NETWORK` | frontend | `"testnet"` (default) or `"mainnet"`; switches chain + contract address |
| `VITE_BOUNTY_ADDRESS` | frontend | Required when `VITE_ARC_NETWORK=mainnet`; Arc mainnet contract address |

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```

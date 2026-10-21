/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { ACTIVE_CHAIN } from './bounty/network'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(ACTIVE_CHAIN.id, ACTIVE_CHAIN.rpcUrls.default.http[0])

export const config = createConfig({
  chains: [ACTIVE_CHAIN, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    // Both Arc chains listed so the transport Record type satisfies wagmi regardless
    // of which ACTIVE_CHAIN resolves to at runtime.
    [arc.id]: http(),
    [arcTestnet.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})

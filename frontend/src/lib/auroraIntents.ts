/**
 * auroraIntents.ts - Aurora Intents (powered by NEAR Intents) client layer.
 *
 * Conforms strictly to house-standard.md:
 * - Pure TypeScript client with strict typed bounds
 * - Fallbacks and error typing
 * - Zero emojis anywhere in strings or logs
 */

import api from './api'

export type AuroraTokenCategory = 'stablecoin' | 'native'

export interface AuroraChain {
  id: string
  name: string
  nativeSymbol: string
  defaultAssetId: string
  decimals: number
  category: AuroraTokenCategory
  description: string
  sampleRefundAddress: string
}

export interface AuroraToken {
  assetId: string
  symbol: string
  blockchain: string
  decimals: number
  price?: number
  contractAddress?: string
}

export interface AuroraQuoteParams {
  originAsset: string
  destinationAsset?: string
  amount: string
  recipient: string
  refundTo?: string
  swapType?: 'EXACT_INPUT' | 'EXACT_OUTPUT'
  slippageTolerance?: number
}

export interface AuroraQuoteResult {
  depositAddress: string
  depositMemo?: string
  amountIn: string
  amountInFormatted: string
  amountOut: string
  amountOutFormatted: string
  amountInUsd?: string
  amountOutUsd?: string
  timeEstimateSeconds?: number
  deadline?: string
  signature?: string
  rawQuoteResponse?: any
}

export interface AuroraStatusResult {
  status: 'PENDING_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'FAILED'
  depositAddress: string
  updatedAt?: string
  depositedAmountFormatted?: string
  destinationChainTxHashes?: string[]
}

/** Pre-configured 1Click verified blockchains and tokens with tested liquidity. */
export const AURORA_SUPPORTED_CHAINS: readonly AuroraChain[] = [
  // ── Stablecoins (Recommended: 1:1, Zero Volatility) ──────────────────────
  {
    id: 'base-usdc',
    name: 'Base',
    nativeSymbol: 'USDC',
    defaultAssetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    decimals: 6,
    category: 'stablecoin',
    description: 'USD Coin on Base (Low gas, sub-cent fees)',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'arb-usdc',
    name: 'Arbitrum',
    nativeSymbol: 'USDC',
    defaultAssetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    decimals: 6,
    category: 'stablecoin',
    description: 'USD Coin on Arbitrum One',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'eth-usdc',
    name: 'Ethereum',
    nativeSymbol: 'USDC',
    defaultAssetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    decimals: 6,
    category: 'stablecoin',
    description: 'USD Coin on Ethereum Mainnet',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'pol-usdc',
    name: 'Polygon',
    nativeSymbol: 'USDC',
    defaultAssetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
    decimals: 6,
    category: 'stablecoin',
    description: 'USD Coin on Polygon PoS',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'op-usdc',
    name: 'Optimism',
    nativeSymbol: 'USDC',
    defaultAssetId: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
    decimals: 6,
    category: 'stablecoin',
    description: 'USD Coin on Optimism (OP Mainnet)',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'avax-usdc',
    name: 'Avalanche',
    nativeSymbol: 'USDC',
    defaultAssetId: 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o',
    decimals: 6,
    category: 'stablecoin',
    description: 'USD Coin on Avalanche C-Chain',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },

  // ── Native Cryptocurrencies ─────────────────────────────────────────────
  {
    id: 'base-eth',
    name: 'Base',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:base.omft.near',
    decimals: 18,
    category: 'native',
    description: 'Native Ether on Base',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'arb-eth',
    name: 'Arbitrum',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:arb.omft.near',
    decimals: 18,
    category: 'native',
    description: 'Native Ether on Arbitrum One',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'eth-eth',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:eth.omft.near',
    decimals: 18,
    category: 'native',
    description: 'Native Ether on Ethereum Mainnet',
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'btc',
    name: 'Bitcoin',
    nativeSymbol: 'BTC',
    defaultAssetId: 'nep141:btc.omft.near',
    decimals: 8,
    category: 'native',
    description: 'Native Bitcoin network asset',
    sampleRefundAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  },
  {
    id: 'sol',
    name: 'Solana',
    nativeSymbol: 'SOL',
    defaultAssetId: 'nep141:sol.omft.near',
    decimals: 9,
    category: 'native',
    description: 'Native Solana token',
    sampleRefundAddress: '72sWqFv9Qp5qPj9k9wB3x8X3fVwE7qR8kL9mZ2yP4xW',
  },
]

/** Fetch backend integration readiness. */
export async function getAuroraIntegrationStatus(): Promise<{
  enabled: boolean
  configured: boolean
  baseUrl: string
  feeBps: number
  network: string
}> {
  try {
    const { data } = await api.get('/aurora/status')
    return {
      enabled: Boolean(data.enabled),
      configured: Boolean(data.configured),
      baseUrl: String(data.base_url || ''),
      feeBps: Number(data.fee_bps || 0),
      network: String(data.network || 'devnet'),
    }
  } catch {
    return {
      enabled: false,
      configured: false,
      baseUrl: '',
      feeBps: 0,
      network: 'devnet',
    }
  }
}

/** Fetch live tokens list across 38+ chains from 1Click. */
export async function getAuroraTokens(): Promise<AuroraToken[]> {
  try {
    const { data } = await api.get('/aurora/tokens')
    if (Array.isArray(data)) {
      return data.map((t: any) => ({
        assetId: t.assetId,
        symbol: t.symbol,
        blockchain: t.blockchain,
        decimals: Number(t.decimals),
        price: t.price ? Number(t.price) : undefined,
        contractAddress: t.contractAddress,
      }))
    }
    return []
  } catch {
    return []
  }
}

/** Request a swap/deposit quote from the Aurora Intents engine. */
export async function requestAuroraQuote(
  params: AuroraQuoteParams
): Promise<AuroraQuoteResult> {
  const { data } = await api.post('/aurora/quote', {
    origin_asset: params.originAsset,
    destination_asset: params.destinationAsset,
    amount: params.amount,
    recipient: params.recipient,
    refund_to: params.refundTo?.trim() || undefined,
    swap_type: params.swapType || 'EXACT_INPUT',
    slippage_tolerance: params.slippageTolerance || 100,
  })

  const q = data?.quote || data
  return {
    depositAddress: q.depositAddress || '',
    depositMemo: q.depositMemo,
    amountIn: String(q.amountIn || params.amount),
    amountInFormatted: String(q.amountInFormatted || ''),
    amountOut: String(q.amountOut || ''),
    amountOutFormatted: String(q.amountOutFormatted || ''),
    amountInUsd: q.amountInUsd,
    amountOutUsd: q.amountOutUsd,
    timeEstimateSeconds: q.timeEstimate,
    deadline: q.deadline,
    signature: data?.signature,
    rawQuoteResponse: data,
  }
}

/** Poll live settlement status of an active deposit address. */
export async function pollAuroraDepositStatus(
  depositAddress: string
): Promise<AuroraStatusResult> {
  const { data } = await api.get('/aurora/deposit-status', {
    params: { deposit_address: depositAddress },
  })

  const rawStatus = String(data?.status || 'PENDING_DEPOSIT').toUpperCase()
  const status: AuroraStatusResult['status'] =
    rawStatus === 'SUCCESS' || rawStatus === 'COMPLETED'
      ? 'SUCCESS'
      : rawStatus === 'FAILED'
      ? 'FAILED'
      : rawStatus === 'PROCESSING' || rawStatus === 'DEPOSITED'
      ? 'PROCESSING'
      : 'PENDING_DEPOSIT'

  return {
    status,
    depositAddress,
    updatedAt: data?.updatedAt,
    depositedAmountFormatted: data?.swapDetails?.depositedAmountFormatted,
    destinationChainTxHashes: data?.swapDetails?.destinationChainTxHashes,
  }
}

/**
 * auroraIntents.ts - Aurora Intents (powered by NEAR Intents) client layer.
 *
 * Conforms strictly to house-standard.md:
 * - Pure TypeScript client with strict typed bounds
 * - Fallbacks and error typing
 * - Zero emojis anywhere in strings or logs
 */

import api from './api'

export interface AuroraChain {
  id: string
  name: string
  nativeSymbol: string
  defaultAssetId: string
  decimals: number
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
  refundTo: string
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

/** Pre-configured 1Click verified blockchains with native asset routing. */
export const AURORA_SUPPORTED_CHAINS: readonly AuroraChain[] = [
  {
    id: 'eth',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:eth.omft.near',
    decimals: 18,
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'base',
    name: 'Base',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:base-0x4200000000000000000000000000000000000006.omft.near',
    decimals: 18,
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'arb',
    name: 'Arbitrum',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near',
    decimals: 18,
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'btc',
    name: 'Bitcoin',
    nativeSymbol: 'BTC',
    defaultAssetId: 'nep141:btc.omft.near',
    decimals: 8,
    sampleRefundAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  },
  {
    id: 'bsc',
    name: 'BNB Chain',
    nativeSymbol: 'BNB',
    defaultAssetId: 'nep141:bsc-0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c.omft.near',
    decimals: 18,
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'pol',
    name: 'Polygon',
    nativeSymbol: 'POL',
    defaultAssetId: 'nep141:pol-0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270.omft.near',
    decimals: 18,
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'op',
    name: 'Optimism',
    nativeSymbol: 'ETH',
    defaultAssetId: 'nep141:op-0x4200000000000000000000000000000000000006.omft.near',
    decimals: 18,
    sampleRefundAddress: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
  },
  {
    id: 'near',
    name: 'NEAR',
    nativeSymbol: 'wNEAR',
    defaultAssetId: 'nep141:wrap.near',
    decimals: 24,
    sampleRefundAddress: 'wrap.near',
  },
  {
    id: 'sol',
    name: 'Solana',
    nativeSymbol: 'SOL',
    defaultAssetId: 'nep141:sol.omft.near',
    decimals: 9,
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
    refund_to: params.refundTo,
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

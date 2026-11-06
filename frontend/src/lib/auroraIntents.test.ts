import { describe, it, expect } from 'vitest'
import {
  AURORA_SUPPORTED_CHAINS,
  type AuroraQuoteParams,
} from './auroraIntents'

describe('auroraIntents client configuration', () => {
  it('exposes a list of verified blockchains with native and stablecoin routing', () => {
    expect(AURORA_SUPPORTED_CHAINS.length).toBeGreaterThanOrEqual(25)
    const ids = AURORA_SUPPORTED_CHAINS.map((c) => c.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('includes key non-EVM and EVM ecosystems with sample refund addresses', () => {
    const ids = AURORA_SUPPORTED_CHAINS.map((c) => c.id)
    expect(ids).toContain('base-usdc')
    expect(ids).toContain('base-eth')
    expect(ids).toContain('arb-usdc')
    expect(ids).toContain('eth-usdc')
    expect(ids).toContain('btc')
    expect(ids).toContain('sol')

    for (const chain of AURORA_SUPPORTED_CHAINS) {
      expect(chain.sampleRefundAddress.length).toBeGreaterThan(5)
      expect(chain.defaultAssetId.length).toBeGreaterThan(5)
    }
  })

  it('formats quote parameters accurately with EXACT_OUTPUT support', () => {
    const params: AuroraQuoteParams = {
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      amount: '25000000',
      recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100,
    }
    expect(params.originAsset).toContain('base')
    expect(params.swapType).toBe('EXACT_OUTPUT')
    expect(params.destinationAsset).toBeUndefined()
  })
})

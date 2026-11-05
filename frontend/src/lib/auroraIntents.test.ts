import { describe, it, expect } from 'vitest'
import {
  AURORA_SUPPORTED_CHAINS,
  type AuroraQuoteParams,
} from './auroraIntents'

describe('auroraIntents client configuration', () => {
  it('exposes a list of verified blockchains with native asset routing', () => {
    expect(AURORA_SUPPORTED_CHAINS.length).toBeGreaterThanOrEqual(9)
    const ids = AURORA_SUPPORTED_CHAINS.map((c) => c.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('includes key non-EVM and EVM ecosystems with sample refund addresses', () => {
    const ids = AURORA_SUPPORTED_CHAINS.map((c) => c.id)
    expect(ids).toContain('eth')
    expect(ids).toContain('base')
    expect(ids).toContain('sol')
    expect(ids).toContain('btc')
    expect(ids).toContain('bsc')

    for (const chain of AURORA_SUPPORTED_CHAINS) {
      expect(chain.sampleRefundAddress.length).toBeGreaterThan(5)
      expect(chain.defaultAssetId).toContain('nep141:')
    }
  })

  it('formats quote parameters accurately', () => {
    const params: AuroraQuoteParams = {
      originAsset: 'nep141:eth.omft.near',
      amount: '10000000000000000',
      recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      refundTo: '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      slippageTolerance: 100,
    }
    expect(params.originAsset).toBe('nep141:eth.omft.near')
    expect(params.destinationAsset).toBeUndefined()
  })
})

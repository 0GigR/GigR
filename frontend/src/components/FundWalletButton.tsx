import { useCallback } from 'react'
import { OnrampWebSDK } from '@onramp.money/onramp-web-sdk'
import { Button } from '@/components/ui/button'
import { Wallet } from 'lucide-react'

const IS_TESTING = import.meta.env.VITE_TESTING === 'true'

// Sandbox appId is always 2 per onramp.money docs
const APP_ID = IS_TESTING ? 2 : Number(import.meta.env.VITE_ONRAMP_APP_ID ?? 1)

interface FundWalletButtonProps {
  walletAddress: string
}

export function FundWalletButton({ walletAddress }: FundWalletButtonProps) {
  const handleFund = useCallback(() => {
    const config: Record<string, unknown> = {
      appId: APP_ID,
      flowType: 1, // onramp: fiat → crypto
      walletAddress,
    }

    if (IS_TESTING) {
      // Sandbox (appId=2) supports USDT on Polygon — omit network to let widget pick default
      config.coinCode = 'usdc'
      config.network = 'solana'
    } else {
      config.coinCode = 'usdc'
      config.network = 'solana'
    }

    const instance = new OnrampWebSDK(config)

    instance.on('TX_EVENTS', (e: unknown) => {
      console.log('[onramp] TX_EVENT', e)
    })

    instance.on('WIDGET_EVENTS', (e: unknown) => {
      const event = e as { type: string }
      console.log('[onramp] WIDGET_EVENT', event)
      if (event.type === 'ONRAMP_WIDGET_CLOSE_REQUEST_CONFIRMED') {
        instance.close()
      }
    })

    instance.show()
  }, [walletAddress])

  return (
    <Button variant="outline" onClick={handleFund}>
      <Wallet className="w-4 h-4 mr-2" />
      {IS_TESTING ? 'Fund Wallet (Sandbox)' : 'Fund Wallet'}
    </Button>
  )
}

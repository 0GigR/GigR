import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useState } from 'react'
import { Wallet } from 'lucide-react'

interface Props {
  walletAddress: string
}

export function FundWalletButton({ walletAddress }: Props) {
  const [open, setOpen] = useState(false)
  const appId = import.meta.env.VITE_ONRAMP_APP_ID

  // If Onramp Money is configured, use their real widget
  const handleOnramp = () => {
    if (appId && (window as any).Onramp) {
      new (window as any).Onramp({
        appId: Number(appId),
        address: walletAddress,
        networks: ['solana'],
        tokens: ['USDC'],
      }).show()
      return
    }
    // Fallback: show faucet instructions
    setOpen(true)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOnramp}>
        <Wallet className="w-4 h-4 mr-1" /> Fund Wallet
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md bg-white text-black">
          <DialogHeader>
            <DialogTitle>Fund Your Wallet (Devnet)</DialogTitle>
            <DialogDescription>
              On Devnet, use the free Circle USDC faucet to get test funds.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-sm font-medium mb-2">Your wallet address:</p>
              <code className="text-xs break-all bg-gray-100 p-2 rounded block">{walletAddress}</code>
            </div>
            <ol className="text-sm text-gray-600 space-y-2 list-decimal list-inside">
              <li>Copy the wallet address above</li>
              <li>Go to <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">faucet.circle.com</a></li>
              <li>Select "Solana Devnet"</li>
              <li>Paste your wallet address</li>
              <li>Select "USDC" and request tokens</li>
              <li>Funds arrive in ~30 seconds</li>
            </ol>
            <Button onClick={() => window.open('https://faucet.circle.com', '_blank')} className="w-full bg-black text-white">
              Open Circle Faucet
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
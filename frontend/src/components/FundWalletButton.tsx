import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useState, useEffect } from 'react'
import { Wallet, Globe, ArrowRight, Loader2, Copy, Zap } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { isFeatureEnabled } from '@/lib/featureFlags'
import {
  AURORA_SUPPORTED_CHAINS,
  requestAuroraQuote,
  pollAuroraDepositStatus,
  simulateAuroraDevnetSettlement,
  type AuroraQuoteResult,
  type AuroraStatusResult,
} from '@/lib/auroraIntents'
import { AuroraTokenSelect } from '@/components/AuroraTokenSelect'
import { Input } from '@/components/ui/input'

interface Props {
  walletAddress: string
}

export function FundWalletButton({ walletAddress }: Props) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selectedChainId, setSelectedChainId] = useState('base-usdc')
  const [usdcAmount, setUsdcAmount] = useState('25')
  const [refundAddress, setRefundAddress] = useState('')
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteResult, setQuoteResult] = useState<AuroraQuoteResult | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [depositStatus, setDepositStatus] = useState<AuroraStatusResult | null>(null)
  const [isSimulating, setIsSimulating] = useState(false)

  const auroraEnabled = isFeatureEnabled('auroraIntents')
  const appId = import.meta.env.VITE_ONRAMP_APP_ID

  const selectedChain =
    AURORA_SUPPORTED_CHAINS.find((c) => c.id === selectedChainId) ||
    AURORA_SUPPORTED_CHAINS[0]

  useEffect(() => {
    setQuoteResult(null)
    setQuoteError(null)
    setDepositStatus(null)
  }, [selectedChainId])

  // Polling deposit settlement status
  useEffect(() => {
    if (!quoteResult?.depositAddress) return

    const interval = setInterval(async () => {
      try {
        const st = await pollAuroraDepositStatus(quoteResult.depositAddress)
        setDepositStatus(st)
        if (st.status === 'SUCCESS' || st.status === 'FAILED') {
          clearInterval(interval)
          if (st.status === 'SUCCESS') {
            toast.success('Funds arrived! Your Solana balance has been credited.')
            queryClient.invalidateQueries({ queryKey: ['wallet-balance'] })
          }
        }
      } catch {
        // Silently tolerate transient polling drops
      }
    }, 4000)

    return () => clearInterval(interval)
  }, [quoteResult?.depositAddress, queryClient])

  const handleOpen = () => {
    if (!auroraEnabled && appId && (window as any).Onramp) {
      new (window as any).Onramp({
        appId: Number(appId),
        address: walletAddress,
        networks: ['solana'],
        tokens: ['USDC'],
      }).show()
      return
    }
    setOpen(true)
  }

  const handleFetchQuote = async () => {
    setQuoteLoading(true)
    setQuoteError(null)
    setQuoteResult(null)
    setDepositStatus(null)

    try {
      const parsedUsdc = parseFloat(usdcAmount)
      if (isNaN(parsedUsdc) || parsedUsdc <= 0) {
        throw new Error('Please enter a valid USDC deposit amount.')
      }

      // Escrows and balances settle in Solana USDC (6 decimals)
      const targetMicroUsdc = Math.round(parsedUsdc * 1_000_000).toString()

      const res = await requestAuroraQuote({
        originAsset: selectedChain.defaultAssetId,
        amount: targetMicroUsdc,
        recipient: walletAddress,
        refundTo: refundAddress.trim() || undefined,
        swapType: 'EXACT_OUTPUT',
      })
      setQuoteResult(res)
    } catch (err: any) {
      setQuoteError(
        err?.response?.data?.detail ||
          err?.message ||
          'Failed to retrieve live quote. Please check connection and try again.'
      )
    } finally {
      setQuoteLoading(false)
    }
  }

  const handleSimulateDevnetDeposit = async () => {
    setIsSimulating(true)
    toast.info('Simulating incoming deposit from 1Click solver network on Devnet...')
    try {
      const amt = parseFloat(usdcAmount) || 5.0
      const res = await simulateAuroraDevnetSettlement({
        recipient: walletAddress,
        amountUsdc: amt,
      })
      toast.success(
        `Settlement confirmed on Solana Devnet! Credited ${amt} USDC. tx: ${res.signature?.slice(0, 8)}...`
      )
      queryClient.invalidateQueries({ queryKey: ['wallet-balance'] })
      queryClient.invalidateQueries({ queryKey: ['wallet'] })
      setOpen(false)
    } catch (err: any) {
      toast.error(
        err?.response?.data?.detail ||
          err?.message ||
          'Simulated Devnet settlement failed.'
      )
    } finally {
      setIsSimulating(false)
    }
  }

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen}>
        <Wallet className="w-4 h-4 mr-1" /> Fund Wallet
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg bg-card text-foreground border-border">
          <DialogHeader>
            <DialogTitle>Fund Your Wallet (Devnet)</DialogTitle>
            <DialogDescription>
              {auroraEnabled
                ? 'Deposit USDC directly from 38+ external chains using Aurora Intents or use the free devnet faucet.'
                : 'On Devnet, use the free Circle USDC faucet to get test funds.'}
            </DialogDescription>
          </DialogHeader>

          {auroraEnabled ? (
            <Tabs defaultValue="aurora" className="w-full mt-2">
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="aurora" className="flex items-center gap-1.5 text-xs">
                  <Globe className="w-3.5 h-3.5" /> Any Chain (Aurora)
                </TabsTrigger>
                <TabsTrigger value="faucet" className="flex items-center gap-1.5 text-xs">
                  <Wallet className="w-3.5 h-3.5" /> Circle Faucet
                </TabsTrigger>
              </TabsList>

              <TabsContent value="aurora" className="space-y-4 pt-3">
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
                      Deposit Source Chain & Token
                    </label>
                    <AuroraTokenSelect
                      selectedChainId={selectedChainId}
                      onSelect={(chain) => setSelectedChainId(chain.id)}
                      disabled={quoteLoading}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        USDC to Receive (Solana)
                      </label>
                      <Input
                        className="mt-1 h-9 text-sm"
                        value={usdcAmount}
                        onChange={(e) => setUsdcAmount(e.target.value)}
                        placeholder="25"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          Refund Address
                        </label>
                        <span className="text-[10px] text-muted-foreground">Optional</span>
                      </div>
                      <Input
                        className="mt-1 h-9 text-xs font-mono"
                        value={refundAddress}
                        onChange={(e) => setRefundAddress(e.target.value)}
                        placeholder={`Your ${selectedChain.name} address`}
                      />
                    </div>
                  </div>

                  <Button
                    onClick={handleFetchQuote}
                    disabled={quoteLoading}
                    className="w-full text-xs font-medium"
                  >
                    {quoteLoading ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Querying Aurora 1Click...
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        Generate Guaranteed Deposit Address <ArrowRight className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </Button>

                  {quoteError && (
                    <p className="text-xs text-destructive bg-destructive/10 p-2.5 rounded-lg border border-destructive/20 font-mono">
                      {quoteError}
                    </p>
                  )}

                  {quoteResult && (
                    <div className="bg-muted/50 p-3.5 rounded-xl space-y-3 border border-border">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-foreground">
                          Deposit Address on {selectedChain.name}:
                        </span>
                        {depositStatus && (
                          <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                            {depositStatus.status}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 bg-background p-2 rounded-lg border border-border">
                        <code className="text-xs break-all font-mono text-primary flex-1">
                          {quoteResult.depositAddress}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleCopy(quoteResult.depositAddress)}
                          className="h-7 w-7 shrink-0"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      {copied && (
                        <p className="text-[10px] text-primary font-mono">
                          Copied to clipboard.
                        </p>
                      )}

                      <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                        <div>
                          <span className="text-muted-foreground block">
                            You Send:
                          </span>
                          <span className="font-semibold text-foreground">
                            {quoteResult.amountInFormatted} {selectedChain.nativeSymbol}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">
                            You Receive:
                          </span>
                          <span className="font-semibold text-primary">
                            {quoteResult.amountOutFormatted} USDC (Solana)
                          </span>
                        </div>
                      </div>

                      <div className="text-[11px] text-muted-foreground pt-1 border-t border-border">
                        Send from your {selectedChain.name} wallet. Aurora automatically swaps and credits your Gigr Solana USDC balance.
                      </div>

                      <Button
                        variant="outline"
                        className="w-full h-8 text-xs font-medium"
                        disabled={isSimulating}
                        onClick={handleSimulateDevnetDeposit}
                        title="Simulate settlement for Devnet testing without real funds"
                      >
                        {isSimulating ? (
                          <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                        ) : (
                          <Zap className="w-3.5 h-3.5 mr-1 text-amber-500" />
                        )}
                        Simulate Deposit Settlement (Devnet Test)
                      </Button>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="faucet" className="space-y-4 pt-3">
                <div className="bg-muted/40 rounded-lg p-3 border border-border">
                  <p className="text-sm font-medium mb-2 text-foreground">Your wallet address:</p>
                  <code className="text-xs break-all bg-background p-2 rounded border border-border block text-primary font-mono">
                    {walletAddress}
                  </code>
                </div>
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>Copy the wallet address above</li>
                  <li>
                    Go to{' '}
                    <a
                      href="https://faucet.circle.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline"
                    >
                      faucet.circle.com
                    </a>
                  </li>
                  <li>Select "Solana Devnet"</li>
                  <li>Paste your wallet address</li>
                  <li>Select "USDC" and request tokens</li>
                  <li>Funds arrive in ~30 seconds</li>
                </ol>
                <Button
                  onClick={() => window.open('https://faucet.circle.com', '_blank')}
                  className="w-full text-xs font-medium"
                >
                  Open Circle Faucet
                </Button>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="space-y-4 py-4">
              <div className="bg-muted/40 rounded-lg p-3 border border-border">
                <p className="text-sm font-medium mb-2 text-foreground">Your wallet address:</p>
                <code className="text-xs break-all bg-background p-2 rounded border border-border block text-primary font-mono">
                  {walletAddress}
                </code>
              </div>
              <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                <li>Copy the wallet address above</li>
                <li>
                  Go to{' '}
                  <a
                    href="https://faucet.circle.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    faucet.circle.com
                  </a>
                </li>
                <li>Select "Solana Devnet"</li>
                <li>Paste your wallet address</li>
                <li>Select "USDC" and request tokens</li>
                <li>Funds arrive in ~30 seconds</li>
              </ol>
              <Button
                onClick={() => window.open('https://faucet.circle.com', '_blank')}
                className="w-full text-xs font-medium"
              >
                Open Circle Faucet
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

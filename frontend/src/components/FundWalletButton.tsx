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
import { Wallet, Globe, ArrowRight, Loader2, Copy } from 'lucide-react'
import { isFeatureEnabled } from '@/lib/featureFlags'
import {
  AURORA_SUPPORTED_CHAINS,
  requestAuroraQuote,
  pollAuroraDepositStatus,
  type AuroraQuoteResult,
  type AuroraStatusResult,
} from '@/lib/auroraIntents'

interface Props {
  walletAddress: string
}

export function FundWalletButton({ walletAddress }: Props) {
  const [open, setOpen] = useState(false)
  const [selectedChainId, setSelectedChainId] = useState('base')
  const [humanAmount, setHumanAmount] = useState('0.01')
  const [refundAddress, setRefundAddress] = useState(
    '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe'
  )
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteResult, setQuoteResult] = useState<AuroraQuoteResult | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [depositStatus, setDepositStatus] = useState<AuroraStatusResult | null>(null)

  const auroraEnabled = isFeatureEnabled('auroraIntents')
  const appId = import.meta.env.VITE_ONRAMP_APP_ID

  const selectedChain =
    AURORA_SUPPORTED_CHAINS.find((c) => c.id === selectedChainId) ||
    AURORA_SUPPORTED_CHAINS[0]

  useEffect(() => {
    if (selectedChain) {
      setRefundAddress(selectedChain.sampleRefundAddress)
    }
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
        }
      } catch {
        // Silently tolerate transient polling drops
      }
    }, 4000)

    return () => clearInterval(interval)
  }, [quoteResult?.depositAddress])

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
      const parsedFloat = parseFloat(humanAmount)
      if (isNaN(parsedFloat) || parsedFloat <= 0) {
        throw new Error('Please enter a valid deposit amount.')
      }

      // Convert human amount to base units using chain decimals
      const atomicMultiplier = BigInt(10) ** BigInt(selectedChain.decimals)
      const wholePart = Math.floor(parsedFloat)
      const fractionalPart = parsedFloat - wholePart
      const atomicAmount = (
        BigInt(wholePart) * atomicMultiplier +
        BigInt(Math.round(fractionalPart * Number(atomicMultiplier)))
      ).toString()

      const res = await requestAuroraQuote({
        originAsset: selectedChain.defaultAssetId,
        amount: atomicAmount,
        recipient: walletAddress,
        refundTo: refundAddress.trim(),
      })
      setQuoteResult(res)
    } catch (err: any) {
      setQuoteError(
        err?.response?.data?.detail ||
          err?.message ||
          'Failed to retrieve live quote. Verify the refund address format for the source chain.'
      )
    } finally {
      setQuoteLoading(false)
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
        <DialogContent className="sm:max-w-lg bg-white dark:bg-card text-black dark:text-foreground">
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
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Deposit Source Chain
                    </label>
                    <select
                      className="w-full mt-1 p-2 rounded-md border border-gray-200 dark:border-border bg-transparent text-sm"
                      value={selectedChainId}
                      onChange={(e) => setSelectedChainId(e.target.value)}
                    >
                      {AURORA_SUPPORTED_CHAINS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.nativeSymbol})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        Deposit Amount ({selectedChain.nativeSymbol})
                      </label>
                      <input
                        type="text"
                        className="w-full mt-1 p-2 rounded-md border border-gray-200 dark:border-border bg-transparent text-sm"
                        value={humanAmount}
                        onChange={(e) => setHumanAmount(e.target.value)}
                        placeholder="0.01"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        Your Refund Address ({selectedChain.id.toUpperCase()})
                      </label>
                      <input
                        type="text"
                        className="w-full mt-1 p-2 rounded-md border border-gray-200 dark:border-border bg-transparent text-xs font-mono"
                        value={refundAddress}
                        onChange={(e) => setRefundAddress(e.target.value)}
                        placeholder="Source chain address for refunds"
                      />
                    </div>
                  </div>

                  <Button
                    onClick={handleFetchQuote}
                    disabled={quoteLoading}
                    className="w-full bg-black text-white dark:bg-primary dark:text-primary-foreground text-xs font-medium"
                  >
                    {quoteLoading ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Querying Aurora 1Click...
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        Generate Any-Chain Deposit Address <ArrowRight className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </Button>

                  {quoteError && (
                    <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950/40 p-2.5 rounded-lg border border-red-200 dark:border-red-900/40 font-mono">
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
                          className="h-7 w-7 flex-shrink-0"
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
                            ~{quoteResult.amountOutFormatted} USDC (Solana)
                          </span>
                        </div>
                      </div>

                      <div className="text-[11px] text-muted-foreground pt-1 border-t border-border">
                        Send from any {selectedChain.name} wallet. Aurora automatically routes, swaps, and credits your Solana Devnet balance.
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="faucet" className="space-y-4 pt-3">
                <div className="bg-gray-50 dark:bg-background rounded-lg p-3">
                  <p className="text-sm font-medium mb-2">Your wallet address:</p>
                  <code className="text-xs break-all bg-gray-100 dark:bg-muted p-2 rounded block">
                    {walletAddress}
                  </code>
                </div>
                <ol className="text-sm text-gray-600 dark:text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>Copy the wallet address above</li>
                  <li>
                    Go to{' '}
                    <a
                      href="https://faucet.circle.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 underline"
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
                  className="w-full bg-black text-white"
                >
                  Open Circle Faucet
                </Button>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="space-y-4 py-4">
              <div className="bg-gray-50 dark:bg-background rounded-lg p-3">
                <p className="text-sm font-medium mb-2">Your wallet address:</p>
                <code className="text-xs break-all bg-gray-100 dark:bg-muted p-2 rounded block">
                  {walletAddress}
                </code>
              </div>
              <ol className="text-sm text-gray-600 dark:text-muted-foreground space-y-2 list-decimal list-inside">
                <li>Copy the wallet address above</li>
                <li>
                  Go to{' '}
                  <a
                    href="https://faucet.circle.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 underline"
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
                className="w-full bg-black text-white"
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

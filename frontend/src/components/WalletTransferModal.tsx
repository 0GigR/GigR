import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Send, Loader2, ExternalLink } from 'lucide-react'
import api, { extractError } from '@/lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface WalletTransferModalProps {
  open: boolean
  onClose: () => void
  currentSolBalance?: number
  currentUsdcBalance?: string
}

export function WalletTransferModal({
  open,
  onClose,
  currentSolBalance = 0,
  currentUsdcBalance = '0.00',
}: WalletTransferModalProps) {
  const queryClient = useQueryClient()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<'SOL' | 'USDC'>('SOL')
  const [txHash, setTxHash] = useState<string | null>(null)

  const transferMutation = useMutation({
    mutationFn: async () => {
      const parsedAmount = parseFloat(amount)
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new Error('Please enter a valid transfer amount.')
      }
      const { data } = await api.post('/users/me/transfer', {
        recipient: recipient.trim(),
        amount: parsedAmount,
        currency,
      })
      return data
    },
    onSuccess: (data) => {
      setTxHash(data.tx_hash)
      toast.success(`Successfully sent ${data.amount} ${data.currency}!`)
      queryClient.invalidateQueries({ queryKey: ['wallet-balance'] })
    },
    onError: (err: any) => {
      toast.error(extractError(err, 'Transfer failed'))
    },
  })

  const handleReset = () => {
    setRecipient('')
    setAmount('')
    setTxHash(null)
    onClose()
  }

  const solMax = Math.max(0, currentSolBalance - 0.0001)
  const usdcMax = parseFloat(currentUsdcBalance)

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? handleReset() : undefined)}>
      <DialogContent className="max-w-md p-6 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Send className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            Transfer In-App Funds
          </DialogTitle>
        </DialogHeader>

        {txHash ? (
          <div className="space-y-4 py-3 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto">
              <Send className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                Transfer Completed
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Your transfer of {amount} {currency} was verified on Solana.
              </p>
            </div>

            <div className="p-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-left">
              <span className="text-[10px] text-gray-400 block font-mono">Transaction Signature</span>
              <p className="text-xs font-mono break-all text-gray-700 dark:text-gray-300">
                {txHash}
              </p>
            </div>

            <div className="flex gap-2 justify-center pt-2">
              <a
                href={`https://explorer.solana.com/tx/${txHash}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:underline font-medium"
              >
                View on Solana Explorer <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>

            <Button
              className="w-full bg-black text-white hover:bg-gray-800 dark:bg-white dark:text-black mt-2"
              onClick={handleReset}
            >
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <p className="text-xs text-gray-500 leading-relaxed">
              Send SOL or USDC directly to another Gigr user (via @username or email) or to any external Solana wallet address.
            </p>

            <div className="flex rounded-xl bg-gray-100 dark:bg-gray-800 p-1 text-xs">
              <button
                type="button"
                onClick={() => setCurrency('SOL')}
                className={`flex-1 py-1.5 rounded-lg font-medium transition-colors ${
                  currency === 'SOL'
                    ? 'bg-white dark:bg-gray-900 text-black dark:text-white shadow-2xs font-bold'
                    : 'text-gray-500 hover:text-black dark:hover:text-white'
                }`}
              >
                SOL ({currentSolBalance.toFixed(4)})
              </button>
              <button
                type="button"
                onClick={() => setCurrency('USDC')}
                className={`flex-1 py-1.5 rounded-lg font-medium transition-colors ${
                  currency === 'USDC'
                    ? 'bg-white dark:bg-gray-900 text-black dark:text-white shadow-2xs font-bold'
                    : 'text-gray-500 hover:text-black dark:hover:text-white'
                }`}
              >
                USDC (${currentUsdcBalance})
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Recipient
              </label>
              <Input
                placeholder="Gigr @username, email, or Solana address"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="text-xs font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label className="font-semibold text-gray-700 dark:text-gray-300">
                  Amount ({currency})
                </label>
                <button
                  type="button"
                  onClick={() => setAmount(currency === 'SOL' ? solMax.toFixed(4) : usdcMax.toFixed(2))}
                  className="text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline font-medium"
                >
                  Max: {currency === 'SOL' ? `${solMax.toFixed(4)} SOL` : `$${usdcMax.toFixed(2)}`}
                </button>
              </div>
              <Input
                type="number"
                step="any"
                min="0.000001"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="text-xs font-mono font-bold"
              />
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!recipient.trim() || !amount || parseFloat(amount) <= 0 || transferMutation.isPending}
                onClick={() => transferMutation.mutate()}
                className="bg-black hover:bg-gray-800 text-white text-xs font-semibold px-4"
              >
                {transferMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                ) : (
                  <Send className="w-3.5 h-3.5 mr-1" />
                )}
                Send {currency}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

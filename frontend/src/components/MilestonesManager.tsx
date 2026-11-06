import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { CheckCircle, Clock, Plus, ShieldCheck, Loader2, ChevronDown, ChevronUp, Globe, Copy, ArrowRight } from 'lucide-react'
import api, { extractError } from '@/lib/api'
import { useRail } from '@/lib/config'
import { isFeatureEnabled } from '@/lib/featureFlags'
import { startMilestoneCheckout, redirectToPayPal } from '@/lib/paypal'
import { fmtPrice, useCurrencyStore } from '@/store/currencyStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { PriceInput } from '@/components/PriceInput'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  AURORA_SUPPORTED_CHAINS,
  requestAuroraQuote,
  pollAuroraDepositStatus,
  type AuroraQuoteResult,
  type AuroraStatusResult,
} from '@/lib/auroraIntents'
import { AuroraTokenSelect } from '@/components/AuroraTokenSelect'

export interface Milestone {
  id: string
  job_id: string
  milestone_index: number
  title: string
  description?: string | null
  amount: number | string
  status: 'pending' | 'funded' | 'under_review' | 'submitted' | 'released' | 'refunded' | 'disputed'
  paypal_amount?: number | string | null
  work_submitted_at?: string | null
  auto_release_at?: string | null
  created_at?: string
  funded_at?: string | null
  released_at?: string | null
}

interface MilestonesManagerProps {
  jobId: string
  jobTitle?: string
  jobPrice: number
  jobStatus: string
  isClient: boolean
  isProvider: boolean
  compact?: boolean
  onUpdated?: () => void
}

export function MilestonesManager({
  jobId,
  jobPrice,
  jobStatus,
  isClient,
  isProvider,
  compact = false,
  onUpdated,
}: MilestonesManagerProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { isPayPal } = useRail()

  const [showAddForm, setShowAddForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [isExpanded, setIsExpanded] = useState(!compact)

  // Aurora Intents cross-chain milestone funding
  const auroraEnabled = isFeatureEnabled('auroraIntents')
  const [auroraMilestone, setAuroraMilestone] = useState<Milestone | null>(null)
  const [selectedChainId, setSelectedChainId] = useState('base-usdc')
  const [refundAddress, setRefundAddress] = useState('')
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteResult, setQuoteResult] = useState<AuroraQuoteResult | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [depositStatus, setDepositStatus] = useState<AuroraStatusResult | null>(null)

  const { data: walletInfo } = useQuery<{ wallet_public_key: string }>({
    queryKey: ['wallet'],
    queryFn: async () => {
      const { data } = await api.get('/users/me/wallet')
      return data
    },
    enabled: isClient && !isPayPal && auroraEnabled,
  })

  // Live exchange rate for converting stored Naira milestone amounts to Solana USDC
  const { data: rateData } = useQuery<{ ngn_per_usd: number }>({
    queryKey: ['exchange-rate'],
    queryFn: async () => {
      const { data } = await api.get('/jobs/exchange-rate')
      return data
    },
    staleTime: 60000,
    enabled: auroraEnabled,
  })

  const displayRates = useCurrencyStore((s) => s.rates)
  const ngnRate =
    rateData?.ngn_per_usd ||
    (displayRates?.USD && displayRates.USD > 0 ? 1 / displayRates.USD : 1600.0)

  const getMilestoneUsdc = (m: Milestone | null): number => {
    if (!m) return 0
    const ngn = parseFloat(String(m.amount || 0))
    if (isNaN(ngn) || ngn <= 0) return 0
    return ngn / ngnRate
  }

  const selectedChain =
    AURORA_SUPPORTED_CHAINS.find((c) => c.id === selectedChainId) ||
    AURORA_SUPPORTED_CHAINS[0]

  useEffect(() => {
    // Reset quote on chain or milestone change
    setQuoteResult(null)
    setQuoteError(null)
    setDepositStatus(null)
  }, [selectedChainId, auroraMilestone])

  useEffect(() => {
    if (!quoteResult?.depositAddress) return

    const interval = setInterval(async () => {
      try {
        const st = await pollAuroraDepositStatus(quoteResult.depositAddress)
        setDepositStatus(st)
        if (st.status === 'SUCCESS' || st.status === 'FAILED') {
          clearInterval(interval)
          if (st.status === 'SUCCESS' && auroraMilestone) {
            toast.success('Any-chain deposit confirmed! Locking escrow on Solana...')
            fundMilestoneMutation.mutate(auroraMilestone.id)
            setAuroraMilestone(null)
          }
        }
      } catch {
        // Tolerated transient polling error
      }
    }, 4000)

    return () => clearInterval(interval)
  }, [quoteResult?.depositAddress, auroraMilestone])

  const handleFetchMilestoneQuote = async () => {
    if (!auroraMilestone || !walletInfo?.wallet_public_key) {
      setQuoteError('Solana wallet not available. Please ensure you are logged in.')
      return
    }
    setQuoteLoading(true)
    setQuoteError(null)
    setQuoteResult(null)
    setDepositStatus(null)

    try {
      const milestonePriceNgn = parseFloat(String(auroraMilestone.amount))
      if (isNaN(milestonePriceNgn) || milestonePriceNgn <= 0) {
        throw new Error('Invalid milestone amount.')
      }

      // Convert stored Naira price to exact target USDC on Solana
      const targetUsdc = milestonePriceNgn / ngnRate
      // Escrow requires exact USDC output on Solana (6 decimals)
      const targetMicroUsdc = Math.max(1, Math.round(targetUsdc * 1_000_000)).toString()

      const res = await requestAuroraQuote({
        originAsset: selectedChain.defaultAssetId,
        amount: targetMicroUsdc,
        recipient: walletInfo.wallet_public_key,
        refundTo: refundAddress.trim() || undefined,
        swapType: 'EXACT_OUTPUT',
      })
      setQuoteResult(res)
    } catch (err: any) {
      setQuoteError(
        err?.response?.data?.detail ||
          err?.message ||
          'Failed to retrieve quote. Please check connection and try again.'
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

  const { data: milestones = [], isLoading, refetch } = useQuery<Milestone[]>({
    queryKey: ['jobMilestones', jobId],
    queryFn: async () => {
      const { data } = await api.get(`/jobs/${jobId}/milestones`)
      return Array.isArray(data) ? data : []
    },
    enabled: !!jobId,
  })

  const invalidateAll = () => {
    refetch()
    queryClient.invalidateQueries({ queryKey: ['jobMilestones', jobId] })
    queryClient.invalidateQueries({ queryKey: ['jobs'] })
    queryClient.invalidateQueries({ queryKey: ['myJobs'] })
    queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
    onUpdated?.()
  }

  // Add Milestone
  const createMilestoneMutation = useMutation({
    mutationFn: async ({ title, amount, description }: { title: string; amount: number; description?: string }) => {
      const { data } = await api.post(`/jobs/${jobId}/milestones`, {
        title,
        amount,
        description,
      })
      return data
    },
    onSuccess: () => {
      toast.success('Milestone added!')
      setShowAddForm(false)
      setNewTitle('')
      setNewAmount('')
      setNewDesc('')
      invalidateAll()
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to add milestone')),
  })

  // Fund Milestone
  const fundMilestoneMutation = useMutation({
    mutationFn: async (milestoneId: string) => {
      if (isPayPal) {
        const checkout = await startMilestoneCheckout(jobId, milestoneId)
        redirectToPayPal(checkout)
        return checkout
      }
      const { data } = await api.post(`/jobs/${jobId}/milestones/${milestoneId}/fund`)
      return data
    },
    onSuccess: () => {
      if (isPayPal) {
        toast.success('Redirecting to PayPal to approve milestone payment...')
        return
      }
      toast.success('Milestone escrow funded!')
      invalidateAll()
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to fund milestone')),
  })

  // Deliver Milestone (Provider)
  const submitMilestoneMutation = useMutation({
    mutationFn: async (milestoneId: string) => {
      const { data } = await api.post(`/jobs/${jobId}/milestones/${milestoneId}/submit-work`)
      return data
    },
    onSuccess: () => {
      toast.success('Milestone delivered! The 1-hour review timer has started.')
      invalidateAll()
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to deliver milestone')),
  })

  // Approve & Release Milestone (Client)
  const releaseMilestoneMutation = useMutation({
    mutationFn: async (milestoneId: string) => {
      const { data } = await api.post(`/jobs/${jobId}/milestones/${milestoneId}/release`)
      return data
    },
    onSuccess: () => {
      toast.success('Milestone payment released to the worker!')
      invalidateAll()
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to release milestone')),
  })

  // Calculations
  const totalMilestonesSum = milestones.reduce((sum, m) => sum + parseFloat(String(m.amount || 0)), 0)
  const totalReleased = milestones
    .filter((m) => m.status === 'released')
    .reduce((sum, m) => sum + parseFloat(String(m.amount || 0)), 0)
  const totalInFlight = milestones
    .filter((m) => m.status === 'funded' || m.status === 'under_review' || m.status === 'submitted')
    .reduce((sum, m) => sum + parseFloat(String(m.amount || 0)), 0)
  const remainingUnfunded = Math.max(0, jobPrice - totalMilestonesSum)
  const isJobActive = !['completed', 'cancelled'].includes(jobStatus)
  const isAmountExceeded = Boolean(newAmount && parseFloat(newAmount) > remainingUnfunded)

  return (
    <div className={`rounded-xl border border-border bg-card/60 ${compact ? 'p-2 sm:p-2.5 space-y-2' : 'p-3.5 space-y-3'} text-card-foreground`}>
      {/* Header bar / accordion toggle */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <h4 className="font-semibold text-xs sm:text-sm truncate">
            Milestones ({milestones.length})
          </h4>
          <span className="text-[11px] text-muted-foreground font-medium truncate">
            {fmtPrice(totalReleased)} / {fmtPrice(jobPrice)} released
          </span>
          {compact && totalInFlight > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-medium shrink-0">
              {fmtPrice(totalInFlight)} in escrow
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isClient && isJobActive && remainingUnfunded > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2.5 font-medium border-border"
              onClick={() => {
                setIsExpanded(true)
                setShowAddForm(!showAddForm)
                if (!showAddForm && remainingUnfunded > 0 && !newAmount) {
                  setNewAmount(remainingUnfunded.toString())
                }
              }}
            >
              <Plus className="w-3 h-3 mr-1" />
              Add Milestone
            </Button>
          )}
          {compact && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              <span>{isExpanded ? 'Hide' : 'Details'}</span>
              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
      </div>

      {/* Progress metrics (full mode only) */}
      {!compact && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs pt-1 border-t border-border/60">
          <div className="p-2 rounded-lg bg-background/50 border border-border/50">
            <p className="text-[10px] text-muted-foreground">Total Price</p>
            <p className="font-bold">{fmtPrice(jobPrice)}</p>
          </div>
          <div className="p-2 rounded-lg bg-background/50 border border-border/50">
            <p className="text-[10px] text-muted-foreground">Released</p>
            <p className="font-bold text-emerald-600 dark:text-emerald-400">{fmtPrice(totalReleased)}</p>
          </div>
          <div className="p-2 rounded-lg bg-background/50 border border-border/50">
            <p className="text-[10px] text-muted-foreground">In Escrow</p>
            <p className="font-bold text-indigo-600 dark:text-indigo-400">{fmtPrice(totalInFlight)}</p>
          </div>
          <div className="p-2 rounded-lg bg-background/50 border border-border/50">
            <p className="text-[10px] text-muted-foreground">Unfunded Balance</p>
            <p className={`font-bold ${remainingUnfunded > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
              {fmtPrice(remainingUnfunded)}
            </p>
          </div>
        </div>
      )}

      {/* Collapsible content */}
      {isExpanded && (
        <div className="space-y-3 pt-1">
          {/* Add Milestone Form */}
          {showAddForm && (
            <div className="p-3 rounded-xl border border-dashed border-border bg-background/80 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Create New Milestone</span>
                {remainingUnfunded > 0 && (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    Remaining balance: {fmtPrice(remainingUnfunded)}
                  </span>
                )}
              </div>
              <Input
                placeholder="Milestone title (e.g. Deposit & Materials, Phase 1)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="h-8 text-xs"
              />
              <PriceInput
                placeholder="Milestone Amount"
                value={newAmount}
                onChange={setNewAmount}
              />
              {isAmountExceeded && (
                <p className="text-[11px] text-red-500 font-medium">
                  Amount exceeds remaining job balance ({fmtPrice(remainingUnfunded)})
                </p>
              )}
              <Input
                placeholder="Deliverables / notes (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="h-8 text-xs"
              />
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  className="h-7 text-xs bg-black text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200"
                  disabled={!newTitle.trim() || !newAmount || parseFloat(newAmount) <= 0 || isAmountExceeded || createMilestoneMutation.isPending}
                  onClick={() =>
                    createMilestoneMutation.mutate({
                      title: newTitle.trim(),
                      amount: parseFloat(newAmount),
                      description: newDesc.trim() || undefined,
                    })
                  }
                >
                  {createMilestoneMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                  Save Milestone
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setShowAddForm(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Milestones list with max height containment in compact mode */}
          {isLoading ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : milestones.length === 0 ? (
            <div className="text-center py-4 px-2 border border-dashed border-border rounded-xl">
              <p className="text-xs text-muted-foreground">
                No milestones staged yet. Work can be paid in stages using milestones or in one single release.
              </p>
              {isClient && isJobActive && remainingUnfunded > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2.5 h-7 text-xs"
                  onClick={() => {
                    setNewTitle('Phase 1 Milestone')
                    setNewAmount(remainingUnfunded.toString())
                    setShowAddForm(true)
                  }}
                >
                  <Plus className="w-3 h-3 mr-1" /> Create Milestone for Balance ({fmtPrice(remainingUnfunded)})
                </Button>
              )}
            </div>
          ) : (
            <div className={`space-y-2 ${compact ? 'max-h-52 overflow-y-auto pr-1' : ''}`}>
              {milestones.map((m) => {
                const amountNum = parseFloat(String(m.amount))
                const isUnderReview = m.status === 'under_review' || m.status === 'submitted'
                const isFunded = m.status === 'funded'
                const isPending = m.status === 'pending'
                const isReleased = m.status === 'released'

                return (
                  <div
                    key={m.id}
                    className="p-3 rounded-xl border border-border bg-background flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-2xs"
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-xs">
                          {m.milestone_index}. {m.title}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            isReleased
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                              : isUnderReview
                              ? 'bg-amber-50 text-amber-700 border-amber-300 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 font-semibold'
                              : isFunded
                              ? 'bg-blue-50 text-blue-700 border-blue-200 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300'
                              : m.status === 'disputed'
                              ? 'bg-rose-50 text-rose-700 border-rose-200 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300'
                              : 'bg-gray-100 text-gray-700 dark:bg-muted dark:text-muted-foreground'
                          }
                        >
                          {isUnderReview
                            ? 'Under Review (1h)'
                            : m.status.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                        </Badge>
                        <span className="font-bold text-xs">
                          {fmtPrice(amountNum)}
                          {isPayPal && m.paypal_amount && (
                            <span className="ml-1 text-[10px] text-muted-foreground font-normal">
                              (${Number(m.paypal_amount).toFixed(2)})
                            </span>
                          )}
                        </span>
                      </div>
                      {m.description && (
                        <p className="text-[11px] text-muted-foreground line-clamp-2">
                          {m.description}
                        </p>
                      )}
                      {isUnderReview && m.auto_release_at && (
                        <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1 font-medium">
                          <Clock className="w-3 h-3" />
                          Auto-releases to worker on {new Date(m.auto_release_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} unless disputed
                        </p>
                      )}
                    </div>

                    {/* Milestone Actions */}
                    <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                      {/* Client: Fund Pending Milestone */}
                      {isClient && isPending && isJobActive && (
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-black text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200"
                            onClick={() => fundMilestoneMutation.mutate(m.id)}
                            disabled={fundMilestoneMutation.isPending}
                          >
                            {fundMilestoneMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ShieldCheck className="w-3 h-3 mr-1 text-emerald-400" />}
                            Fund Milestone
                          </Button>

                          {auroraEnabled && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs font-medium"
                              onClick={() => setAuroraMilestone(m)}
                              title="Fund this milestone from Ethereum, Base, Bitcoin, or other chains via Aurora Intents"
                            >
                              <Globe className="w-3 h-3 mr-1" />
                              Pay Any Chain
                            </Button>
                          )}
                        </div>
                      )}

                      {/* Worker: Deliver Milestone (1h Review) */}
                      {isProvider && isFunded && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs border-black text-black hover:bg-black hover:text-white dark:border-white dark:text-white dark:hover:bg-white dark:hover:text-black"
                          onClick={() => submitMilestoneMutation.mutate(m.id)}
                          disabled={submitMilestoneMutation.isPending}
                        >
                          {submitMilestoneMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                          Deliver Milestone (1h)
                        </Button>
                      )}

                      {/* Client: Approve & Release Milestone */}
                      {isClient && (isFunded || isUnderReview) && (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                            onClick={() => releaseMilestoneMutation.mutate(m.id)}
                            disabled={releaseMilestoneMutation.isPending}
                          >
                            {releaseMilestoneMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                            Approve & Release
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                            onClick={() => navigate(`/dashboard/disputes?job=${jobId}`)}
                          >
                            Dispute
                          </Button>
                        </div>
                      )}

                      {isReleased && (
                        <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                          <CheckCircle className="w-3.5 h-3.5" /> Paid & Released
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Aurora Intents Cross-Chain Milestone Funding Modal */}
      {auroraEnabled && (
        <Dialog
          open={Boolean(auroraMilestone)}
          onOpenChange={(open) => !open && setAuroraMilestone(null)}
        >
          <DialogContent className="sm:max-w-lg bg-card text-foreground border-border">
            <DialogHeader>
              <DialogTitle>Fund Milestone via Any Chain (Aurora)</DialogTitle>
              <DialogDescription>
                {auroraMilestone
                  ? `Fund ${fmtPrice(parseFloat(String(auroraMilestone.amount)))} for "${auroraMilestone.title}" using USDC, ETH, or BTC from 38+ blockchains.`
                  : 'Fund milestone with cross-chain settlement.'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              {/* Target Milestone Summary */}
              {auroraMilestone && (
                <div className="p-3 rounded-lg bg-muted/40 border border-border flex items-center justify-between text-xs">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Milestone</span>
                    <span className="font-semibold text-foreground">{auroraMilestone.title}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-muted-foreground block text-[11px]">Required Escrow</span>
                    <span className="font-bold text-sm text-foreground">
                      {fmtPrice(parseFloat(String(auroraMilestone.amount)))}
                    </span>
                    <span className="text-[10px] text-muted-foreground block font-mono">
                      ≈ ${getMilestoneUsdc(auroraMilestone).toFixed(2)} USDC on Solana
                    </span>
                  </div>
                </div>
              )}

              {/* Token Selector */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1">
                  Payment Asset & Chain
                </label>
                <AuroraTokenSelect
                  selectedChainId={selectedChainId}
                  onSelect={(chain) => setSelectedChainId(chain.id)}
                  disabled={quoteLoading}
                />
              </div>

              {/* Optional Refund Address */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Refund Address (Optional)
                  </label>
                  <span className="text-[10px] text-muted-foreground">Source wallet for fallback</span>
                </div>
                <Input
                  className="mt-1 h-9 text-xs font-mono"
                  value={refundAddress}
                  onChange={(e) => setRefundAddress(e.target.value)}
                  placeholder={`e.g. your ${selectedChain.name} address (leave empty for safe default)`}
                />
              </div>

              <Button
                onClick={handleFetchMilestoneQuote}
                disabled={quoteLoading}
                className="w-full text-xs font-medium"
              >
                {quoteLoading ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Querying 1Click Route...
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
                      <span className="text-muted-foreground block">You Send:</span>
                      <span className="font-semibold text-foreground">
                        {quoteResult.amountInFormatted} {selectedChain.nativeSymbol}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Delivered on Solana:</span>
                      <span className="font-semibold text-primary">
                        ${getMilestoneUsdc(auroraMilestone).toFixed(2)} USDC (Guaranteed)
                      </span>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-background border border-border space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-foreground flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                        Listening for deposit on {selectedChain.name}
                      </span>
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-semibold">
                        {depositStatus?.status || 'PENDING'}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Transfer exact funds from your {selectedChain.name} wallet to the deposit address above. Aurora 1Click solver network automatically routes the swap and locks the exact USDC into your Solana milestone escrow upon receipt.
                    </p>
                  </div>

                  <div className="flex justify-end pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs font-medium"
                      onClick={() => setAuroraMilestone(null)}
                    >
                      Close Window (Monitoring In Background)
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

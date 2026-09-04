import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Briefcase, Shield, Star, ArrowRight, ArrowLeft, Wallet, Bot, MessageSquare, Bell, Coins, Loader2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/store/authStore'
import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { FundWalletButton } from '@/components/FundWalletButton'
import { CURRENCIES, type CurrencyCode } from '@/lib/currency'
import { useCurrencyStore, applyDisplayCurrency } from '@/store/currencyStore'

type Step = {
  icon: LucideIcon
  title: string
  desc: string
  isFundWallet: boolean
  isCurrency?: boolean
}

const BASE_STEPS: Step[] = [
  {
    icon: Briefcase,
    title: 'Welcome to Gigr',
    desc: 'Your neighborhood marketplace for trusted local services. Post a job or offer a service in minutes — no middlemen, no percentages.',
    isFundWallet: false,
  },
  {
    icon: Coins,
    title: 'Pick your currency',
    desc: 'How would you like prices shown? Everything stays stored & settled in Naira — this only changes how amounts are displayed to you.',
    isFundWallet: false,
    isCurrency: true,
  },
  {
    icon: MessageSquare,
    title: 'Find work — fast',
    desc: 'Browse open jobs and services near you, filter by category, and chat with clients or providers in real time before you commit.',
    isFundWallet: false,
  },
  {
    icon: Shield,
    title: 'Payments are guaranteed',
    desc: 'Funds are locked in a secure on-chain escrow until the work is done. No scams, no awkward chasing — disputes go to a real admin court.',
    isFundWallet: false,
  },
  {
    icon: Bot,
    title: 'Meet Your AI Assistant',
    desc: 'Speak or type to instantly find jobs, analyze data, and manage your account hands-free. It can even call you when things move.',
    isFundWallet: false,
  },
  {
    icon: Bell,
    title: 'Never miss a beat',
    desc: 'Get instant push notifications on your phone — new messages, job updates, and payment alerts. Tap one to jump straight into the app.',
    isFundWallet: false,
  },
  {
    icon: Star,
    title: 'Build Verifiable Reputation',
    desc: 'Finish a job, earn a vouch. Your reputation is public, verifiable, and travels with you everywhere.',
    isFundWallet: false,
  },
]

const FUND_WALLET_STEP: Step = {
  icon: Wallet,
  title: 'Fund your wallet to get started',
  desc: 'Add funds to your Gigr wallet so you can post jobs with escrow or get paid instantly as a worker.',
  isFundWallet: true,
}

// Persistence is versioned so a future product change can re-show onboarding
// deliberately (bump ONBOARD_VERSION), while a user who said "never again"
// stays silenced forever.
const ONBOARD_VERSION = 'v3'
const RE_SHOW_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days when "do not show" is off

function storageKey(kind: 'seen' | 'never', userId?: string) {
  return `gigr_onboarded_${kind}_${ONBOARD_VERSION}_${userId || 'anon'}`
}

export default function OnboardingOverlay() {
  const { user } = useAuthStore()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [doNotShowAgain, setDoNotShowAgain] = useState(true)
  const [currencyPick, setCurrencyPick] = useState<CurrencyCode>(() => useCurrencyStore.getState().code)
  const [currencySaving, setCurrencySaving] = useState(false)

  const { data: walletInfo } = useQuery<{ wallet_public_key: string }>({
    queryKey: ['wallet'],
    queryFn: async () => {
      const { data } = await api.get('/users/me/wallet')
      return data
    },
    enabled: !!user?.id,
  })

  const { data: walletBalance } = useQuery<{ sol: number; usdc: string }>({
    queryKey: ['wallet-balance'],
    queryFn: async () => {
      const { data } = await api.get('/users/me/balance')
      return data
    },
    enabled: !!user?.id,
  })

  const needsFunding = walletBalance !== undefined && parseFloat(walletBalance.usdc ?? '0') === 0

  const STEPS = useMemo(
    () => (needsFunding ? [...BASE_STEPS, FUND_WALLET_STEP] : BASE_STEPS),
    [needsFunding],
  )

  // Show unless the user has permanently opted out; if they skipped without
  // opting out, wait 7 days before asking again.
  useEffect(() => {
    if (!user?.id) return
    try {
      if (localStorage.getItem(storageKey('never', user.id))) return
      const seenAt = parseInt(localStorage.getItem(storageKey('seen', user.id)) || '0', 10)
      if (seenAt && Date.now() - seenAt < RE_SHOW_AFTER_MS) return
      setOpen(true)
    } catch {
      /* localStorage unavailable — skip */
    }
  }, [user?.id])

  // Escape closes the overlay too (same as Skip — respects the checkbox).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, doNotShowAgain])

  const finish = () => {
    try {
      if (user?.id) {
        // Always record that they've seen it…
        localStorage.setItem(storageKey('seen', user.id), String(Date.now()))
        // …and if they ticked the box, never ask again.
        if (doNotShowAgain) localStorage.setItem(storageKey('never', user.id), '1')
      }
    } catch {
      /* ignore */
    }
    setOpen(false)
  }

  const next = () => {
    if (step < STEPS.length - 1) setStep((s) => s + 1)
    else finish()
  }

  // Advancing from the currency step persists the choice (fetching rates first
  // if needed) so the dashboard behind already shows the picked currency.
  const goNext = async () => {
    if (STEPS[step]?.isCurrency) {
      setCurrencySaving(true)
      try {
        await applyDisplayCurrency(currencyPick)
      } finally {
        setCurrencySaving(false)
      }
    }
    next()
  }

  const back = () => {
    if (step > 0) setStep((s) => s - 1)
  }

  const current = STEPS[step] ?? STEPS[0]
  const Icon = current.icon

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={finish}
        >
          <motion.div
            className="relative w-full max-w-md rounded-3xl bg-white dark:bg-gray-900 shadow-2xl overflow-hidden"
            initial={{ scale: 0.9, y: 30, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, y: 30, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Animated header band */}
            <div className="h-28 bg-gradient-to-br from-gray-900 to-black relative overflow-hidden">
              {[...Array(12)].map((_, i) => (
                <motion.span
                  key={i}
                  className="absolute w-1.5 h-1.5 rounded-full bg-white/40"
                  style={{ left: `${(i * 8.5) % 100}%`, top: `${(i * 13) % 100}%` }}
                  animate={{ y: [0, -14, 0], opacity: [0.2, 0.7, 0.2] }}
                  transition={{ duration: 3 + (i % 4), repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
              <motion.div
                key={step}
                className="absolute inset-0 flex items-center justify-center"
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 15 }}
              >
                <span className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur flex items-center justify-center">
                  {Icon && <Icon className="w-8 h-8 text-white" />}
                </span>
              </motion.div>
            </div>

            <div className="p-7 text-center">
              <AnimatePresence mode="wait">
                <motion.div
                  key={step}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3 }}
                >
                  <h2 className="text-2xl font-bold mb-2">{current.title}</h2>
                  <p className="text-gray-500 dark:text-gray-400 leading-relaxed">
                    {current.desc}
                  </p>
                </motion.div>
              </AnimatePresence>

              {/* Currency picker step */}
              {current.isCurrency && (
                <div className="mt-5 text-left">
                  <div className="grid grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-1">
                    {CURRENCIES.map((c) => {
                      const active = currencyPick === c.code
                      return (
                        <button
                          key={c.code}
                          type="button"
                          onClick={() => setCurrencyPick(c.code)}
                          className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                            active
                              ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-black'
                              : 'border-gray-200 text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200'
                          }`}
                        >
                          <span className="text-base leading-none">{c.symbol}</span>
                          <span className="font-semibold">{c.code}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-gray-400 mt-2">
                    Prices are stored &amp; settled in Naira and shown in this currency. You can change it anytime on your Profile.
                  </p>
                </div>
              )}

              {/* Progress dots */}
              <div className="flex justify-center gap-2 mt-6 mb-6">
                {STEPS.map((_, i) => (
                  <motion.span
                    key={i}
                    className={`h-2 rounded-full ${i === step ? 'bg-black dark:bg-white' : 'bg-gray-200 dark:bg-gray-700'}`}
                    animate={{ width: i === step ? 24 : 8 }}
                  />
                ))}
              </div>

              {current.isFundWallet && walletInfo?.wallet_public_key && (
                <div className="mb-4">
                  <FundWalletButton walletAddress={walletInfo.wallet_public_key} />
                </div>
              )}

              {/* Do not show again checkbox */}
              <div className="flex items-center justify-center gap-2 mb-4 text-sm text-gray-500">
                <input
                  type="checkbox"
                  id="doNotShowAgain"
                  checked={doNotShowAgain}
                  onChange={(e) => setDoNotShowAgain(e.target.checked)}
                  className="rounded border-gray-300 text-black focus:ring-black cursor-pointer"
                />
                <label htmlFor="doNotShowAgain" className="cursor-pointer select-none">
                  Do not show this again
                </label>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {step > 0 && (
                    <button
                      onClick={back}
                      className="inline-flex items-center text-sm text-gray-500 hover:text-black dark:hover:text-white font-medium"
                    >
                      <ArrowLeft className="mr-1 h-4 w-4" /> Back
                    </button>
                  )}
                  <button
                    onClick={finish}
                    className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    {current.isFundWallet ? 'Maybe later' : 'Skip'}
                  </button>
                </div>
                <Button onClick={goNext} disabled={currencySaving} className="bg-black text-white rounded-full px-6">
                  {currencySaving ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  )}
                  {currencySaving ? 'Applying…' : step < STEPS.length - 1 ? 'Next' : 'Done'}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

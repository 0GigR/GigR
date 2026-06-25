import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Briefcase, Shield, Star, MessageSquare, ArrowRight, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/store/authStore'
import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { FundWalletButton } from '@/components/FundWalletButton'

const BASE_STEPS = [
  {
    icon: Briefcase,
    title: 'Welcome to Gigr',
    desc: 'Your neighborhood marketplace for trusted local services. Post a job or offer a service in minutes.',
    isFundWallet: false,
  },
  {
    icon: Shield,
    title: 'Payments are guaranteed',
    desc: 'Funds are locked in a secure escrow until the work is done — no scams, no awkward chasing.',
    isFundWallet: false,
  },
  {
    icon: MessageSquare,
    title: 'Chat in one place',
    desc: 'Every job gets its own contract room. Message, share photos and agree on scope changes right there.',
    isFundWallet: false,
  },
  {
    icon: Star,
    title: 'Build real reputation',
    desc: 'Finish a job, earn a vouch. Your reputation is verifiable and travels with you everywhere.',
    isFundWallet: false,
  },
]

const FUND_WALLET_STEP = {
  icon: Wallet,
  title: 'Fund your wallet to get started',
  desc: 'Add funds to your Gigr wallet so you can post jobs with escrow or get paid instantly as a worker.',
  isFundWallet: true,
}

function storageKey(userId?: string) {
  return `gigr_onboarded_${userId || 'anon'}`
}

export default function OnboardingOverlay() {
  const { user } = useAuthStore()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

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

  // Trigger only for users who haven't seen onboarding yet.
  useEffect(() => {
    if (!user?.id) return
    try {
      const seen = localStorage.getItem(storageKey(user.id))
      if (!seen) setOpen(true)
    } catch {
      /* localStorage unavailable — skip */
    }
  }, [user?.id])

  const finish = () => {
    try {
      localStorage.setItem(storageKey(user?.id), '1')
    } catch {
      /* ignore */
    }
    setOpen(false)
  }

  const next = () => {
    if (step < STEPS.length - 1) setStep((s) => s + 1)
    else finish()
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
        >
          <motion.div
            className="relative w-full max-w-md rounded-3xl bg-white dark:bg-gray-900 shadow-2xl overflow-hidden"
            initial={{ scale: 0.9, y: 30, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, y: 30, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
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

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={finish}
                  className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  {current.isFundWallet ? 'Maybe later' : 'Skip'}
                </button>
                <Button onClick={next} className="bg-black text-white rounded-full px-6">
                  {step < STEPS.length - 1 ? 'Next' : 'Done'}
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

import { useState, useEffect, useRef } from 'react'
import AuthDialog from '@/components/AuthDialog'
import ParticleBackground from '@/components/ParticleBackground'
import { Logo } from '@/components/Logo'
import {
  Shield, Users, ArrowRight, Zap, Bot, Star, Gavel, MapPin,
  CheckCircle, MessageCircle, Bell, Quote, ChevronRight, Flame,
} from 'lucide-react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { useAuthStore } from '@/store/authStore'
import { Navigate } from 'react-router-dom'

// ---------- Subtle animated background blobs (silver/grey) ----------
function BackgroundBlobs() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <motion.div
        className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-gradient-to-br from-gray-200 to-gray-100 blur-3xl opacity-50"
        animate={{ x: [0, 30, 0], y: [0, -20, 0] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-gradient-to-br from-gray-200 to-gray-100 blur-3xl opacity-50"
        animate={{ x: [0, -40, 0], y: [0, 40, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  )
}

// ---------- 3D card with metallic sheen ----------
function FeatureCard({ icon: Icon, title, description, delay }: {
  icon: any
  title: string
  description: string
  delay: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 60, rotateX: -15 }}
      whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.7, delay, ease: 'easeOut' }}
      whileHover={{ scale: 1.03, rotateX: 2, rotateY: -2 }}
      className="relative bg-white border border-gray-200 rounded-3xl p-8 shadow-lg hover:shadow-2xl transition-shadow duration-500 group"
    >
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-gray-50 to-white opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <div className="relative">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gray-700 to-black flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
          <Icon className="w-7 h-7 text-white" />
        </div>
        <h3 className="text-2xl font-bold mb-3 text-gray-900">{title}</h3>
        <p className="text-gray-600 leading-relaxed">{description}</p>
      </div>
    </motion.div>
  )
}

// ---------- Typewriter text (gradient-accented word) ----------
function TypewriterText({ texts, className = 'text-black' }: { texts: string[]; className?: string }) {
  const [index, setIndex] = useState(0)
  const [displayed, setDisplayed] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    const current = texts[index]
    let timer: ReturnType<typeof setTimeout>

    if (!isDeleting) {
      if (displayed.length < current.length) {
        timer = setTimeout(() => setDisplayed(current.slice(0, displayed.length + 1)), 80)
      } else {
        timer = setTimeout(() => setIsDeleting(true), 2000)
      }
    } else {
      if (displayed.length > 0) {
        timer = setTimeout(() => setDisplayed(displayed.slice(0, -1)), 40)
      } else {
        setIsDeleting(false)
        setIndex((prev) => (prev + 1) % texts.length)
      }
    }
    return () => clearTimeout(timer)
  }, [displayed, isDeleting, index, texts])

  return (
    <span className={className}>
      {displayed}
      <motion.span
        animate={{ opacity: [0, 1, 0] }}
        transition={{ duration: 0.8, repeat: Infinity }}
        className="inline-block w-[3px] h-[1.2em] bg-black ml-1 align-middle"
      />
    </span>
  )
}

// ---------- Infinite category ticker ----------
const CATEGORIES = [
  'Repairs', 'Cleaning', 'Delivery & Errands', 'Tech & Gadgets', 'Design & Branding',
  'Tutoring', 'Events & Catering', 'Beauty & Wellness', 'Moving & Logistics',
  'Home Improvement', 'Photography', 'Car Care',
]

function CategoryMarquee() {
  return (
    <div className="relative py-5 border-y border-gray-100 bg-gray-50/60 overflow-hidden">
      <div
        className="flex w-max whitespace-nowrap animate-[gigr-marquee_35s_linear_infinite] hover:[animation-play-state:paused] motion-reduce:animate-none"
        aria-hidden="true"
      >
        {[...CATEGORIES, ...CATEGORIES].map((cat, i) => (
          <span
            key={i}
            className="mx-3 inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 px-4 py-1.5 rounded-full border border-gray-200 bg-white shadow-sm"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500" />
            {cat}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------- Phone mockup of the live app ----------
function PhoneMockup() {
  return (
    <div className="relative mx-auto mt-16 md:mt-20">
      {/* Floating proof chips (desktop) */}
      <div className="absolute -left-40 top-14 hidden xl:flex items-center gap-2 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-xl animate-[gigr-float_6s_ease-in-out_infinite]">
        <span className="w-8 h-8 rounded-full bg-green-100 text-green-700 flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4" />
        </span>
        <div className="text-left">
          <p className="text-xs font-bold text-gray-900">Escrow protected</p>
          <p className="text-[10px] text-gray-500">Funds locked on-chain</p>
        </div>
      </div>
      <div className="absolute -right-40 top-36 hidden xl:flex items-center gap-2 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-xl animate-[gigr-float_7s_ease-in-out_infinite]">
        <span className="w-8 h-8 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <Star className="w-4 h-4" />
        </span>
        <div className="text-left">
          <p className="text-xs font-bold text-gray-900">Vouch received</p>
          <p className="text-[10px] text-gray-500">Minted as a cNFT</p>
        </div>
      </div>
      <div className="absolute -left-32 bottom-20 hidden xl:flex items-center gap-2 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-xl animate-[gigr-float_8s_ease-in-out_infinite]">
        <span className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
          <MapPin className="w-4 h-4" />
        </span>
        <div className="text-left">
          <p className="text-xs font-bold text-gray-900">Near you</p>
          <p className="text-[10px] text-gray-500">2 km away</p>
        </div>
      </div>

      {/* Phone frame */}
      <div className="relative aspect-[9/17] w-[250px] rounded-[2.8rem] border-[10px] border-gray-900 bg-white shadow-2xl overflow-hidden sm:w-[264px]">
        {/* Notch */}
        <div className="absolute top-2 inset-x-0 mx-auto w-32 h-6 bg-gray-900 rounded-full z-20" />

        {/* Screen */}
        <div className="flex h-full flex-col px-4 pt-14 pb-6 bg-gray-50">
          {/* App header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1.5">
              <Logo className="w-5 h-5 text-black" />
              <span className="text-sm font-bold">Gigr</span>
            </div>
            <div className="relative">
              <Bell className="w-4 h-4 text-gray-600" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-fuchsia-500" />
            </div>
          </div>

          {/* Job card */}
          <div className="bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white text-[9px] font-bold flex items-center justify-center">AO</span>
              <span className="text-[11px] font-semibold text-gray-900">Ada O.</span>
              <span className="text-[9px] text-gray-400">· Client</span>
            </div>
            <p className="text-[13px] font-bold text-gray-900 mb-1">Fix my iPhone screen</p>
            <p className="text-[11px] text-gray-500 line-clamp-1 mb-2">Cracked glass, need a same-day repair near Lekki Phase 1.</p>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-black text-gray-900">₦45,000</span>
              <span className="inline-flex items-center gap-1 text-[9px] font-semibold bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
                <Shield className="w-2.5 h-2.5" /> Escrowed
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1 text-[9px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-semibold">
                <Flame className="w-2.5 h-2.5" /> Hot
              </span>
              <span className="inline-flex items-center gap-1 text-[9px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">
                4 applications
              </span>
              <span className="text-[9px] text-gray-400">2h ago</span>
            </div>
          </div>

          {/* Second card */}
          <div className="bg-white border border-gray-200 rounded-2xl p-3 shadow-sm mt-2 flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-gray-900 truncate">Clean 3-bedroom apartment</p>
              <p className="text-[10px] text-gray-500">₦25,000 · <span className="text-indigo-600 font-medium">2 km away</span></p>
            </div>
            <span className="inline-flex items-center gap-1 text-[9px] font-semibold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full shrink-0">
              Open
            </span>
          </div>

          {/* Chat bubble */}
          <div className="flex justify-end mt-2">
            <div className="bg-gray-900 text-white rounded-2xl rounded-br-sm px-3 py-2 max-w-[85%]">
              <p className="text-[10px] leading-snug">Work submitted — review and release payment when ready</p>
              <p className="text-[8px] text-gray-400 mt-0.5 text-right">9:41 AM</p>
            </div>
          </div>

          {/* Fund button */}
          <button className="w-full mt-3 bg-gray-900 text-white text-[12px] font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 shadow-lg">
            <Shield className="w-3.5 h-3.5" /> Fund Escrow
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- Main landing page ----------
export default function LandingPage() {
  const [authOpen, setAuthOpen] = useState(false)
  const howItWorksRef = useRef(null)
  const { scrollYProgress } = useScroll({
    target: howItWorksRef,
    offset: ['start end', 'end start'],
  })
  const scale = useTransform(scrollYProgress, [0, 0.5], [0.9, 1])
  const opacity = useTransform(scrollYProgress, [0, 0.3], [0.5, 1])

  const { user } = useAuthStore()
  if (user) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <div className="min-h-screen bg-white text-gray-900 overflow-hidden scroll-smooth">
      {/* Navigation */}
      <nav className="fixed w-full top-0 z-50 backdrop-blur-lg bg-white/80 border-b border-gray-200">
        <div className="flex items-center justify-between px-4 md:px-6 py-4 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <Logo className="w-8 h-8 text-black" />
            <span className="text-xl font-bold tracking-tight">Gigr</span>
          </div>
          <button
            onClick={() => setAuthOpen(true)}
            className="inline-flex h-12 items-center justify-center rounded-full bg-black px-6 text-base font-semibold text-white shadow-lg transition-all hover:bg-gray-800 hover:shadow-xl"
          >
            Sign In
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative flex flex-col items-center justify-center text-center px-6 pt-24 md:pt-32 pb-24 max-w-6xl mx-auto">
        <BackgroundBlobs />
        <ParticleBackground className="absolute inset-0 w-full h-full" />
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: 'easeOut' }}
          className="relative z-10"
        >
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="inline-flex items-center gap-2 bg-white border border-gray-200 rounded-full pl-2 pr-4 py-1.5 shadow-sm mb-8"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700">
              <span className="relative flex w-2 h-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-fuchsia-400 opacity-75" />
                <span className="relative inline-flex rounded-full w-2 h-2 bg-gradient-to-r from-indigo-500 to-fuchsia-500" />
              </span>
              Now live — escrow-protected neighborhood marketplace
            </span>
          </motion.div>

          <h1 className="text-5xl md:text-8xl font-black tracking-tight leading-tight">
            Trust works
            <br />
            <TypewriterText
              texts={['neighborly', 'on-chain', 'verifiably']}
              className="text-black"
            />
          </h1>
          <p className="mt-8 text-xl md:text-2xl text-gray-600 max-w-3xl mx-auto leading-relaxed">
            The first neighborhood marketplace where <strong className="text-gray-900">reputation is real</strong> and{' '}
            <strong className="text-gray-900">payments are guaranteed</strong> — without anyone needing to understand
            blockchain.
          </p>
          <div className="mt-12 flex gap-5 justify-center flex-wrap">
            <button
              onClick={() => setAuthOpen(true)}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-black px-10 text-lg font-bold text-white shadow-xl transition-all hover:scale-105 hover:shadow-2xl"
            >
              Get Started
              <ArrowRight className="h-5 w-5" />
            </button>
            <a
              href="#how-it-works"
              className="inline-flex h-12 items-center justify-center rounded-full border-2 border-gray-800 px-10 text-lg font-bold text-gray-800 transition-all hover:bg-gray-800 hover:text-white"
            >
              Learn More
            </a>
          </div>
        </motion.div>

        {/* Phone mockup */}
        <PhoneMockup />
      </section>

      {/* Category ticker */}
      <CategoryMarquee />

      {/* How it Works – Parallax */}
      <motion.section
        id="how-it-works"
        ref={howItWorksRef}
        style={{ scale, opacity }}
        className="py-32 px-6 max-w-7xl mx-auto relative"
      >
        <h2 className="text-4xl md:text-6xl font-bold text-center mb-20">
          How Gigr works
        </h2>
        <div className="grid md:grid-cols-3 gap-10 md:gap-6 relative">
          {[
            { step: '01', icon: Users, title: 'Post a job or service', desc: 'Describe what you need. Set your price. Your neighborhood sees it.' },
            { step: '02', icon: Shield, title: 'Fund escrow securely', desc: 'Payment is locked in a smart contract. No one can touch it.' },
            { step: '03', icon: Zap, title: 'Complete, get paid & reviewed', desc: 'Work done? Confirm and the money flows instantly. Then leave a vouch and a star rating.' },
          ].map((item, i) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.2, duration: 0.6 }}
              className="flex gap-6 items-start relative"
            >
              {i < 2 && (
                <ChevronRight className="hidden md:block absolute -right-4 top-1/2 -translate-y-1/2 w-6 h-6 text-gray-200" />
              )}
              <div className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-b from-gray-300 to-gray-200">{item.step}</div>
              <div>
                <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center mb-4">
                  <item.icon className="w-6 h-6 text-black" />
                </div>
                <h3 className="text-xl font-bold mb-2">{item.title}</h3>
                <p className="text-gray-600">{item.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.section>

      {/* Feature Cards */}
      <section id="features" className="py-32 px-6 max-w-7xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold text-center mb-20">
          Why trust Gigr?
        </h2>
        <div className="grid md:grid-cols-3 gap-10">
          <FeatureCard icon={Bot} title="AI Assistant" description="Speak or type — your AI agent finds services, posts jobs, and even negotiates on your behalf, hands-free." delay={0} />
          <FeatureCard icon={Shield} title="Smart Contract Escrow" description="Funds locked in Solana programs. No one, not even Gigr, can touch them until the work is done." delay={0.1} />
          <FeatureCard icon={Users} title="Social Vouching" description="Every vouch is a permanent, tamper-proof cNFT. Your reputation travels with you." delay={0.2} />
          <FeatureCard icon={Star} title="Ratings & Reviews" description="Real 1–5 star reviews tied to real completed jobs. See exactly who trusts whom, and why." delay={0.3} />
          <FeatureCard icon={Gavel} title="Community Disputes" description="Disagreements are settled by a jury of verified neighbors voting on-chain — not a faceless support desk." delay={0.4} />
          <FeatureCard icon={MapPin} title="Hyper-Local Map" description="See jobs and providers around you on a live neighborhood map. Trust starts close to home." delay={0.5} />
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-32 px-6 max-w-7xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold text-center mb-6">
          Neighbors who trust Gigr
        </h2>
        <p className="text-center text-gray-500 text-lg mb-16 max-w-2xl mx-auto">
          Real jobs, real escrow, real reputation — from the people next door.
        </p>
        <div className="grid md:grid-cols-3 gap-10">
          {[
            {
              quote: 'I posted a phone repair at 9am and had it fixed by noon. The escrow meant I paid only when the work was done.',
              name: 'Ada O.',
              role: 'Homeowner, Lekki',
              initials: 'AO',
            },
            {
              quote: 'Clients pay upfront into escrow, so I never chase payments anymore. My vouches got me my next three jobs.',
              name: 'Chidi K.',
              role: 'Electrician, Surulere',
              initials: 'CK',
            },
            {
              quote: 'The AI agent handled the whole back-and-forth for my branding job. I just reviewed and approved.',
              name: 'Tobi A.',
              role: 'Freelance Designer',
              initials: 'TA',
            },
          ].map((t, i) => (
            <motion.div
              key={t.name}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.6, delay: i * 0.12 }}
              className="bg-white border border-gray-200 rounded-3xl p-8 shadow-sm hover:shadow-xl transition-shadow duration-500 flex flex-col"
            >
              <Quote className="w-8 h-8 text-gray-200 mb-4" />
              <div className="flex gap-0.5 mb-4">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} className="w-4 h-4 fill-amber-400 text-amber-400" />
                ))}
              </div>
              <p className="text-gray-700 leading-relaxed flex-1">“{t.quote}”</p>
              <div className="flex items-center gap-3 mt-6 pt-6 border-t border-gray-100">
                <span className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white text-xs font-bold flex items-center justify-center">
                  {t.initials}
                </span>
                <div>
                  <p className="text-sm font-bold text-gray-900">{t.name}</p>
                  <p className="text-xs text-gray-500">{t.role}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="py-32 px-6 text-center relative">
        <BackgroundBlobs />
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          whileInView={{ scale: 1, opacity: 1 }}
          viewport={{ once: true }}
          className="relative z-10"
        >
          <h2 className="text-4xl md:text-6xl font-bold mb-6">
            Ready to trust your neighborhood?
          </h2>
          <p className="text-xl text-gray-600 mb-10">Join the pilot. First 200 users get free access.</p>
          <div className="relative inline-block">
            <div className="absolute -inset-5 rounded-full bg-gradient-to-r from-indigo-500/30 via-fuchsia-500/30 to-violet-500/30 blur-2xl animate-pulse" />
            <button
              onClick={() => setAuthOpen(true)}
              className="relative inline-flex h-14 items-center justify-center gap-2 rounded-full bg-black px-12 text-xl font-bold text-white shadow-2xl transition-all hover:scale-105"
            >
              Get Started Free
              <ArrowRight className="h-6 w-6" />
            </button>
          </div>
          <div className="mt-10 flex items-center justify-center gap-6 flex-wrap text-sm text-gray-500">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-green-600" /> Free to join
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield className="w-4 h-4 text-green-600" /> Escrow-protected
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MessageCircle className="w-4 h-4 text-green-600" /> Local support
            </span>
          </div>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="py-10 px-6 border-t border-gray-100">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <span className="text-gray-500">© 2026 Gigr · Built for every neighborhood.</span>
          <div className="flex items-center gap-6 text-sm text-gray-500">
            <a href="#how-it-works" className="hover:text-gray-900 transition-colors">How it works</a>
            <a href="#features" className="hover:text-gray-900 transition-colors">Why Gigr</a>
            <button onClick={() => setAuthOpen(true)} className="hover:text-gray-900 transition-colors">Sign in</button>
            <button onClick={() => setAuthOpen(true)} className="font-semibold text-gray-900 hover:text-indigo-600 transition-colors">
              Get Started
            </button>
          </div>
        </div>
      </footer>

      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  )
}

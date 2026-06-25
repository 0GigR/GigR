import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import AuthDialog from '@/components/AuthDialog'
import ParticleBackground from '@/components/ParticleBackground'
import { Logo } from '@/components/Logo'
import { Shield, Users, Smartphone, ArrowRight, Zap } from 'lucide-react'
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

// ---------- Typewriter text (black, no colour) ----------
function TypewriterText({ texts }: { texts: string[] }) {
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
    <span className="text-black">
      {displayed}
      <motion.span
        animate={{ opacity: [0, 1, 0] }}
        transition={{ duration: 0.8, repeat: Infinity }}
        className="inline-block w-[3px] h-[1.2em] bg-black ml-1 align-middle"
      />
    </span>
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
    <div className="min-h-screen bg-white text-gray-900 overflow-hidden">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 backdrop-blur-lg bg-white/80 border-b border-gray-200">
        <div className="flex items-center justify-between px-4 md:px-6 py-4 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <Logo className="w-8 h-8 text-black" />
            <span className="text-xl font-bold tracking-tight">Gigr</span>
          </div>
          <Button
            onClick={() => setAuthOpen(true)}
            className="bg-black hover:bg-gray-800 text-white font-semibold px-6 py-2.5 rounded-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign In
          </Button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative flex flex-col items-center justify-center text-center px-6 pt-32 md:pt-40 pb-32 max-w-6xl mx-auto">
        <BackgroundBlobs />
        <ParticleBackground className="absolute inset-0 w-full h-full" />
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: 'easeOut' }}
          className="relative z-10"
        >
          <h1 className="text-5xl md:text-8xl font-black tracking-tight leading-tight">
            Trust works
            <br />
            <TypewriterText texts={['neighborly', 'on-chain', 'verifiably']} />
          </h1>
          <p className="mt-8 text-xl md:text-2xl text-gray-600 max-w-3xl mx-auto leading-relaxed">
            The first neighborhood marketplace where <strong className="text-gray-900">reputation is real</strong> and{' '}
            <strong className="text-gray-900">payments are guaranteed</strong> — without anyone needing to understand
            blockchain.
          </p>
          <div className="mt-12 flex gap-5 justify-center flex-wrap">
            <Button
              size="lg"
              onClick={() => setAuthOpen(true)}
              className="bg-black text-white font-bold px-10 py-4 rounded-full text-lg shadow-xl hover:shadow-2xl hover:scale-105 transition-all"
            >
              Get Started
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="border-2 border-gray-800 text-gray-800 font-bold px-10 py-4 rounded-full text-lg hover:bg-gray-800 hover:text-white transition-all"
            >
              Learn More
            </Button>
          </div>
        </motion.div>
      </section>

      {/* How it Works – Parallax */}
      <motion.section
        ref={howItWorksRef}
        style={{ scale, opacity }}
        className="py-32 px-6 max-w-7xl mx-auto relative"
      >
        <h2 className="text-4xl md:text-6xl font-bold text-center mb-20">
          How Gigr <span className="text-black">works</span>
        </h2>
        <div className="grid md:grid-cols-3 gap-10">
          {[
            { step: '01', icon: Users, title: 'Post a job or service', desc: 'Describe what you need. Set your price. Your neighborhood sees it.' },
            { step: '02', icon: Shield, title: 'Fund escrow securely', desc: 'Payment is locked in a smart contract. No one can touch it.' },
            { step: '03', icon: Zap, title: 'Complete & get paid', desc: 'Work done? Confirm and the money flows instantly. Plus, leave a vouch.' },
          ].map((item, i) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.2, duration: 0.6 }}
              className="flex gap-6 items-start"
            >
              <div className="text-5xl font-black text-gray-200">{item.step}</div>
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
      <section className="py-32 px-6 max-w-7xl mx-auto">
        <h2 className="text-4xl md:text-6xl font-bold text-center mb-20">
          Why <span className="text-black">trust</span> Gigr?
        </h2>
        <div className="grid md:grid-cols-3 gap-10">
          <FeatureCard icon={Users} title="Social Vouching" description="Every vouch is a permanent, tamper‑proof NFT. Your reputation travels with you." delay={0} />
          <FeatureCard icon={Shield} title="Smart Contract Escrow" description="Funds locked in audited Solana programs. No one, not even Gigr, can touch them." delay={0.15} />
          <FeatureCard icon={Smartphone} title="Invisible Blockchain" description="Pay with mobile money or card. Under the hood, Solana settles in seconds." delay={0.3} />
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
          <h2 className="text-4xl md:text-6xl font-bold mb-6">Ready to trust your neighborhood?</h2>
          <p className="text-xl text-gray-600 mb-10">Join the pilot. First 200 users get free access.</p>
          <Button
            size="lg"
            onClick={() => setAuthOpen(true)}
            className="bg-black text-white font-bold px-12 py-5 rounded-full text-xl shadow-2xl hover:scale-105 transition-all"
          >
            Get Started Free
            <ArrowRight className="ml-2 h-6 w-6" />
          </Button>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="py-8 text-center text-gray-500">
        © 2026 Gigr · Built for every neighborhood.
      </footer>

      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  )
}
/**
 * EncodeAuroraPage.tsx - Hackathon judge briefing for Aurora Intents on Solana.
 *
 * Conforms strictly to house-standard.md:
 * - Uses Gigr's native in-app light mode theme
 * - Zero emojis anywhere in code, copy, or markup
 * - Phone-optimized portrait 9:16 frame for the mobile demo screen recording
 * - Synchronized chapter navigation with live video timestamp seeking
 * - Comprehensive documentation and source verification links
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Moon, Pause, Play, ShieldCheck, Sun, Volume2, VolumeX } from 'lucide-react'
import {
  AURORA_CHAPTERS,
  chapterIndexAt,
  formatChapterTime,
} from '@/lib/auroraChapters'
import { playbackCommand } from '@/lib/judgesPlayback'
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import MonkeyAgent3DFlow from '@/components/judges/MonkeyAgent3DFlow'
import './encodeAurora.css'

const DEMO_VIDEO_ID = '851MpwbjewY'
const DEMO_VIDEO_URL = 'https://youtu.be/851MpwbjewY'
const APPLICATION_URL = 'https://gigrr.vercel.app'
const SOURCE_URL = 'https://github.com/0GigR/GigR'
const CI_URL = 'https://github.com/0GigR/GigR/actions'

interface BrandTile {
  name: string
  role: string
  tone: 'violet' | 'sky' | 'blue' | 'cyan'
  href: string
  mark?: {
    src: string
    alt: string
    width: number
    height: number
  }
}

const BRANDS: readonly BrandTile[] = [
  {
    name: 'Gigr',
    role: 'Solana escrow marketplace',
    tone: 'violet',
    href: 'https://gigrr.vercel.app',
    mark: {
      src: '/brands/gigr.png',
      alt: 'Gigr logo',
      width: 20,
      height: 20,
    },
  },
  {
    name: 'Aurora Intents',
    role: 'Cross-chain engine',
    tone: 'sky',
    href: 'https://intents.aurora.dev',
    mark: {
      src: '/brands/aurora.svg',
      alt: 'Aurora Intents logo',
      width: 20,
      height: 20,
    },
  },
  {
    name: 'NEAR Intents',
    role: '1Click routing',
    tone: 'blue',
    href: 'https://near.org',
    mark: {
      src: '/brands/near.svg',
      alt: 'NEAR Intents logo',
      width: 20,
      height: 20,
    },
  },
  {
    name: 'Solana',
    role: 'Settlement layer',
    tone: 'violet',
    href: 'https://solana.com',
    mark: {
      src: '/brands/solana.svg',
      alt: 'Solana logo',
      width: 20,
      height: 20,
    },
  },
]

const STATS = [
  { value: '38+', label: 'Supported blockchains' },
  { value: '0.01 USDC', label: 'x402 micro-settlement' },
  { value: 'Anchor PDA', label: 'Non-custodial escrow' },
  { value: '318', label: 'Tests passing in CI' },
]

function OutboundLink({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: ReactNode
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  )
}

export default function EncodeAuroraPage() {
  const [isLightMode, setIsLightMode] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const seekLockRef = useRef<{ index: number; expires: number } | null>(null)
  const [visibleRatio, setVisibleRatio] = useState(0)
  const videoFrameRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const handleTime = useCallback((seconds: number) => {
    const next = chapterIndexAt(seconds)
    const lock = seekLockRef.current
    if (lock) {
      if (next === lock.index) {
        seekLockRef.current = null
      } else if (performance.now() < lock.expires) {
        return
      } else {
        seekLockRef.current = null
      }
    }
    setActiveIndex((current) => (current === next ? current : next))
  }, [])

  const {
    containerRef,
    isReady,
    failed,
    isPlaying,
    isMuted,
    userPaused,
    autoplayRefused,
    ended,
    seekTo,
    attemptAutoplay,
    pauseForVisibility,
    playFromGesture,
    pauseFromGesture,
    toggleMute,
  } = useYouTubePlayer(DEMO_VIDEO_ID, handleTime)

  useEffect(() => {
    const node = videoFrameRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleRatio(1)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setVisibleRatio(entry.intersectionRatio)
      },
      { threshold: [0, 0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 1] },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const playback = playbackCommand({
    visibleRatio,
    isReady,
    isPlaying,
    ended,
    reducedMotion,
    userPaused,
    autoplayRefused,
  })

  useEffect(() => {
    if (playback === 'play') {
      attemptAutoplay()
    } else if (playback === 'pause') {
      pauseForVisibility()
    }
  }, [playback, attemptAutoplay, pauseForVisibility])

  const showPlayOverlay =
    isReady && !failed && (userPaused || autoplayRefused || ended)

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Gigr - Encode Aurora Judge Briefing'
    return () => {
      document.title = previousTitle
    }
  }, [])

  const activeChapter = AURORA_CHAPTERS[activeIndex] ?? AURORA_CHAPTERS[0]
  const nextChapter = AURORA_CHAPTERS[activeIndex + 1]
  const chapterCount = AURORA_CHAPTERS.length

  const selectChapter = useCallback(
    (index: number) => {
      const chapter = AURORA_CHAPTERS[index]
      if (!chapter) return
      seekLockRef.current = { index, expires: performance.now() + 4000 }
      setActiveIndex(index)
      seekTo(chapter.start)
    },
    [seekTo],
  )

  return (
    <div className={`ea-page${isLightMode ? ' is-light' : ''}`}>
      <div className="ea-ambient" aria-hidden="true">
        <div className="ea-ambient-glow ea-ambient-glow-a" />
        <div className="ea-ambient-glow ea-ambient-glow-b" />
        <div className="ea-grid-lines" />
      </div>

      <header className="ea-header">
        <div className="ea-header-inner">
          <Link to="/" className="ea-brand" aria-label="Gigr home">
            <img
              className="ea-logo"
              src="/brands/gigr.png"
              alt="Gigr"
              width={28}
              height={28}
            />
            <span className="ea-wordmark">Gigr</span>
            <span className="ea-brand-rule" aria-hidden="true" />
            <span className="ea-brand-context">Encode Aurora Briefing</span>
          </Link>
          <div className="ea-header-actions">
            <button
              type="button"
              className="ea-theme-toggle"
              onClick={() => setIsLightMode((prev) => !prev)}
              aria-label={isLightMode ? 'Switch to pure black dark mode' : 'Switch to light mode'}
              title={isLightMode ? 'Pure Black Dark Mode' : 'Light Mode'}
            >
              {isLightMode ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
            </button>
            <OutboundLink className="ea-header-cta" href={APPLICATION_URL}>
              Open application
              <ExternalLink size={13} aria-hidden="true" />
            </OutboundLink>
          </div>
        </div>
      </header>

      <main className="ea-main">
        <section className="ea-hero" aria-labelledby="ea-title">
          <p className="ea-eyebrow">
            <span className="ea-eyebrow-dot" aria-hidden="true" />
            Demo
          </p>
          <h1 id="ea-title" className="ea-title">
            Any-Chain Liquidity on{' '}
            <span className="ea-title-accent">Solana</span>
          </h1>
          <p className="ea-lede">
            Gigr is a hyperlocal services marketplace with milestone escrow on
            Solana. Powered by Aurora Intents (1Click), users can fund wallets
            and settle milestone escrows from 38+ blockchains with zero manual
            bridging.
          </p>

          <ul className="ea-brand-strip" aria-label="Core brands">
            {BRANDS.map((brand) => (
              <li key={brand.name}>
                <OutboundLink className="ea-brand-tile-link" href={brand.href}>
                  {brand.mark && (
                    <img
                      className="ea-brand-mark"
                      src={brand.mark.src}
                      alt={brand.mark.alt}
                      width={brand.mark.width}
                      height={brand.mark.height}
                      decoding="async"
                    />
                  )}
                  <span className="ea-brand-name">{brand.name}</span>
                  <span className="ea-brand-role">• {brand.role}</span>
                </OutboundLink>
              </li>
            ))}
          </ul>

          <ul className="ea-stats" aria-label="Project facts">
            {STATS.map((stat) => (
              <li key={stat.label} className="ea-stat">
                <span className="ea-stat-value">{stat.value}</span>{' '}
                <span className="ea-stat-label">{stat.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="ea-grid">
          <section className="ea-video-column" aria-labelledby="ea-video-heading">
            <h2 id="ea-video-heading" className="sr-only">
              Demo Walkthrough Video
            </h2>

            <div ref={videoFrameRef} className="ea-phone-mockup">
              <div className="ea-phone-speaker" aria-hidden="true" />
              <div ref={containerRef} className="ea-video-mount" />

              {!isReady && (
                <div className="ea-video-status">
                  {failed ? (
                    <>
                      <span>The embedded player could not start.</span>
                      <OutboundLink
                        className="ea-verify-link"
                        href={DEMO_VIDEO_URL}
                      >
                        Watch the demo on YouTube
                      </OutboundLink>
                    </>
                  ) : (
                    <span>Loading player</span>
                  )}
                </div>
              )}

              {showPlayOverlay && (
                <button
                  type="button"
                  className="ea-video-play-overlay"
                  onClick={playFromGesture}
                  aria-label={ended ? 'Play demo video from start' : 'Play demo video'}
                >
                  <div className="ea-video-play-icon-wrap">
                    <Play size={24} fill="currentColor" aria-hidden="true" />
                  </div>
                  <span>{ended ? 'Play again' : 'Play demo'}</span>
                </button>
              )}
            </div>

            <div className="ea-video-controls">
              {isReady && !failed && (
                <>
                  <button
                    type="button"
                    className="ea-video-btn"
                    onClick={isPlaying ? pauseFromGesture : playFromGesture}
                    aria-label={isPlaying ? 'Pause demo video' : 'Play demo video'}
                  >
                    {isPlaying ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    <span>{isPlaying ? 'Pause' : 'Play'}</span>
                  </button>

                  <button
                    type="button"
                    className="ea-video-btn-sound"
                    onClick={toggleMute}
                    aria-label={isMuted ? 'Turn video sound on' : 'Turn video sound off'}
                  >
                    {isMuted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
                    <span>{isMuted ? 'Sound off' : 'Sound on'}</span>
                  </button>
                </>
              )}

              <OutboundLink
                className="ea-video-btn ea-video-external-btn"
                href={DEMO_VIDEO_URL}
              >
                YouTube
                <ExternalLink size={12} aria-hidden="true" />
              </OutboundLink>
            </div>
          </section>

          <div className="ea-content-column">
            <aside className="ea-active-panel" aria-labelledby="ea-active-heading">
              <div className="ea-active-header">
                <span className="ea-active-kicker">
                  Chapter {activeIndex + 1} of {chapterCount}
                </span>
                <span className="ea-active-range">
                  {formatChapterTime(activeChapter.start)} -{' '}
                  {nextChapter ? formatChapterTime(nextChapter.start) : 'end'}
                </span>
              </div>

              {activeChapter.tag && (
                <span className="ea-active-tag">{activeChapter.tag}</span>
              )}

              <h2 id="ea-active-heading" className="ea-active-title">
                {activeChapter.title}
              </h2>

              <div key={activeChapter.id} className="ea-active-copy">
                {activeChapter.lines.map((line) => (
                  <p key={line} className="ea-active-line">
                    {line}
                  </p>
                ))}
              </div>

              <p className="sr-only" role="status" aria-live="polite">
                Chapter {activeIndex + 1} of {chapterCount}: {activeChapter.title}
              </p>
            </aside>

            <nav className="ea-chapters-card" aria-label="Video chapters">
              <div className="ea-chapters-head">
                <h3 className="ea-chapters-title">Jump to Chapter</h3>
                <span className="ea-chapters-sub">Click to seek video</span>
              </div>

              <ol className="ea-chapter-list">
                {AURORA_CHAPTERS.map((chapter, index) => {
                  const isActive = index === activeIndex
                  return (
                    <li key={chapter.id}>
                      <button
                        type="button"
                        className="ea-chapter-btn"
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => selectChapter(index)}
                      >
                        <span className="ea-chapter-time">
                          {formatChapterTime(chapter.start)}
                        </span>
                        <div className="ea-chapter-meta">
                          <span className="ea-chapter-name">{chapter.title}</span>
                          {chapter.tag && (
                            <span className="ea-chapter-tag-mini">{chapter.tag}</span>
                          )}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </nav>
          </div>
        </div>

        <MonkeyAgent3DFlow />

        <section className="ea-verify" aria-label="Automated test verification">
          <span className="ea-verify-badge">
            <ShieldCheck size={14} aria-hidden="true" />
            Verified
          </span>
          <p className="ea-verify-text">
            Every feature on this page is backed by automated tests. 12 backend
            unit tests and 318 frontend tests verify circuit breakers, intent
            quotes, and status tracking in CI.{' '}
            <OutboundLink className="ea-verify-link" href={CI_URL}>
              See CI execution runs
            </OutboundLink>
          </p>
        </section>

        <section className="ea-docs-section" aria-labelledby="ea-docs-heading">
          <h2 id="ea-docs-heading" className="ea-docs-title">
            Documentation, Guides, and Source Code
          </h2>
          <p className="ea-docs-subtitle">
            Links, docs, and resources used in the build of the project, including developer guides, smart contracts, and source code.
          </p>

          <div className="ea-docs-grid">
            <div className="ea-docs-group">
              <h3 className="ea-docs-group-title">Aurora Intents Protocol</h3>
              <ul className="ea-docs-list">
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev"
                  >
                    <span>Aurora Intents Documentation</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev/intents-connect/what-is-intents-connect"
                  >
                    <span>What is Intents Connect</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev/intents-deposits/what-are-intents-deposits"
                  >
                    <span>What are Intents Deposits</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev/intents-deposits/supported-chains"
                  >
                    <span>Supported Chains Matrix (38+ Chains)</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://studio.aurora.dev"
                  >
                    <span>Aurora Developer Studio</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
              </ul>
            </div>

            <div className="ea-docs-group">
              <h3 className="ea-docs-group-title">Solana Developer Guides</h3>
              <ul className="ea-docs-list">
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev/intents-connect/developer-guides/solana"
                  >
                    <span>Solana Intents Connect Guide</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev/intents-connect/developer-guides/solana/using-solana-as-destination.md"
                  >
                    <span>Using Solana as Destination</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://docs.intents.aurora.dev/intents-connect/developer-guides/solana/transfer-usdc-scenario.md"
                  >
                    <span>Transfer USDC to Solana Scenario</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://1click.chaindefuser.com/v0/tokens"
                  >
                    <span>1Click Defuse Tokens API</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
              </ul>
            </div>

            <div className="ea-docs-group">
              <h3 className="ea-docs-group-title">Gigr Source Verification</h3>
              <ul className="ea-docs-list">
                <li>
                  <OutboundLink className="ea-docs-link" href={SOURCE_URL}>
                    <span>Gigr GitHub Repository</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://github.com/0GigR/GigR/tree/main/contracts/gigr-escrow"
                  >
                    <span>Anchor Escrow Solana Program</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://github.com/0GigR/GigR/blob/main/backend/app/core/gateways/aurora_intents_gateway.py"
                  >
                    <span>Aurora Intents Backend Gateway</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="ea-docs-link"
                    href="https://github.com/0GigR/GigR/blob/main/frontend/src/services/auroraIntents.ts"
                  >
                    <span>Frontend Aurora Intents Service</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink className="ea-docs-link" href={CI_URL}>
                    <span>CI Test Runs and Logs</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink className="ea-docs-link" href={APPLICATION_URL}>
                    <span>Live Gigr Application</span>
                    <ExternalLink className="ea-docs-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

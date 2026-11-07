/**
 * EncodeAuroraPage.tsx - Hackathon judge briefing for Aurora Intents on Solana.
 *
 * Conforms strictly to house-standard.md:
 * - Uses Gigr's standard dark palette and judges briefing layout (judges.css)
 * - Zero emojis anywhere in code, copy, or markup
 * - Synchronized chapter navigation ready for demo video playback
 * - Zero interactive simulator/sandboxes on this page: pure demo briefing
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import {
  AURORA_CHAPTERS,
  chapterIndexAt,
  formatChapterTime,
} from '@/lib/auroraChapters'
import { playbackCommand } from '@/lib/judgesPlayback'
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import AgentPaymentFlow from '@/components/judges/AgentPaymentFlow'
import './judges.css'

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
    invert?: boolean
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
      width: 24,
      height: 24,
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
      width: 24,
      height: 24,
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
      width: 24,
      height: 24,
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
      width: 24,
      height: 24,
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
  tone,
  children,
}: {
  href: string
  className?: string
  tone?: string
  children: ReactNode
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-tone={tone}
    >
      {children}
    </a>
  )
}

export default function EncodeAuroraPage() {
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
    <div className="judges-page">
      <div className="judges-ambient" aria-hidden="true">
        <div className="judges-aurora judges-aurora-a" />
        <div className="judges-aurora judges-aurora-b" />
        <div className="judges-grid-lines" />
      </div>

      <header className="judges-header">
        <div className="judges-header-inner">
          <Link to="/" className="judges-brand" aria-label="Gigr home">
            <img
              className="judges-logo"
              src="/brands/gigr.png"
              alt="Gigr"
              width={1024}
              height={1024}
            />
            <span className="judges-wordmark">Gigr</span>
            <span className="judges-brand-rule" aria-hidden="true" />
            <span className="judges-brand-context">Encode Aurora Briefing</span>
          </Link>
          <OutboundLink className="judges-header-cta" href={APPLICATION_URL}>
            Open application
            <ExternalLink className="judges-icon" aria-hidden="true" />
          </OutboundLink>
        </div>
      </header>

      <main className="judges-main">
        <section className="judges-hero" aria-labelledby="judges-title">
          <p className="judges-eyebrow">Demo</p>
          <h1 id="judges-title" className="judges-title">
            Any-Chain Liquidity on{' '}
            <span className="judges-title-accent">Solana</span>
          </h1>
          <p className="judges-lede">
            Gigr is a hyperlocal services marketplace with milestone escrow on
            Solana. Powered by Aurora Intents (1Click), users can fund wallets
            and settle milestone escrows from 38+ blockchains with zero manual
            bridging.
          </p>

          <ul className="judges-brand-strip" aria-label="Core brands">
            {BRANDS.map((brand) => (
              <li
                key={brand.name}
                className="judges-brand-tile"
                data-tone={brand.tone}
              >
                <OutboundLink
                  className="judges-brand-tile-link"
                  href={brand.href}
                >
                  {brand.mark ? (
                    <img
                      className="judges-brand-mark"
                      src={brand.mark.src}
                      alt={brand.mark.alt}
                      width={brand.mark.width}
                      height={brand.mark.height}
                      decoding="async"
                    />
                  ) : (
                    <span className="judges-brand-wordmark">{brand.name}</span>
                  )}
                  <span className="judges-brand-tile-name">{brand.name}</span>
                  <span className="judges-brand-tile-role">• {brand.role}</span>
                </OutboundLink>
              </li>
            ))}
          </ul>

          <ul className="judges-stats" aria-label="Project facts">
            {STATS.map((stat) => (
              <li key={stat.label} className="judges-stat">
                <span className="judges-stat-value">{stat.value}</span>{' '}
                <span className="judges-stat-label">{stat.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="judges-grid">
          <section
            className="judges-left"
            aria-labelledby="judges-video-heading"
          >
            <div className="judges-video-head">
              <div>
                <h2 id="judges-video-heading" className="judges-video-title">
                  Demo Walkthrough
                </h2>
                <p className="judges-video-subtitle">
                  Eight chapters. Live Anchor escrow. 38+ chains via Aurora Intents. cNFT reputation. x402 agent payments.
                </p>
              </div>
              <OutboundLink
                className="judges-video-external"
                href={DEMO_VIDEO_URL}
              >
                YouTube
                <ExternalLink className="judges-icon" aria-hidden="true" />
              </OutboundLink>
            </div>

            <div ref={videoFrameRef} className="judges-video-frame">
              <div ref={containerRef} className="judges-video-mount" />
              {!isReady && (
                <div
                  className={`judges-video-status${failed ? ' is-error' : ''}`}
                >
                  {failed ? (
                    <>
                      <span>The embedded player could not start.</span>
                      <OutboundLink
                        className="judges-text-link"
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
                  className="judges-video-play"
                  onClick={playFromGesture}
                  aria-label={
                    ended
                      ? 'Play demo video from start'
                      : 'Play demo video'
                  }
                >
                  <Play aria-hidden="true" />
                  <span>{ended ? 'Play again' : 'Play'}</span>
                </button>
              )}
            </div>

            {isReady && !failed && (
              <div className="judges-video-controls">
                <button
                  type="button"
                  className="judges-video-control"
                  onClick={isPlaying ? pauseFromGesture : playFromGesture}
                  aria-label={
                    isPlaying ? 'Pause demo video' : 'Play demo video'
                  }
                >
                  {isPlaying ? (
                    <Pause aria-hidden="true" />
                  ) : (
                    <Play aria-hidden="true" />
                  )}
                  <span>{isPlaying ? 'Pause' : 'Play'}</span>
                </button>
                <button
                  type="button"
                  className="judges-video-control judges-video-sound"
                  data-muted={isMuted ? 'true' : 'false'}
                  onClick={toggleMute}
                  aria-label={
                    isMuted
                      ? 'Turn video sound on'
                      : 'Turn video sound off'
                  }
                >
                  {isMuted ? (
                    <VolumeX aria-hidden="true" />
                  ) : (
                    <Volume2 aria-hidden="true" />
                  )}
                  <span>{isMuted ? 'Sound off' : 'Sound on'}</span>
                </button>
              </div>
            )}

            <nav className="judges-chapters" aria-label="Video chapters">
              <ol className="judges-chapter-list">
                {AURORA_CHAPTERS.map((chapter, index) => {
                  const isActive = index === activeIndex
                  return (
                    <li key={chapter.id}>
                      <button
                        type="button"
                        className="judges-chapter"
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => selectChapter(index)}
                      >
                        <span className="judges-chapter-time">
                          {formatChapterTime(chapter.start)}
                        </span>
                        <span className="judges-chapter-text">
                          <span className="judges-chapter-title">
                            {chapter.title}
                          </span>
                          {chapter.tag && (
                            <span className="judges-chapter-tag">
                              {chapter.tag}
                            </span>
                          )}
                        </span>
                        <span
                          className="judges-chapter-dot"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  )
                })}
              </ol>
            </nav>
          </section>

          <aside className="judges-panel" aria-labelledby="judges-panel-heading">
            <div className="judges-panel-top">
              <span className="judges-panel-kicker">
                Chapter {activeIndex + 1} of {chapterCount}
              </span>
              <span className="judges-panel-range">
                {formatChapterTime(activeChapter.start)} to{' '}
                {nextChapter ? formatChapterTime(nextChapter.start) : 'end'}
              </span>
            </div>
            {activeChapter.tag && (
              <span className="judges-panel-tag">{activeChapter.tag}</span>
            )}
            <h2 id="judges-panel-heading" className="judges-panel-title">
              {activeChapter.title}
            </h2>
            <div key={activeChapter.id} className="judges-copy">
              {activeChapter.lines.map((line, lineIndex) => (
                <p
                  key={line}
                  className="judges-line"
                  style={{ animationDelay: `${lineIndex * 100}ms` }}
                >
                  <span>{line}</span>
                </p>
              ))}
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              Chapter {activeIndex + 1} of {chapterCount}: {activeChapter.title}
            </p>
          </aside>
        </div>

        <AgentPaymentFlow />

        <section className="judges-verify" aria-label="Verification">
          <span className="judges-verify-label">Verification</span>
          <p className="judges-verify-text">
            Every feature on this page is backed by automated tests. 12 backend
            unit tests and 318 frontend tests verify circuit breakers, intent
            quotes, and status tracking in CI.{' '}
            <OutboundLink className="judges-verify-link" href={CI_URL}>
              See CI runs
            </OutboundLink>
          </p>
        </section>

        <section className="judges-links" aria-labelledby="judges-links-heading">
          <h2 id="judges-links-heading" className="judges-links-title">
            Documentation and source verification
          </h2>
          <div className="judges-links-grid">
            <div className="judges-links-group">
              <h3 className="judges-links-group-title">Aurora Intents</h3>
              <ul className="judges-links-list">
                <li>
                  <OutboundLink
                    className="judges-copy-link"
                    href="https://docs.intents.aurora.dev"
                  >
                    Aurora Intents Documentation
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="judges-copy-link"
                    href="https://docs.intents.aurora.dev/intents-connect/developer-guides/solana"
                  >
                    Solana Intents Connect Guide
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink
                    className="judges-copy-link"
                    href="https://studio.aurora.dev"
                  >
                    Aurora Developer Studio
                  </OutboundLink>
                </li>
              </ul>
            </div>
            <div className="judges-links-group">
              <h3 className="judges-links-group-title">Architecture and Code</h3>
              <ul className="judges-links-list">
                <li>
                  <OutboundLink className="judges-copy-link" href={SOURCE_URL}>
                    Gigr Repository on GitHub
                  </OutboundLink>
                </li>
                <li>
                  <OutboundLink className="judges-copy-link" href={CI_URL}>
                    CI Test Execution Logs
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

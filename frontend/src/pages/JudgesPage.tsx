/**
 * JudgesPage.tsx - the public briefing at /judges.
 *
 * This is the first page a hackathon judge sees, so it is deliberately
 * self-contained: one video with a chapter list, one panel that tracks the
 * chapter, one motion graphic for the paid-agent flow, and the grouped links
 * needed to check every claim. It is not in the dashboard navigation, it does
 * not read the auth store, and it renders for a signed-out visitor.
 *
 * Visual rules: fixed dark palette (the app's dark theme, hue 265), no images
 * beyond the Gigr mark, no animation library, and every motion is CSS that
 * stops under prefers-reduced-motion. The copy panel reveals lines instead of
 * characters so playback is never tied to a JavaScript animation loop.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import {
  JUDGES_CHAPTERS,
  chapterIndexAt,
  formatChapterTime,
} from '@/lib/judgesChapters'
import {
  JUDGES_BRANDS,
  JUDGES_STATS,
  JUDGE_BRAND_LINKS,
  JUDGE_PRODUCT_LINKS,
} from '@/lib/judgesContent'
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer'
import AgentPaymentFlow from '@/components/judges/AgentPaymentFlow'
import './judges.css'

const DEMO_VIDEO_ID = 'HM9IAKpiks0'
const DEMO_VIDEO_URL = 'https://youtu.be/HM9IAKpiks0'
const APPLICATION_URL = 'https://gigrr.vercel.app'
const SOURCE_URL = 'https://github.com/0GigR/GigR'
const CI_URL = 'https://github.com/0GigR/GigR/actions'

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

export default function JudgesPage() {
  const [activeIndex, setActiveIndex] = useState(0)
  // A chapter click seeks the player, but YouTube reports the old time for a
  // few hundred milliseconds while it buffers. Hold the clicked chapter until
  // the player agrees (or four seconds pass) so the copy panel cannot flash
  // back to the previous chapter.
  const seekLockRef = useRef<{ index: number; expires: number } | null>(null)

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

  const { containerRef, isReady, failed, seekTo } = useYouTubePlayer(
    DEMO_VIDEO_ID,
    handleTime,
  )

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Gigr for judges'
    return () => {
      document.title = previousTitle
    }
  }, [])

  const activeChapter = JUDGES_CHAPTERS[activeIndex] ?? JUDGES_CHAPTERS[0]
  const nextChapter = JUDGES_CHAPTERS[activeIndex + 1]
  const chapterCount = JUDGES_CHAPTERS.length

  const selectChapter = useCallback(
    (index: number) => {
      const chapter = JUDGES_CHAPTERS[index]
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
            <img className="judges-logo" src="/icon.png" alt="" width={34} height={34} />
            <span className="judges-wordmark">Gigr</span>
            <span className="judges-brand-rule" aria-hidden="true" />
            <span className="judges-brand-context">Judge briefing</span>
          </Link>
          <OutboundLink className="judges-header-cta" href={APPLICATION_URL}>
            Open application
            <ExternalLink className="judges-icon" aria-hidden="true" />
          </OutboundLink>
        </div>
      </header>

      <main className="judges-main">
        <section className="judges-hero" aria-labelledby="judges-title">
          <p className="judges-eyebrow">Hackathon judge briefing</p>
          <h1 id="judges-title" className="judges-title">
            The agent that <span className="judges-title-accent">remembers</span>.
          </h1>
          <p className="judges-lede">
            Gigr is a local-services marketplace with milestone escrow. Its agent
            remembers each user with <strong className="judges-name">Walrus</strong>{' '}
            memory and verifies every payment through{' '}
            <strong className="judges-name">Tatum</strong>.
          </p>

          <ul className="judges-brand-strip" aria-label="Core brands">
            {JUDGES_BRANDS.map((brand) => (
              <li key={brand.name} className="judges-brand-tile" data-tone={brand.tone}>
                <span className="judges-brand-tile-name">{brand.name}</span>{' '}
                <span className="judges-brand-tile-role">{brand.role}</span>
              </li>
            ))}
          </ul>

          <div className="judges-hero-actions">
            <OutboundLink className="judges-button judges-button-primary" href={APPLICATION_URL}>
              Open application
              <ExternalLink className="judges-icon" aria-hidden="true" />
            </OutboundLink>
            <OutboundLink className="judges-button" href={DEMO_VIDEO_URL}>
              Watch demo
              <ExternalLink className="judges-icon" aria-hidden="true" />
            </OutboundLink>
            <OutboundLink className="judges-text-link" href={SOURCE_URL}>
              Source on GitHub
            </OutboundLink>
          </div>

          <ul className="judges-stats" aria-label="Project facts">
            {JUDGES_STATS.map((stat) => (
              <li key={stat.phrase} className="judges-stat">
                <span className="judges-stat-value">{stat.value}</span>{' '}
                <span className="judges-stat-label">{stat.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="judges-grid">
          <section className="judges-left" aria-labelledby="judges-video-heading">
            <div className="judges-video-head">
              <div>
                <h2 id="judges-video-heading" className="judges-video-title">
                  Demo walkthrough
                </h2>
                <p className="judges-video-subtitle">
                  Four chapters. Just over six minutes. No account needed.
                </p>
              </div>
              <OutboundLink className="judges-video-external" href={DEMO_VIDEO_URL}>
                YouTube
                <ExternalLink className="judges-icon" aria-hidden="true" />
              </OutboundLink>
            </div>

            <div className="judges-video-frame">
              <div ref={containerRef} className="judges-video-mount" />
              {!isReady && (
                <div className={`judges-video-status${failed ? ' is-error' : ''}`}>
                  {failed ? (
                    <>
                      <span>The embedded player could not start.</span>
                      <OutboundLink className="judges-text-link" href={DEMO_VIDEO_URL}>
                        Watch the demo on YouTube
                      </OutboundLink>
                    </>
                  ) : (
                    <span>Loading the player</span>
                  )}
                </div>
              )}
            </div>

            <nav className="judges-chapters" aria-label="Video chapters">
              <ol className="judges-chapter-list">
                {JUDGES_CHAPTERS.map((chapter, index) => {
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
                          <span className="judges-chapter-title">{chapter.title}</span>
                          {chapter.tag && (
                            <span className="judges-chapter-tag">{chapter.tag}</span>
                          )}
                        </span>
                        <span className="judges-chapter-dot" aria-hidden="true" />
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
              {activeChapter.lines.map((line, index) => (
                <p
                  key={line}
                  className="judges-line"
                  style={{ animationDelay: `${index * 100}ms` }}
                >
                  {line}
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
            Every claim on this page has a test behind it. 285 backend tests and 8
            new frontend test files were written for this build, and CI is green.{' '}
            <OutboundLink className="judges-verify-link" href={CI_URL}>
              See the CI runs
            </OutboundLink>
          </p>
        </section>

        <section className="judges-links" aria-labelledby="judges-links-heading">
          <div className="judges-section-head">
            <h2 id="judges-links-heading" className="judges-section-title">
              Check the work
            </h2>
            <p className="judges-section-note">
              The application, the source, and every brand named in the video.
            </p>
          </div>

          <div className="judges-link-group">
            <h3 className="judges-link-group-title">Built on</h3>
            <ul className="judges-brand-links">
              {JUDGE_BRAND_LINKS.map((link) => (
                <li key={link.label}>
                  <OutboundLink
                    className="judges-brand-link"
                    href={link.href}
                    tone={link.tone}
                  >
                    <span className="judges-brand-link-name" data-tone={link.tone}>
                      {link.label}
                    </span>
                    <span className="judges-brand-link-note">{link.note}</span>
                    <ExternalLink className="judges-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
              ))}
            </ul>
          </div>

          <div className="judges-link-group">
            <h3 className="judges-link-group-title">Gigr</h3>
            <ul className="judges-link-grid">
              {JUDGE_PRODUCT_LINKS.map((link) => (
                <li key={link.label}>
                  <OutboundLink className="judges-link" href={link.href}>
                    <span className="judges-link-text">
                      <span className="judges-link-label">{link.label}</span>
                      <span className="judges-link-note">{link.note}</span>
                    </span>
                    <ExternalLink className="judges-icon" aria-hidden="true" />
                  </OutboundLink>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <footer className="judges-footer">
          <p className="judges-footer-line">
            Gigr. Escrow-backed local work, with an agent that remembers.
          </p>
          <div className="judges-footer-links">
            <OutboundLink className="judges-text-link" href={APPLICATION_URL}>
              gigrr.vercel.app
            </OutboundLink>
            <OutboundLink className="judges-text-link" href={SOURCE_URL}>
              GitHub
            </OutboundLink>
            <a className="judges-text-link" href="#judges-title">
              Back to top
            </a>
          </div>
        </footer>
      </main>
    </div>
  )
}

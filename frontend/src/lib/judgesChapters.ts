/**
 * judgesChapters.ts - the single source of truth for the /judges briefing.
 *
 * The video timeline, the chapter buttons and the copy panel all read from
 * this file. Keeping the mapping pure (no React, no DOM) means the two things
 * that can silently drift - a chapter time and the chapter that is active at
 * a given playback second - are covered by unit tests.
 *
 * Times are seconds into the YouTube video, exactly as the chapter labels on
 * the page show them (0:00, 0:46, 3:20, 4:32).
 */

/** Fallback length of the submission video, used until the player reports one. */
export const JUDGES_VIDEO_DURATION_SECONDS = 378

export type JudgesChapterId = 'intro' | 'memory' | 'tatum' | 'x402'

export interface JudgesChapter {
  id: JudgesChapterId
  title: string
  /** Brand tag shown on the chapter row and in the copy panel. Intro has none. */
  tag: string | null
  /** Playback second at which the chapter starts. */
  start: number
  /** Short lines revealed in the right-hand panel. */
  lines: readonly string[]
}

export const JUDGES_CHAPTERS: readonly JudgesChapter[] = [
  {
    id: 'intro',
    title: 'Intro',
    tag: null,
    start: 0,
    lines: [
      'Gigr is a local-services marketplace. People post a job or offer a service, and payment sits in escrow until each milestone is accepted.',
      'Gigidy is the agent inside it. You describe the job in conversation and it does the work that forms used to do.',
      'That design exposed the real problem: the agent was stateless.',
      'Every session started at zero. It could not remember a street, a budget, or a detail already given.',
      'The same questions came back, and nothing carried from one job to the next.',
      'What you are watching is the fix: memory that belongs to one user, survives the session, and is recalled by meaning.',
      'The next three chapters show how that memory works and how the payments around it are verified.',
    ],
  },
  {
    id: 'memory',
    title: 'Walrus memory',
    tag: 'Walrus Memory / MemWal',
    start: 46,
    lines: [
      'Each user gets a namespace on Walrus. Their memories live there, not in our database.',
      'Recall is by meaning, not by key. The agent asks a question, Gigr embeds it, and returns the closest memories.',
      'Facts are extracted from real rows by templates. No model writes a memory from nothing, so nothing is invented.',
      'The store grows with use. Every job, correction and stated preference adds to it.',
      'Deleting one memory is the hard part. Walrus deletes a whole namespace, not a single record.',
      'So a delete rewrites the namespace without that memory and saves everything again; the recovery test is the proof.',
      'The upstream SDK had no delete at all. That fix shipped in memwal 0.2.2.',
      'A user can still ask to be forgotten, and the next read confirms the fact is gone.',
    ],
  },
  {
    id: 'tatum',
    title: 'Tatum integration',
    tag: 'Tatum / Sui',
    start: 200,
    lines: [
      'Tatum is the read layer: three integrations across two chains.',
      'Reads on Solana go through Tatum: the account and the latest blockhash, with a four second timeout and a single fast fallback if a read times out.',
      'Sui has deprecated JSON-RPC. On Sui, gRPC get_object reads the blob we verified and its certified epoch.',
      'Tatum\'s getTransaction verifies every x402 payment before Gigr answers.',
      'The discipline is simple: writes never go through Tatum.',
      'Escrow, milestone releases and settlement are signed by our own transaction path.',
      'That is why escrow has not broken, even when a provider was slow or returned an error.',
      'Tatum gives us reads we can retry. It never holds the keys.',
    ],
  },
  {
    id: 'x402',
    title: 'x402 agent payments',
    tag: 'x402 / agent payments',
    start: 272,
    lines: [
      'An external agent cannot sign up. It has no email, no password and no browser.',
      'So Gigr answers with HTTP 402 and a price instead of a login wall.',
      'The challenge is 0.01 USDC, with a nonce.',
      'Gigr verifies on chain: the right mint, the right recipient, the right amount, and a signature that has not been spent.',
      'One payment buys one brief. There is no account and no session.',
      'The agent pays, receives the brief and can cite it.',
      "x402's own network list does not support Sui, so this rail settles on Solana; a community Sui scheme (suimpp) is the next rail.",
      'That is the whole exchange: a price, a payment, and a check before the data moves.',
    ],
  },
]

/**
 * Index of the chapter that is playing at `timeSeconds`.
 *
 * The last chapter whose start is at or before the playhead wins, so the
 * boundaries belong to the chapter that starts on them: 45.9 is still Intro,
 * 46 is Walrus memory. A negative or non-finite time (an unfilled player, a
 * seek that returned NaN) falls back to the first chapter rather than
 * producing an invalid index.
 */
export function chapterIndexAt(
  timeSeconds: number,
  chapters: readonly JudgesChapter[] = JUDGES_CHAPTERS,
): number {
  if (!Number.isFinite(timeSeconds)) return 0

  let index = 0
  for (let i = 0; i < chapters.length; i += 1) {
    if (timeSeconds >= chapters[i].start) index = i
    else break
  }
  return index
}

/** Chapter clock as m:ss, the same format the buttons show. */
export function formatChapterTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * Keeps a chapter seek inside the video. The caller passes the player's own
 * duration when it has one (a re-uploaded or trimmed video could differ from
 * the fallback), so a seek can never land past the end or before the start.
 */
export function clampSeekTime(
  seconds: number,
  duration: number = JUDGES_VIDEO_DURATION_SECONDS,
): number {
  if (!Number.isFinite(seconds)) return 0
  const max =
    Number.isFinite(duration) && duration > 0 ? duration : JUDGES_VIDEO_DURATION_SECONDS
  return Math.min(Math.max(seconds, 0), max)
}

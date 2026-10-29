/**
 * chainProof.ts - the presentational rules behind the "Prove it on chain" panel.
 *
 * The panel makes one honest claim: a Walrus blob is a Sui object, so its
 * existence and certification can be read from the chain. Everything here turns
 * the backend's verification answer into labels a reader can check against that
 * claim, and nothing here can invent a verified state: the only source of the
 * badge is `verified === true` from the server.
 *
 * The known-good reference is a real Walrus blob object that the deployment's
 * Sui gateway resolves, so the demo starts from evidence rather than a blank
 * field. It is a default, not a claim: the panel still verifies it live.
 */

import type { MemoryVerification, VerificationTone } from './agentMemory'
import { verificationTone } from './agentMemory'

/** The Walrus blob object the panel prefills. Verified live, never assumed. */
export const KNOWN_GOOD_SUI_OBJECT_ID =
  '0x0000003c64bf4bda578d911acb4f93f470a89f66d9fd8993fdb032cf007b1c93'

export type ProofAvailability = 'enabled' | 'feature_disabled' | 'not_configured'

/**
 * Whether a verification answer means the deployment can check anything at all.
 *
 * `tatum_not_configured` is not the same as the flag being off: the capability
 * is enabled but has no credentials, and the panel says that instead of asking
 * the reader to paste an id that cannot resolve.
 */
export function proofAvailability(reason: string): ProofAvailability {
  if (reason === 'feature_disabled') return 'feature_disabled'
  if (reason === 'tatum_not_configured') return 'not_configured'
  return 'enabled'
}

export interface ProofNotice {
  title: string
  body: string
}

/** The calm explanation shown in place of the form when nothing can be checked. */
export function proofUnavailableNotice(reason: string): ProofNotice | null {
  const availability = proofAvailability(reason)
  if (availability === 'feature_disabled') {
    return {
      title: 'Verification is not enabled on this deployment',
      body: 'Sui verification is turned off in this environment, so the on-chain check cannot run here. Walrus Memory itself is not affected. Nothing is wrong with your data.',
    }
  }
  if (availability === 'not_configured') {
    return {
      title: 'Verification is not configured on this deployment',
      body: 'Sui verification is enabled but this deployment has no Tatum Sui credentials, so the check cannot reach the chain. Walrus Memory itself is not affected.',
    }
  }
  return null
}

/**
 * The owner kind in the words the panel shows.
 *
 * The gateway reports Sui's owner kind lower case (`address`, `shared`,
 * `immutable`, `object`). Capitalizing is presentation only; an unset kind is
 * reported as unknown rather than guessed.
 */
export function ownerKindLabel(kind: string | null | undefined): string {
  if (typeof kind !== 'string') return 'Unknown'
  const trimmed = kind.trim()
  if (!trimmed) return 'Unknown'
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

export interface ProofField {
  label: string
  value: string
  mono?: boolean
  /** Long identifiers get the full row so they wrap instead of crushing a column. */
  wide?: boolean
}

/**
 * The facts the panel prints for one answer.
 *
 * Only fields the server actually returned are included, so an object that is
 * not a Walrus blob shows its type, version and owner without a blank
 * "Certified epoch" row implying the value was checked and missing. Order is
 * fixed: identity first, then the certification facts.
 */
export function proofFields(result: MemoryVerification): ProofField[] {
  const fields: ProofField[] = []
  if (result.object_type) {
    fields.push({ label: 'Object type', value: result.object_type, mono: true, wide: true })
  }
  if (typeof result.object_version === 'number') {
    fields.push({ label: 'Version', value: String(result.object_version), mono: true })
  }
  if (result.owner_kind) {
    fields.push({ label: 'Owner kind', value: ownerKindLabel(result.owner_kind) })
  }
  // Certification facts are printed only when the server actually verified the
  // blob. A malformed body that names an epoch without verifying must not put a
  // certified number next to an unverified badge.
  if (result.verified) {
    if (typeof result.certified_epoch === 'number') {
      fields.push({ label: 'Certified epoch', value: String(result.certified_epoch) })
    }
    if (typeof result.end_epoch === 'number') {
      fields.push({ label: 'Storage end epoch', value: String(result.end_epoch) })
    }
  }
  if (typeof result.deletable === 'boolean') {
    fields.push({ label: 'Deletable', value: result.deletable ? 'Yes' : 'No' })
  }
  return fields
}

export interface ProofBadge {
  tone: VerificationTone
  label: string
}

/**
 * The badge for one answer. Only a verified answer may say "Verified".
 *
 * The tone is computed here from the same gate the rest of the page uses, so a
 * refusal that names its reason keeps the badge "Not verified" or "Unavailable";
 * the reason text is rendered next to it and carries the detail.
 */
export function proofBadge(result: MemoryVerification): ProofBadge {
  const tone = verificationTone(result)
  if (tone === 'verified') return { tone, label: 'Verified on Sui' }
  if (tone === 'unverified') return { tone, label: 'Not verified' }
  return { tone, label: 'Unavailable' }
}

/**
 * Which payment rail this frontend build uses, set with VITE_PAYMENT_RAIL at
 * build time ('solana' | 'paypal'). Defaults to 'solana', the original app.
 *
 * It is sent to the backend as `X-Payment-Rail` on every request (see lib/api),
 * so one backend serves both a Solana frontend and a PayPal frontend.
 */
export type PaymentRail = 'paypal' | 'solana'

const raw = String(import.meta.env.VITE_PAYMENT_RAIL ?? '').trim().toLowerCase()

export const PAYMENT_RAIL: PaymentRail = raw === 'paypal' ? 'paypal' : 'solana'

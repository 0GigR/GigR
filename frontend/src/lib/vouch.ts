/**
 * How a vouch's proof is described. On the PayPal rail a vouch is anchored to the
 * PayPal payout that paid the provider for the job (`paypal:<payout batch id>`);
 * on the Solana rail it is a compressed NFT whose asset id is stored instead.
 */
export type VouchProof = { label: string; tone: 'paypal' | 'onchain' | 'pending' }

export function vouchProof(cnfNftId?: string | null): VouchProof {
  if (!cnfNftId || cnfNftId === 'pending') return { label: 'Pending', tone: 'pending' }
  if (cnfNftId.startsWith('paypal:')) return { label: 'Verified by PayPal payout', tone: 'paypal' }
  return { label: 'cNFT on-chain', tone: 'onchain' }
}

export const VOUCH_TONE_CLASS: Record<VouchProof['tone'], string> = {
  paypal: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  onchain: 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  pending: 'bg-gray-50 dark:bg-background text-gray-500 dark:text-muted-foreground border-gray-200 dark:border-border',
}

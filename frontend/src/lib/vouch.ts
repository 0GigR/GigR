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
  paypal: 'bg-blue-50 text-blue-700 border-blue-200',
  onchain: 'bg-purple-50 text-purple-600 border-purple-200',
  pending: 'bg-gray-50 text-gray-500 border-gray-200',
}

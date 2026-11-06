/**
 * AuroraTokenSelect.tsx - Rich multi-chain token selector for Aurora Intents.
 *
 * Conforms strictly to house-standard.md:
 * - Pure React UI with clean Radix-style state
 * - Zero emojis anywhere in labels or strings
 * - Displays chain badges, token symbols, and stablecoin indicators
 */

import { useState } from 'react'
import { Check, ChevronDown, Coins, Search, ShieldCheck } from 'lucide-react'
import {
  AURORA_SUPPORTED_CHAINS,
  type AuroraChain,
  type AuroraTokenCategory,
} from '@/lib/auroraIntents'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

interface Props {
  selectedChainId: string
  onSelect: (chain: AuroraChain) => void
  disabled?: boolean
}

function getChainBadgeTone(chainName: string): string {
  const lower = chainName.toLowerCase()
  if (lower.includes('base')) return 'bg-blue-600/15 text-blue-500 border-blue-500/30'
  if (lower.includes('arbitrum')) return 'bg-sky-600/15 text-sky-400 border-sky-500/30'
  if (lower.includes('ethereum')) return 'bg-purple-600/15 text-purple-400 border-purple-500/30'
  if (lower.includes('bitcoin')) return 'bg-amber-600/15 text-amber-500 border-amber-500/30'
  if (lower.includes('polygon')) return 'bg-violet-600/15 text-violet-400 border-violet-500/30'
  if (lower.includes('optimism')) return 'bg-rose-600/15 text-rose-400 border-rose-500/30'
  if (lower.includes('avalanche')) return 'bg-red-600/15 text-red-400 border-red-500/30'
  if (lower.includes('solana')) return 'bg-emerald-600/15 text-emerald-400 border-emerald-500/30'
  if (lower.includes('sui')) return 'bg-cyan-600/15 text-cyan-400 border-cyan-500/30'
  if (lower.includes('tron')) return 'bg-teal-600/15 text-teal-400 border-teal-500/30'
  if (lower.includes('stellar')) return 'bg-indigo-600/15 text-indigo-400 border-indigo-500/30'
  if (lower.includes('ton')) return 'bg-blue-600/15 text-blue-400 border-blue-500/30'
  if (lower.includes('doge')) return 'bg-yellow-600/15 text-yellow-500 border-yellow-500/30'
  if (lower.includes('monad')) return 'bg-purple-600/15 text-purple-400 border-purple-500/30'
  if (lower.includes('near')) return 'bg-emerald-600/15 text-emerald-400 border-emerald-500/30'
  if (lower.includes('bera')) return 'bg-amber-600/15 text-amber-500 border-amber-500/30'
  return 'bg-muted text-muted-foreground border-border'
}

export function AuroraTokenSelect({ selectedChainId, onSelect, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | AuroraTokenCategory>('all')
  const [search, setSearch] = useState('')

  const selectedChain =
    AURORA_SUPPORTED_CHAINS.find((c) => c.id === selectedChainId) ||
    AURORA_SUPPORTED_CHAINS[0]

  const filteredChains = AURORA_SUPPORTED_CHAINS.filter((c) => {
    if (filter !== 'all' && c.category !== filter) return false
    if (!search.trim()) return true
    const term = search.toLowerCase()
    return (
      c.name.toLowerCase().includes(term) ||
      c.nativeSymbol.toLowerCase().includes(term) ||
      c.description.toLowerCase().includes(term)
    )
  })

  return (
    <div className="relative w-full">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center justify-between p-2.5 rounded-lg border border-border bg-background hover:bg-muted/40 transition-colors text-left"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${getChainBadgeTone(
              selectedChain.name
            )}`}
          >
            {selectedChain.name}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-xs text-foreground">
                {selectedChain.nativeSymbol}
              </span>
              {selectedChain.category === 'stablecoin' && (
                <Badge
                  variant="outline"
                  className="text-[9px] h-4 px-1 py-0 font-normal border-border text-muted-foreground"
                >
                  Stablecoin (1:1)
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground truncate">
              {selectedChain.description}
            </p>
          </div>
        </div>
        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-popover text-popover-foreground border border-border rounded-xl shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100">
            {/* Search and Category Filters */}
            <div className="p-2 border-b border-border bg-muted/30 space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search 38+ blockchains or tokens..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 text-xs pl-8 bg-background"
                  autoFocus
                />
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors shrink-0 ${
                    filter === 'all'
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  All ({AURORA_SUPPORTED_CHAINS.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('stablecoin')}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors flex items-center gap-1 shrink-0 ${
                    filter === 'stablecoin'
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" /> Stablecoins (1:1)
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('native')}
                  className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors flex items-center gap-1 shrink-0 ${
                    filter === 'native'
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Coins className="w-3 h-3" /> Native Assets
                </button>
              </div>
            </div>

            {/* Token List */}
            <ul
              className="max-h-60 overflow-y-auto divide-y divide-border/40 p-1"
              role="listbox"
            >
              {filteredChains.length === 0 ? (
                <li className="p-4 text-center text-xs text-muted-foreground">
                  No chains found matching "{search}"
                </li>
              ) : (
                filteredChains.map((chain) => {
                  const isSelected = chain.id === selectedChain.id
                  return (
                    <li key={chain.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          onSelect(chain)
                          setOpen(false)
                        }}
                        className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors ${
                          isSelected
                            ? 'bg-muted/70 text-foreground'
                            : 'hover:bg-muted/40 text-foreground'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${getChainBadgeTone(
                              chain.name
                            )}`}
                          >
                            {chain.name}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-xs">
                                {chain.nativeSymbol}
                              </span>
                              {chain.category === 'stablecoin' && (
                                <span className="text-[9px] font-mono text-muted-foreground">
                                  1:1 USDC
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground truncate">
                              {chain.description}
                            </p>
                          </div>
                        </div>
                        {isSelected && (
                          <Check className="w-3.5 h-3.5 text-primary shrink-0 ml-2" />
                        )}
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

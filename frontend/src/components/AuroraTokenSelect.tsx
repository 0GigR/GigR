/**
 * AuroraTokenSelect.tsx - Rich multi-chain token selector for Aurora Intents.
 *
 * Conforms strictly to house-standard.md:
 * - Pure React UI with clean Radix-style state
 * - Zero emojis anywhere in labels or strings
 * - Real vector brand logos for all 38+ blockchains and tokens
 * - Responsive mobile sheet/modal that never hides search results behind virtual keyboard
 */

import { useState, useEffect } from 'react'
import { Check, ChevronDown, Coins, Search, ShieldCheck, X } from 'lucide-react'
import {
  AURORA_SUPPORTED_CHAINS,
  type AuroraChain,
  type AuroraTokenCategory,
} from '@/lib/auroraIntents'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ChainLogo } from '@/components/ChainLogo'

interface Props {
  selectedChainId: string
  onSelect: (chain: AuroraChain) => void
  disabled?: boolean
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

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  return (
    <div className="w-full">
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-between p-2.5 rounded-xl border border-border bg-background hover:bg-muted/40 transition-colors text-left"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <div className="flex items-center gap-3 min-w-0">
          <ChainLogo
            name={selectedChain.name}
            symbol={selectedChain.nativeSymbol}
            size={32}
            className="shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-xs text-foreground">
                {selectedChain.name}
              </span>
              <span className="text-xs text-muted-foreground font-medium">
                • {selectedChain.nativeSymbol}
              </span>
              {selectedChain.category === 'stablecoin' && (
                <Badge
                  variant="outline"
                  className="text-[9px] h-4 px-1 py-0 font-normal border-border text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                >
                  1:1 USDC
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

      {/* Responsive Modal/Bottom Sheet for Mobile and Desktop */}
      {open && (
        <div
          className="fixed inset-0 z-70 bg-black/60 backdrop-blur-xs flex flex-col justify-end sm:justify-center items-center p-0 sm:p-4 animate-in fade-in-0 duration-150"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Select Chain and Asset"
        >
          <div
            className="w-full sm:max-w-md bg-card text-card-foreground border-t sm:border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[88dvh] sm:max-h-[80vh] overflow-hidden animate-in slide-in-from-bottom-4 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile Sheet Drag Handle */}
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

            {/* Header */}
            <div className="p-3.5 sm:p-4 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-foreground">
                  Select Chain & Token
                </h3>
                <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                  {AURORA_SUPPORTED_CHAINS.length} Chains
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground rounded-full"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Search Input and Filter Tabs (Sticky at top) */}
            <div className="p-3 border-b border-border bg-muted/20 space-y-2 shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search chains or tokens (e.g. Base, SOL, Sui)..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 text-xs pl-9 pr-8 bg-background rounded-lg"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 ${
                    filter === 'all'
                      ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                      : 'text-muted-foreground hover:text-foreground bg-muted/40'
                  }`}
                >
                  All ({AURORA_SUPPORTED_CHAINS.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('stablecoin')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                    filter === 'stablecoin'
                      ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                      : 'text-muted-foreground hover:text-foreground bg-muted/40'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" /> Stablecoins (1:1)
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('native')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                    filter === 'native'
                      ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                      : 'text-muted-foreground hover:text-foreground bg-muted/40'
                  }`}
                >
                  <Coins className="w-3 h-3" /> Native
                </button>
              </div>
            </div>

            {/* Scrollable Token List */}
            <ul
              className="flex-1 overflow-y-auto overscroll-contain p-2 space-y-1"
              role="listbox"
            >
              {filteredChains.length === 0 ? (
                <li className="p-8 text-center text-xs text-muted-foreground">
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
                        className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-colors min-h-12 ${
                          isSelected
                            ? 'bg-primary/10 text-foreground border border-primary/20'
                            : 'hover:bg-muted/50 text-foreground border border-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <ChainLogo
                            name={chain.name}
                            symbol={chain.nativeSymbol}
                            size={32}
                            className="shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-xs text-foreground">
                                {chain.name}
                              </span>
                              <span className="text-xs font-medium text-muted-foreground">
                                • {chain.nativeSymbol}
                              </span>
                              {chain.category === 'stablecoin' && (
                                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                  1:1 USDC
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {chain.description}
                            </p>
                          </div>
                        </div>
                        {isSelected && (
                          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0 ml-2">
                            <Check className="w-3 h-3 text-primary-foreground stroke-[3]" />
                          </div>
                        )}
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

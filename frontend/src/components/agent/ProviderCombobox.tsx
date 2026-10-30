/**
 * ProviderCombobox.tsx - the searchable provider picker on the Agent access page.
 *
 * This is a real combobox, not a native select: a text field that filters the
 * list as it is typed, a listbox of results under it, and the keyboard rules a
 * reader expects (Down and Up move the highlight and wrap, Enter picks, Escape
 * and Tab close). It never renders a browser default dropdown.
 *
 * The filtering and the keyboard arithmetic live in lib/providerPicker.ts so
 * they can be tested without a DOM; this file is the renderer. Every interactive
 * target is at least 44px tall and the layout is one column, because the demo is
 * recorded on a 390px phone.
 *
 * Blur closes the list. The options cancel mousedown so a click on a result does
 * not blur the field before the click lands, and the wrapper ignores a blur that
 * moves focus to its own clear button.
 */

import { useId, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Loader2, RefreshCw, Search, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  filterProviders,
  moveActiveIndex,
  providerCategoryLabel,
  providerMetaLabel,
  providerRatingLabel,
  type BriefProvider,
} from '@/lib/providerPicker'

/** The smallest comfortable touch target, in Tailwind units. */
const TOUCH_TARGET = 'h-11 min-h-11'

interface ProviderComboboxProps {
  providers: BriefProvider[]
  selected: BriefProvider | null
  onSelect: (provider: BriefProvider | null) => void
  loading: boolean
  failed: boolean
  onRetry: () => void
  disabled?: boolean
}

export function ProviderCombobox({
  providers,
  selected,
  onSelect,
  loading,
  failed,
  onRetry,
  disabled = false,
}: ProviderComboboxProps) {
  const inputId = useId()
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const matches = filterProviders(providers, query)
  // The highlight is clamped rather than stored, so a list that shrank under a
  // keystroke can never point past its end.
  const active = matches.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), matches.length - 1)
  const showList = open && !loading && !failed && !disabled

  const choose = (provider: BriefProvider) => {
    onSelect(provider)
    setQuery(provider.name)
    setActiveIndex(-1)
    setOpen(false)
  }

  const clear = () => {
    onSelect(null)
    setQuery('')
    setActiveIndex(-1)
    setOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) =>
        moveActiveIndex(
          current,
          event.key === 'ArrowDown' ? 1 : -1,
          matches.length,
        ),
      )
      return
    }
    if (event.key === 'Enter' && showList && active >= 0 && matches[active]) {
      event.preventDefault()
      choose(matches[active])
    }
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setOpen(false)
  }

  return (
    <div onBlur={handleBlur}>
      <label
        htmlFor={inputId}
        className="text-[11px] font-medium uppercase tracking-wide text-gray-500"
      >
        Provider
      </label>

      <div className="relative mt-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search providers"
          value={query}
          disabled={disabled || loading}
          placeholder={
            loading ? 'Reading the providers...' : 'Search by provider name or category'
          }
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
            setOpen(true)
            // Editing the field means the old choice no longer matches what is
            // written in it, so the choice is dropped instead of hidden.
            if (selected && event.target.value !== selected.name) onSelect(null)
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className={`${TOUCH_TARGET} pl-9 text-sm ${selected ? 'pr-12' : 'pr-3'}`}
        />
        {selected && (
          <button
            type="button"
            onClick={clear}
            aria-label={`Clear the chosen provider, ${selected.name}`}
            className={`absolute right-0 top-0 flex w-11 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 ${TOUCH_TARGET}`}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {loading && (
        <p className="mt-2 flex items-center gap-2 text-xs text-gray-500" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Reading the providers in the marketplace.
        </p>
      )}

      {!loading && failed && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950/40">
          <p className="text-xs text-gray-600 dark:text-gray-300">
            We could not read the provider list. You can still paste a job id below and ask
            for a quote.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetry}
            className={`mt-2 gap-1.5 ${TOUCH_TARGET}`}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Providers"
          className="mt-2 max-h-64 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-950/60"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-4 text-xs text-gray-500">
              No provider here matches that name. Try part of their name, or paste a job id
              below.
            </li>
          ) : (
            matches.map((provider, index) => (
              <li
                key={provider.providerId}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                // Mousedown is cancelled so the field keeps focus and the click
                // still lands: a blur here would close the list first.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(provider)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-left ${
                  index === active
                    ? 'bg-gray-100 dark:bg-gray-800'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-900'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {provider.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-gray-500">
                    {providerCategoryLabel(provider)}
                  </span>
                </span>
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                  aria-label={providerRatingLabel(provider)}
                >
                  <Star className="h-3 w-3" aria-hidden="true" />
                  {provider.ratingAverage === null || provider.ratingCount === 0
                    ? 'New'
                    : provider.ratingAverage.toFixed(1)}
                </span>
              </li>
            ))
          )}
        </ul>
      )}

      {selected && (
        <p className="mt-2 text-[11px] leading-relaxed text-gray-500" aria-live="polite">
          {`The brief will be about this provider's completed job "${selected.jobTitle}". `}
          {`${providerMetaLabel(selected)}.`}
        </p>
      )}
    </div>
  )
}

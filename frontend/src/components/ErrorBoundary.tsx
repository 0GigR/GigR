import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, RefreshCw, ChevronDown } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Changing this clears the error — pass the route path so navigating recovers. */
  resetKey?: string
  /** What failed, e.g. "This map". Shown to the user. */
  label?: string
  /** Render an inline card instead of taking over the whole screen. */
  compact?: boolean
}

interface State {
  error: Error | null
  info: string | null
  showDetails: boolean
}

/**
 * Catches render errors.
 *
 * Two things matter here. First, scope: the app-level boundary is a last resort,
 * and individual areas wrap their own content so one broken section can no longer
 * replace the entire app with an error page. Second, diagnosis: the previous
 * version rendered only `error.message`, which is how a report arrived as
 * "(E ?? []) is not iterable" with no clue where it came from. This one keeps the
 * component stack and lets you copy it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, showDetails: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label ?? 'app'}]`, error, info.componentStack)
    this.setState({ info: info.componentStack ?? null })
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.reset()
    }
  }

  reset = () => this.setState({ error: null, info: null, showDetails: false })

  copyDetails = () => {
    const { error, info } = this.state
    const text = [
      `Area: ${this.props.label ?? 'app'}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : 'n/a'}`,
      `Error: ${error?.name}: ${error?.message}`,
      `Stack: ${error?.stack ?? 'n/a'}`,
      `Component stack: ${info ?? 'n/a'}`,
    ].join('\n\n')
    navigator.clipboard?.writeText(text).catch(() => {})
  }

  render() {
    const { error, info, showDetails } = this.state
    if (!error) return this.props.children

    const { compact, label } = this.props

    const details = showDetails ? (
      <div className="mt-4 text-left">
        <pre className="max-h-56 overflow-auto rounded-lg bg-gray-900 text-gray-100 text-[11px] leading-relaxed p-3 whitespace-pre-wrap">
          {error.name}: {error.message}
          {info ? `\n${info}` : ''}
        </pre>
        <button
          type="button"
          onClick={this.copyDetails}
          className="mt-2 text-xs font-medium text-gray-500 hover:text-black dark:hover:text-white"
        >
          Copy details
        </button>
      </div>
    ) : null

    const toggleDetails = (
      <button
        type="button"
        onClick={() => this.setState((s) => ({ showDetails: !s.showDetails }))}
        aria-expanded={showDetails}
        className="inline-flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-black dark:hover:text-white"
      >
        Details
        <ChevronDown className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
      </button>
    )

    if (compact) {
      return (
        <div className="rounded-2xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 p-5">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {label ? `${label} could not load` : 'This part of the page could not load'}
              </p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                The rest of the app still works — you can carry on or try again.
              </p>
              <div className="mt-3 flex items-center gap-4">
                <Button size="sm" onClick={this.reset} className="bg-black text-white hover:bg-gray-800">
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Try again
                </Button>
                {toggleDetails}
              </div>
              {details}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 p-6">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-red-100 dark:bg-red-900/40 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-red-600 dark:text-red-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Something went wrong
          </h1>
          <p className="text-gray-500 mb-6 text-sm">{error.message || 'An unexpected error occurred.'}</p>
          <div className="flex gap-3 justify-center">
            <Button onClick={() => window.location.reload()} className="bg-black text-white">
              <RefreshCw className="w-4 h-4 mr-2" /> Reload
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                this.reset()
                window.location.href = '/dashboard'
              }}
            >
              Go to Dashboard
            </Button>
          </div>
          <div className="mt-4 flex justify-center">{toggleDetails}</div>
          {details}
        </div>
      </div>
    )
  }
}

import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  colorSchemeLightCold,
  colorSchemeDarkBlue,
  type ColDef,
  type ICellRendererParams,
  type ValueFormatterParams,
} from 'ag-grid-community'
import { Download, Search } from 'lucide-react'
import api from '@/lib/api'
import { KIND_LABEL, type LedgerEvent } from '@/lib/paypal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

ModuleRegistry.registerModules([AllCommunityModule])

interface LedgerTotals {
  captured: number
  paid_out: number
  refunded: number
  held_in_escrow: number
  currency: string
}
interface AdminLedger {
  rail: string
  totals: LedgerTotals
  events: LedgerEvent[]
}

const KIND_TONE: Record<string, string> = {
  order_created: 'bg-gray-100 dark:bg-muted text-gray-700 dark:text-muted-foreground',
  captured: 'bg-blue-100 dark:bg-blue-950/50 text-blue-800 dark:text-blue-400',
  payout_sent: 'bg-green-100 dark:bg-green-950/50 text-green-800 dark:text-green-400',
  refunded: 'bg-purple-100 dark:bg-purple-950/50 text-purple-800 dark:text-purple-400',
  failed: 'bg-red-100 dark:bg-red-950/50 text-red-800 dark:text-red-400',
}

function KindCell({ value }: ICellRendererParams<LedgerEvent, string>) {
  if (!value) return null
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_TONE[value] ?? 'bg-gray-100 dark:bg-muted text-gray-700 dark:text-muted-foreground'}`}>
      {KIND_LABEL[value] ?? value}
    </span>
  )
}

const money = (p: ValueFormatterParams<LedgerEvent, number>) =>
  p.value == null ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency: p.data?.currency || 'USD' }).format(p.value)

const when = (p: ValueFormatterParams<LedgerEvent, string>) =>
  p.value ? new Date(p.value).toLocaleString() : ''

function useIsDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3 dark:border-border dark:bg-card">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-xl font-bold ${tone}`}>{value}</p>
    </div>
  )
}

/**
 * The payments ledger — every PayPal step Gigr has taken, in an AG Grid.
 * `scope="admin"` shows the whole platform with headline totals; `scope="mine"`
 * shows only the jobs the signed-in user is a party to.
 */
export function PaymentsLedger({ scope }: { scope: 'admin' | 'mine' }) {
  const gridRef = useRef<AgGridReact<LedgerEvent>>(null)
  const [quick, setQuick] = useState('')
  const dark = useIsDark()

  const { data, isLoading, isError } = useQuery<AdminLedger>({
    queryKey: ['payments-ledger', scope],
    queryFn: async () => {
      if (scope === 'admin') return (await api.get('/payments/admin/ledger')).data
      const events = (await api.get<LedgerEvent[]>('/payments/mine')).data
      const sum = (k: string) => events.filter((e) => e.kind === k).reduce((a, e) => a + (e.amount ?? 0), 0)
      return {
        rail: 'paypal',
        totals: {
          captured: sum('captured'),
          paid_out: sum('payout_sent'),
          refunded: sum('refunded'),
          held_in_escrow: Math.max(0, sum('captured') - sum('payout_sent') - sum('refunded')),
          currency: 'USD',
        },
        events,
      }
    },
    refetchInterval: 20000,
  })

  const columns = useMemo<ColDef<LedgerEvent>[]>(
    () => [
      { field: 'created_at', headerName: 'When', valueFormatter: when, sort: 'desc', width: 190, filter: 'agDateColumnFilter',
        filterValueGetter: (p) => (p.data?.created_at ? new Date(p.data.created_at) : null) },
      { field: 'kind', headerName: 'Step', cellRenderer: KindCell, width: 170,
        filterValueGetter: (p) => (p.data?.kind ? KIND_LABEL[p.data.kind] ?? p.data.kind : '') },
      { field: 'job_title', headerName: 'Job', flex: 1.4, minWidth: 180 },
      { field: 'amount', headerName: 'Amount', valueFormatter: money, type: 'rightAligned', filter: 'agNumberColumnFilter', width: 130 },
      { field: 'status', headerName: 'PayPal status', width: 160 },
      { field: 'paypal_id', headerName: 'PayPal ID', flex: 1, minWidth: 160, cellClass: 'font-mono text-xs' },
      { field: 'detail', headerName: 'Detail', flex: 1.6, minWidth: 220 },
    ],
    [],
  )

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, filter: true, floatingFilter: false }), [])
  const fmt = (n?: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: data?.totals.currency || 'USD' }).format(n ?? 0)

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (isError || !data) {
    return <p className="text-sm text-red-600 dark:text-red-400">Couldn't load the payments ledger.</p>
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Held in escrow" value={fmt(data.totals.held_in_escrow)} tone="text-blue-700 dark:text-blue-400" />
        <Stat label="Captured" value={fmt(data.totals.captured)} tone="text-gray-900 dark:text-foreground" />
        <Stat label="Paid out" value={fmt(data.totals.paid_out)} tone="text-green-700 dark:text-green-400" />
        <Stat label="Refunded" value={fmt(data.totals.refunded)} tone="text-purple-700 dark:text-purple-400" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            className="pl-8"
            placeholder="Search job, PayPal id, status…"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: 'gigr-payments.csv' })}>
          <Download className="mr-1 h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div style={{ height: 460 }}>
        <AgGridReact<LedgerEvent>
          ref={gridRef}
          theme={themeQuartz.withPart(dark ? colorSchemeDarkBlue : colorSchemeLightCold)}
          rowData={data.events}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          quickFilterText={quick}
          pagination
          paginationPageSize={25}
          animateRows
          getRowId={(p) => p.data.id}
          overlayNoRowsTemplate="No payment activity yet — fund an escrow to see it here."
        />
      </div>
    </div>
  )
}

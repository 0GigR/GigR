import { useEffect, useState } from 'react'
import { Phone, PhoneCall, ShieldAlert, CheckCircle2, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useAgentStore, type CallTriggers } from '@/store/agentStore'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Human-readable labels for each call trigger checkbox. */
const TRIGGER_LABELS: Record<keyof CallTriggers, { title: string; desc: string }> = {
  item_found: {
    title: 'Found an item / provider',
    desc: 'Call me when the AI finds a service or provider matching my request.',
  },
  negotiation_done: {
    title: 'Finished negotiating',
    desc: 'Call me when the AI wraps up a price negotiation on my behalf.',
  },
  job_posted: {
    title: 'Posted a job for me',
    desc: 'Call me when the AI posts a job to the marketplace for me.',
  },
  task_failed: {
    title: 'Task failed',
    desc: 'Call me if the AI could not complete one of my requests.',
  },
}

export default function CallSettingsCard() {
  const { voiceSettings, fetchVoiceSettings, updateVoiceSettings, placeTestCall } = useAgentStore()
  const { fetchUser } = useAuthStore()

  const [phone, setPhone] = useState('')
  const [savingPhone, setSavingPhone] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    fetchVoiceSettings()
  }, [fetchVoiceSettings])

  // Sync the local phone input once settings arrive.
  useEffect(() => {
    if (voiceSettings?.phone_number != null) setPhone(voiceSettings.phone_number)
  }, [voiceSettings?.phone_number])

  const call = voiceSettings?.call
  const configured = voiceSettings?.twilio_configured ?? false
  const hasPhone = !!voiceSettings?.phone_number

  const savePhone = async () => {
    setSavingPhone(true)
    try {
      const res = await updateVoiceSettings({ phone_number: phone.trim() })
      if (res) {
        toast.success('Phone number saved')
        fetchUser() // keep the auth store's user.phone_number in sync
      } else {
        toast.error('Could not save phone number')
      }
    } finally {
      setSavingPhone(false)
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    const res = await updateVoiceSettings({ enabled })
    if (!res) toast.error('Could not update setting')
  }

  const toggleTrigger = async (key: keyof CallTriggers, value: boolean) => {
    const res = await updateVoiceSettings({ triggers: { [key]: value } })
    if (!res) toast.error('Could not update setting')
  }

  const runTestCall = async () => {
    setTesting(true)
    try {
      await placeTestCall()
      toast.success('Calling you now — your phone should ring shortly.')
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Test call failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="bg-white dark:bg-card border border-gray-200 dark:border-border rounded-xl p-5 shadow-sm space-y-5">
      <div className="space-y-1">
        <h3 className="font-semibold text-gray-900 dark:text-foreground flex items-center gap-2">
          <PhoneCall className="w-5 h-5 text-violet-500" />
          Phone Call Alerts
        </h3>
        <p className="text-sm text-gray-500 dark:text-muted-foreground leading-relaxed">
          Let your AI assistant call you when it finishes working in the background — so you
          don’t have to keep the app open.
        </p>
      </div>

      {/* Server not configured notice */}
      {!configured && (
        <div className="flex gap-3 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg text-sm text-amber-800 dark:text-amber-200">
          <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            Calling isn’t switched on for this server yet. You can still save your number and
            preferences — calls will start once an admin configures Twilio.
          </p>
        </div>
      )}

      {/* Phone number */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-700 dark:text-muted-foreground flex items-center gap-2">
          <Phone className="w-4 h-4 text-gray-400" /> Your phone number
        </label>
        <div className="flex gap-2">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+2348012345678"
            inputMode="tel"
            className="flex-1"
          />
          <Button onClick={savePhone} disabled={savingPhone || phone.trim() === (voiceSettings?.phone_number || '')}>
            {savingPhone ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <p className="text-xs text-gray-400">
          Use international format with your country code (e.g. +234 for Nigeria).
        </p>
      </div>

      {/* Master toggle */}
      <div className="flex items-start justify-between border-t border-gray-100 dark:border-border pt-4">
        <div className="space-y-1 pr-4">
          <h4 className="font-medium text-gray-900 dark:text-foreground">Allow the AI to call me</h4>
          <p className="text-sm text-gray-500 dark:text-muted-foreground">
            Master switch for all phone alerts below.
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer mt-1">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={!!call?.enabled}
            disabled={!hasPhone}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-violet-300 dark:peer-focus:ring-violet-800 rounded-full peer dark:bg-secondary peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-border peer-checked:bg-violet-600 peer-disabled:opacity-40" />
        </label>
      </div>
      {!hasPhone && (
        <p className="text-xs text-amber-600 dark:text-amber-400 -mt-2">Add a phone number first to enable calls.</p>
      )}

      {/* Trigger checkboxes */}
      <div className={`space-y-3 transition-opacity ${call?.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <p className="text-sm font-medium text-gray-700 dark:text-muted-foreground">Call me when the AI…</p>
        {(Object.keys(TRIGGER_LABELS) as (keyof CallTriggers)[]).map((key) => (
          <label key={key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 w-4 h-4 accent-violet-600 rounded"
              checked={!!call?.triggers?.[key]}
              onChange={(e) => toggleTrigger(key, e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-gray-900 dark:text-foreground">
                {TRIGGER_LABELS[key].title}
              </span>
              <span className="block text-xs text-gray-500 dark:text-muted-foreground">{TRIGGER_LABELS[key].desc}</span>
            </span>
          </label>
        ))}
      </div>

      {/* Save-to-contacts hint + test call */}
      {configured && voiceSettings?.from_number && (
        <div className="flex gap-3 p-3 bg-violet-50 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900/50 rounded-lg text-sm text-violet-800 dark:text-violet-200">
          <Info className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            Our calls come from <strong>{voiceSettings.from_number}</strong>. Save it as
            “Gigr AI” so you recognise us and it doesn’t look like spam.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-gray-100 dark:border-border pt-4">
        <Button variant="outline" onClick={runTestCall} disabled={!configured || !hasPhone || testing}>
          <PhoneCall className="w-4 h-4 mr-2" />
          {testing ? 'Calling…' : 'Send me a test call'}
        </Button>
        {call?.enabled && hasPhone && (
          <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" /> Phone alerts active
          </span>
        )}
      </div>
    </div>
  )
}

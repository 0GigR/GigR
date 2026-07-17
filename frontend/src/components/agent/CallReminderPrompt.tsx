import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { PhoneCall, X } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'

/**
 * A one-time, dismissible nudge inviting the user to let the AI call them when
 * it finishes a background task. Appears only when server-side calling is
 * available but the user hasn't set it up (and hasn't dismissed the reminder).
 * "Dismiss" persists to the backend (ai_settings.call.reminderDismissed) so it
 * won't nag across devices.
 */
export default function CallReminderPrompt() {
  const { user } = useAuthStore()
  const { voiceSettings, fetchVoiceSettings, updateVoiceSettings } = useAgentStore()
  const navigate = useNavigate()
  const [dismissing, setDismissing] = useState(false)

  useEffect(() => {
    if (user && voiceSettings === null) fetchVoiceSettings()
  }, [user, voiceSettings, fetchVoiceSettings])

  const call = voiceSettings?.call
  const configured = voiceSettings?.twilio_configured ?? false
  const alreadySetUp = !!call?.enabled && !!voiceSettings?.phone_number

  const shouldShow =
    !!user &&
    (user.ai_enabled ?? true) &&
    configured &&
    !!call &&
    !call.reminderDismissed &&
    !alreadySetUp &&
    !dismissing

  const dismiss = async () => {
    setDismissing(true)
    await updateVoiceSettings({ reminderDismissed: true })
  }

  const setUp = () => {
    dismiss()
    navigate('/dashboard/ai-settings')
  }

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
          className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 z-50 sm:max-w-sm"
        >
          <div className="relative bg-white dark:bg-gray-900 border border-violet-200 dark:border-violet-900/60 rounded-2xl shadow-xl p-4 pr-9">
            <button
              onClick={dismiss}
              className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex gap-3">
              <div className="shrink-0 w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
                <PhoneCall className="w-5 h-5 text-violet-600 dark:text-violet-300" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Want a call when I’m done?
                </p>
                <p className="text-sm text-gray-500 leading-snug">
                  Let your AI assistant phone you once it finishes processing — finds an item,
                  wraps up a negotiation, and more.
                </p>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={setUp}>Set it up</Button>
                  <Button size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

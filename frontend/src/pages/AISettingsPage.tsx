import { useEffect, useState } from 'react'
import { CheckCircle2, ShieldAlert, Bot, Mic, Trash2, Settings2, Info } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import CallSettingsCard from '@/components/agent/CallSettingsCard'
import MemoryCards from '@/components/agent/MemoryCards'
import { agentAudio } from '@/lib/agentAudio'
import { cn } from '@/lib/utils'

// Mirrors the backend guardrails in app/services/agent_policy.py — shown so the
// limits the server actually enforces are visible, not implied.
const AUTONOMY_LIMITS: Record<string, { actions: number; applies: number }> = {
  off: { actions: 0, applies: 0 },
  low: { actions: 20, applies: 0 },
  medium: { actions: 30, applies: 0 },
  high: { actions: 40, applies: 10 },
  total: { actions: 60, applies: 20 },
}

export default function AISettingsPage() {
  const { aiSettings, updateAISetting, engineInfo, fetchEngineInfo, clearHistory } = useAgentStore()
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const limits = AUTONOMY_LIMITS[aiSettings.autonomyLevel] ?? AUTONOMY_LIMITS.off

  useEffect(() => {
    fetchEngineInfo()
  }, [fetchEngineInfo])

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Bot className="w-8 h-8 text-violet-600 dark:text-violet-400" />
          AI Agent Settings
        </h1>
        <p className="text-gray-500 dark:text-muted-foreground mt-2 text-sm">
          Customize how your background AI agent behaves and handles your tasks.
        </p>
      </div>

      {/* Engine Status Card */}
      <div className="bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-950/30 dark:to-indigo-950/30 border border-violet-100 dark:border-violet-900/50 rounded-2xl p-6">
        <h2 className="text-lg font-semibold flex items-center gap-2 text-violet-900 dark:text-violet-100 mb-4">
          <Settings2 className="w-5 h-5" />
          AI Engine Status
        </h2>
        
        {engineInfo ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">Agent Status</span>
              <span className={`px-2 py-1 rounded-full text-xs font-semibold ${engineInfo.agent_enabled ? 'bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400'}`}>
                {engineInfo.agent_enabled ? 'Active' : 'Disabled globally'}
              </span>
            </div>
            
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">NLP Engine</span>
              <div className="flex items-center gap-2">
                {engineInfo.nlp_engine === 'groq' ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    <span className="text-sm font-semibold text-green-700 dark:text-green-400">Groq LLM ({engineInfo.groq_model})</span>
                  </>
                ) : (
                  <>
                    <Info className="w-4 h-4 text-blue-500" />
                    <span className="text-sm font-semibold text-blue-700 dark:text-blue-400">Rule-based Fallback</span>
                  </>
                )}
              </div>
            </div>
            
            {engineInfo.nlp_engine !== 'groq' && (
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-sm text-blue-800 dark:text-blue-200 border border-blue-100 dark:border-blue-800">
                <p><strong>Want smarter AI?</strong> The system is currently using the free rule-based fallback. For true natural language understanding, add a free Groq API key to your backend configuration.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-gray-500 dark:text-muted-foreground">Loading engine info...</div>
        )}
      </div>

      <div className="space-y-6">
        {/* Autonomy Level */}
        <div className="bg-white dark:bg-card border border-gray-200 dark:border-border rounded-xl p-5 shadow-sm space-y-4">
          <div className="space-y-1">
            <h3 className="font-semibold text-gray-900 dark:text-foreground flex items-center gap-2">
              <Bot className="w-5 h-5 text-violet-500" />
              Agent Autonomy Level
            </h3>
            <p className="text-sm text-gray-500 dark:text-muted-foreground leading-relaxed">
              Set how much control the AI has to act on your behalf in the background. 
              <strong> Higher levels allow the AI to make legally binding agreements and spend funds.</strong>
            </p>
          </div>

          <div className="pt-4">
            <select
              value={aiSettings.autonomyLevel}
              onChange={(e) => updateAISetting('autonomyLevel', e.target.value as any)}
              className="w-full p-3 bg-gray-50 dark:bg-muted border border-gray-200 dark:border-border rounded-lg text-gray-900 dark:text-foreground focus:ring-2 focus:ring-violet-500"
            >
              <option value="off">Off - No background autonomy</option>
              <option value="low">Low - Auto-reply to messages only</option>
              <option value="medium">Medium - Auto-reply & negotiate prices</option>
              <option value="high">High - Medium + Auto-apply to matching jobs</option>
              <option value="total">Total Control (Beast Mode) - Full proactive hunting</option>
            </select>
          </div>

          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg p-4 mt-4">
            <div className="flex gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800 dark:text-amber-200 space-y-1">
                <p className="font-semibold">Current Level Capabilities:</p>
                <ul className="list-disc pl-4 space-y-1">
                  {aiSettings.autonomyLevel === 'off' && <li>The agent will only act when you explicitly command it via the chat panel.</li>}
                  {aiSettings.autonomyLevel === 'low' && <li>Automatically drafts and sends replies to incoming messages.</li>}
                  {aiSettings.autonomyLevel === 'medium' && (
                    <>
                      <li>Automatically drafts and sends replies to incoming messages.</li>
                      <li>Negotiates on your behalf to match budgets if needed.</li>
                    </>
                  )}
                  {aiSettings.autonomyLevel === 'high' && (
                    <>
                      <li>Auto-replies and negotiates budgets.</li>
                      <li>Automatically evaluates new jobs and applies to them on your behalf while you sleep.</li>
                    </>
                  )}
                  {aiSettings.autonomyLevel === 'total' && (
                    <>
                      <li>Fully autonomous negotiation and job applications.</li>
                      <li>Hunts for providers matching your open jobs and lines them up for a one-tap request — it never messages a provider without you tapping request.</li>
                      <li><strong>Note:</strong> Funding escrow always stays a manual confirmation, at every level.</li>
                    </>
                  )}
                </ul>
                <p className="pt-1.5 text-xs font-medium border-t border-amber-200 dark:border-amber-900/50">
                  {limits.actions > 0
                    ? `Daily guardrails: up to ${limits.actions} autonomous actions${
                        limits.applies > 0 ? ` and ${limits.applies} automatic applications` : ''
                      }. Enforced by the server.`
                    : 'No autonomous actions — the agent only acts when you command it.'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Phone Call Alerts */}
        <CallSettingsCard />

        {/* Learned Agent Memory */}
        <MemoryCards />

        {/* Toggle: Voice Button */}
        <div className="flex items-start justify-between bg-white dark:bg-card border border-gray-200 dark:border-border rounded-xl p-5 shadow-sm">
          <div className="space-y-1">
            <h3 className="font-semibold text-gray-900 dark:text-foreground flex items-center gap-2">
              <Mic className="w-4 h-4 text-gray-500 dark:text-muted-foreground" />
              Floating Voice Assistant Button
            </h3>
            <p className="text-sm text-gray-500 dark:text-muted-foreground leading-relaxed">
              Show the microphone button on all dashboard pages for quick access.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer mt-1">
            <input 
              type="checkbox" 
              className="sr-only peer" 
              checked={aiSettings.voiceEnabled}
              onChange={(e) => updateAISetting('voiceEnabled', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-secondary peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-border peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {/* Sound Design Card */}
        <div className="flex items-start justify-between bg-white dark:bg-card border border-gray-200 dark:border-border rounded-xl p-5 shadow-sm">
          <div className="space-y-1">
            <h3 className="font-semibold text-gray-900 dark:text-foreground flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-gray-700 dark:text-muted-foreground" />
              Sound Design
            </h3>
            <p className="text-sm text-gray-500 dark:text-muted-foreground leading-relaxed">
              Synthetic audio feedback synthesised in-browser via Web Audio API. Radar pings, task completion chimes, and sonar pulses.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const nextState = !aiSettings.soundEnabled
              updateAISetting('soundEnabled', nextState)
              agentAudio.setEnabled(nextState)
              if (nextState) agentAudio.playRadarPing()
            }}
            className={cn(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 mt-1',
              aiSettings.soundEnabled ? 'bg-black dark:bg-white' : 'bg-gray-200 dark:bg-secondary',
            )}
            aria-pressed={aiSettings.soundEnabled}
            aria-label="Toggle agent sound effects"
          >
            <span
              className={cn(
                'inline-block h-4 w-4 transform rounded-full shadow transition-transform',
                aiSettings.soundEnabled ? 'translate-x-6 bg-white dark:bg-black' : 'translate-x-1 bg-white dark:bg-card',
              )}
            />
          </button>
        </div>

        {/* Danger Zone */}
        <div className="pt-6 mt-8 border-t border-gray-200 dark:border-border">
          <h3 className="font-semibold text-red-600 dark:text-red-400 mb-4 flex items-center gap-2">
            <Trash2 className="w-5 h-5" />
            Danger Zone
          </h3>
          <div className="bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/50 rounded-xl p-5 flex items-center justify-between">
            <div>
              <h4 className="font-medium text-red-900 dark:text-red-200">Clear all agent history</h4>
              <p className="text-sm text-red-700 dark:text-red-400 mt-1">
                Cancels all running tasks and clears your activity log permanently.
              </p>
            </div>
            <Button 
              variant="destructive"
              onClick={() => setShowClearConfirm(true)}
            >
              Clear History
            </Button>
          </div>
        </div>
      </div>
      
      <ConfirmDialog
        open={showClearConfirm}
        onOpenChange={setShowClearConfirm}
        title="Clear History?"
        description="Are you sure you want to clear your AI agent history? This will cancel running tasks and clear all logs."
        confirmLabel="Clear History"
        onConfirm={async () => {
          await clearHistory()
          setShowClearConfirm(false)
        }}
      />
    </div>
  )
}

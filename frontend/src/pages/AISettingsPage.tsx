import { useEffect } from 'react'
import { CheckCircle2, ShieldAlert, Bot, Mic, Trash2, Settings2, Info } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { Button } from '@/components/ui/button'

export default function AISettingsPage() {
  const { aiSettings, updateAISetting, engineInfo, fetchEngineInfo, clearHistory } = useAgentStore()

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
        <p className="text-gray-500 mt-2 text-sm">
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
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Agent Status</span>
              <span className={`px-2 py-1 rounded-full text-xs font-semibold ${engineInfo.agent_enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {engineInfo.agent_enabled ? 'Active' : 'Disabled globally'}
              </span>
            </div>
            
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">NLP Engine</span>
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
          <div className="text-sm text-gray-500">Loading engine info...</div>
        )}
      </div>

      <div className="space-y-6">
        {/* Toggle: Negotiation */}
        <div className="flex items-start justify-between bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="space-y-1 max-w-[80%]">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              Allow AI to negotiate on my behalf
              {aiSettings.aiNegotiateEnabled && <ShieldAlert className="w-4 h-4 text-amber-500" />}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed">
              If the agent can't find a service within your budget, it will automatically send a real message to the closest-priced providers asking if they can match your budget.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer mt-1">
            <input 
              type="checkbox" 
              className="sr-only peer" 
              checked={aiSettings.aiNegotiateEnabled}
              onChange={(e) => updateAISetting('aiNegotiateEnabled', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-violet-300 dark:peer-focus:ring-violet-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-violet-600"></div>
          </label>
        </div>
        
        {/* Toggle: Auto-Reply */}
        <div className="flex items-start justify-between bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="space-y-1 max-w-[80%]">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              Allow AI to auto-reply to my messages
              {aiSettings.aiAutoReplyEnabled && <Bot className="w-4 h-4 text-violet-500" />}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed">
              When someone messages you about a job or service, the AI assistant will automatically draft and send a reply on your behalf.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer mt-1">
            <input 
              type="checkbox" 
              className="sr-only peer" 
              checked={aiSettings.aiAutoReplyEnabled}
              onChange={(e) => updateAISetting('aiAutoReplyEnabled', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-violet-300 dark:peer-focus:ring-violet-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-violet-600"></div>
          </label>
        </div>

        {/* Toggle: Voice Button */}
        <div className="flex items-start justify-between bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 shadow-sm">
          <div className="space-y-1">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Mic className="w-4 h-4 text-gray-500" />
              Floating Voice Assistant Button
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed">
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
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {/* Danger Zone */}
        <div className="pt-6 mt-8 border-t border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-red-600 mb-4 flex items-center gap-2">
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
              onClick={async () => {
                if (window.confirm("Are you sure? This will cancel running tasks and clear all logs.")) {
                  await clearHistory()
                }
              }}
            >
              Clear History
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

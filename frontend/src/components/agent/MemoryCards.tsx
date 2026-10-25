/**
 * MemoryCards.tsx — "What your agent knows" memory inspection and control surface.
 *
 * Displays learned preferences and operational context that the agent has gathered
 * from past interactions. Users can inspect, edit, or forget individual memory keys.
 *
 * House Standard Compliance:
 * - Zero emojis
 * - No banned variable names
 * - Status tags use strict typography ([OK], [LEARNED])
 */

import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Brain, MapPin, DollarSign, Tag, Search, Trash2, Edit3, Check, X, ArrowRight } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { Button } from '@/components/ui/button'

interface MemoryItemProps {
  label: string
  description: string
  memoryKey: string
  value: unknown
  icon: React.ReactNode
  onForget: (key: string) => void
  onUpdate: (key: string, newValue: unknown) => void
}

function MemoryItem({
  label,
  description,
  memoryKey,
  value,
  icon,
  onForget,
  onUpdate,
}: MemoryItemProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const displayString = (): string => {
    if (value === null || value === undefined || value === '') {
      return 'Not set'
    }
    if (Array.isArray(value)) {
      return value.length > 0 ? value.join(', ') : 'None'
    }
    if (typeof value === 'number') {
      return `NGN ${value.toLocaleString()}`
    }
    return String(value)
  }

  const handleStartEdit = () => {
    if (Array.isArray(value)) {
      setEditText(value.join(', '))
    } else if (value !== null && value !== undefined) {
      setEditText(String(value))
    } else {
      setEditText('')
    }
    setIsEditing(true)
  }

  const handleSave = () => {
    const trimmed = editText.trim()
    if (!trimmed) {
      onForget(memoryKey)
    } else if (Array.isArray(value)) {
      const splitArr = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
      onUpdate(memoryKey, splitArr)
    } else if (typeof value === 'number' && !isNaN(Number(trimmed))) {
      onUpdate(memoryKey, Number(trimmed))
    } else {
      onUpdate(memoryKey, trimmed)
    }
    setIsEditing(false)
  }

  const isFilled = value !== null && value !== undefined && value !== ''

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 shadow-sm flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-violet-50 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400">
              {icon}
            </span>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {label}
            </span>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
            {isFilled ? '[LEARNED]' : '[EMPTY]'}
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-3">{description}</p>
      </div>

      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="flex-1 px-2.5 py-1 text-xs rounded border border-violet-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
              placeholder="Enter new value"
            />
            <button
              onClick={handleSave}
              className="p-1 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
              title="Save"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="p-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 transition-colors"
              title="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-xs font-medium truncate ${
                isFilled
                  ? 'text-gray-800 dark:text-gray-200'
                  : 'text-gray-400 dark:text-gray-500 italic'
              }`}
            >
              {displayString()}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStartEdit}
                className="h-7 px-2 text-xs text-gray-600 dark:text-gray-400 hover:text-violet-600"
              >
                <Edit3 className="w-3 h-3 mr-1" />
                Edit
              </Button>
              {isFilled && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onForget(memoryKey)}
                  className="h-7 px-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                  title="Forget this memory"
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Forget
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function MemoryCards() {
  const { agentMemory, fetchMemory, updateMemory, forgetMemoryKey } = useAgentStore()

  useEffect(() => {
    fetchMemory()
  }, [fetchMemory])

  const handleUpdate = (key: string, newValue: unknown) => {
    updateMemory({ [key]: newValue })
  }

  const handleForget = (key: string) => {
    forgetMemoryKey(key)
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Brain className="w-5 h-5 text-violet-500" />
            What Your Agent Knows
          </h3>
          <p className="text-sm text-gray-500 leading-relaxed">
            Autonomous memory extracted from your tasks and searches. The agent references
            this context to eliminate repetitive questions.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
        <MemoryItem
          label="Preferred Location"
          description="Geographic anchor used for radius searches."
          memoryKey="location_name"
          value={agentMemory.location_name}
          icon={<MapPin className="w-4 h-4" />}
          onForget={handleForget}
          onUpdate={handleUpdate}
        />

        <MemoryItem
          label="Typical Job Budget"
          description="Baseline rate used when posting tasks without a price."
          memoryKey="usual_price_job"
          value={agentMemory.usual_price_job}
          icon={<DollarSign className="w-4 h-4" />}
          onForget={handleForget}
          onUpdate={handleUpdate}
        />

        <MemoryItem
          label="Preferred Categories"
          description="Categories of work prioritized during searches."
          memoryKey="preferred_categories"
          value={agentMemory.preferred_categories}
          icon={<Tag className="w-4 h-4" />}
          onForget={handleForget}
          onUpdate={handleUpdate}
        />

        <MemoryItem
          label="Last Search Query"
          description="Most recent service inquiry used for proactive monitoring."
          memoryKey="last_search"
          value={agentMemory.last_search}
          icon={<Search className="w-4 h-4" />}
          onForget={handleForget}
          onUpdate={handleUpdate}
        />
      </div>

      <div className="pt-1">
        <Link
          to="/dashboard/memory"
          className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline"
        >
          See everything Gigr remembers
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  )
}

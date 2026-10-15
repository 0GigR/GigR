/**
 * featureFlags.ts — Typed client-side feature flag evaluation.
 *
 * All flags default to enabled (open) unless explicitly disabled in Vite env.
 * In future iterations, premium features can be conditionally gated by
 * evaluating the user's subscription tier or backend-driven permissions.
 */

export interface AgentFeatureFlags {
  multiTurn: boolean
  reasoningVisible: boolean
  mapResults: boolean
  proactiveSurface: boolean
  streaming: boolean
  smartApply: boolean
  planner: boolean
  commandPalette: boolean
  premiumGate: boolean
}

function parseEnvBoolean(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val === '') return defaultValue
  const lower = val.toLowerCase().trim()
  return lower === 'true' || lower === '1' || lower === 'yes'
}

export const agentFeatures: AgentFeatureFlags = {
  multiTurn: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_MULTI_TURN, true),
  reasoningVisible: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_REASONING_VISIBLE, true),
  mapResults: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_MAP_RESULTS, true),
  proactiveSurface: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_PROACTIVE_SURFACE, true),
  streaming: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_STREAMING, false),
  smartApply: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_SMART_APPLY, false),
  planner: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_PLANNER, false),
  commandPalette: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_COMMAND_PALETTE, true),
  premiumGate: parseEnvBoolean(import.meta.env.VITE_FEATURE_AGENT_PREMIUM, false),
}

export function isFeatureEnabled(flag: keyof AgentFeatureFlags): boolean {
  return agentFeatures[flag]
}

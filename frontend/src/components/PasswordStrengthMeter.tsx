/**
 * PasswordStrengthMeter.tsx — Real-time password strength indicator and requirement checklist.
 *
 * Checks:
 *  - Length (8+ characters)
 *  - Mixed case (uppercase and lowercase)
 *  - Numbers (0-9)
 *  - Special characters (!@#$%...)
 *
 * Strict house standards: typography only, no emojis.
 */

import { useMemo } from 'react'
import { Check, X } from 'lucide-react'

interface PasswordStrengthMeterProps {
  password: string
  confirmPassword?: string
  showConfirmMatch?: boolean
}

interface StrengthCriteria {
  label: string
  met: boolean
}

export function computePasswordScore(password: string): {
  score: number
  label: string
  color: string
  barColor: string
  criteria: StrengthCriteria[]
} {
  const criteria: StrengthCriteria[] = [
    { label: 'At least 8 characters', met: password.length >= 8 },
    { label: 'Uppercase & lowercase letters', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { label: 'At least one number', met: /\d/.test(password) },
    { label: 'Special character (!@#$...)', met: /[^A-Za-z0-9]/.test(password) },
  ]

  const passedCount = criteria.filter((c) => c.met).length

  if (!password) {
    return { score: 0, label: '', color: 'text-gray-400', barColor: 'bg-gray-200 dark:bg-secondary', criteria }
  }

  if (password.length < 6) {
    return { score: 1, label: 'Too short', color: 'text-red-500', barColor: 'bg-red-500', criteria }
  }

  if (passedCount <= 1) {
    return { score: 1, label: 'Weak', color: 'text-red-500', barColor: 'bg-red-500', criteria }
  }
  if (passedCount === 2) {
    return { score: 2, label: 'Fair', color: 'text-amber-500', barColor: 'bg-amber-500', criteria }
  }
  if (passedCount === 3) {
    return { score: 3, label: 'Good', color: 'text-blue-500', barColor: 'bg-blue-500', criteria }
  }
  return { score: 4, label: 'Strong', color: 'text-emerald-500', barColor: 'bg-emerald-500', criteria }
}

export default function PasswordStrengthMeter({
  password,
  confirmPassword,
  showConfirmMatch = true,
}: PasswordStrengthMeterProps) {
  const { score, label, color, barColor, criteria } = useMemo(
    () => computePasswordScore(password),
    [password],
  )

  const isMatching = confirmPassword !== undefined && confirmPassword.length > 0 && password === confirmPassword
  const isMismatch = confirmPassword !== undefined && confirmPassword.length > 0 && password !== confirmPassword

  if (!password && !confirmPassword) {
    return null
  }

  return (
    <div className="space-y-2 pt-1 text-xs">
      {password && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-gray-500 dark:text-muted-foreground font-medium">Password strength</span>
            <span className={`font-semibold ${color}`}>{label}</span>
          </div>

          {/* 4-segment strength bar */}
          <div className="grid grid-cols-4 gap-1.5 h-1.5">
            {[1, 2, 3, 4].map((step) => {
              const active = score >= step
              return (
                <div
                  key={step}
                  className={`h-full rounded-full transition-colors duration-300 ${
                    active ? barColor : 'bg-gray-200 dark:bg-secondary'
                  }`}
                />
              )
            })}
          </div>

          {/* Requirement checklist */}
          <div className="grid grid-cols-2 gap-1 pt-1 text-[11px] text-gray-500 dark:text-muted-foreground">
            {criteria.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5">
                {item.met ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <X className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                )}
                <span className={item.met ? 'text-gray-700 dark:text-muted-foreground font-medium' : 'text-gray-400'}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Password match indicator */}
      {showConfirmMatch && confirmPassword !== undefined && confirmPassword.length > 0 && (
        <div className="pt-1">
          {isMatching && (
            <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              <Check className="w-3.5 h-3.5 text-emerald-500" /> Passwords match
            </p>
          )}
          {isMismatch && (
            <p className="flex items-center gap-1.5 text-[11px] text-red-500 font-medium">
              <X className="w-3.5 h-3.5 text-red-500" /> Passwords do not match
            </p>
          )}
        </div>
      )}
    </div>
  )
}

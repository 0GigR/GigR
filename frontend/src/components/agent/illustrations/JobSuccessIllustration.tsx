/**
 * JobSuccessIllustration.tsx — Autonomous agent task success vector illustration.
 *
 * Vector shield with holographic verification badges and animated energy pulse.
 */

import React from 'react'

interface JobSuccessIllustrationProps {
  className?: string
}

export default function JobSuccessIllustration({
  className = 'w-32 h-32',
}: JobSuccessIllustrationProps): React.ReactElement {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <style>{`
        @keyframes shield-pulse {
          0%, 100% { transform: scale(1); filter: drop-shadow(0 0 6px rgba(16,185,129,0.3)); }
          50% { transform: scale(1.04); filter: drop-shadow(0 0 12px rgba(16,185,129,0.6)); }
        }
        @keyframes ring-expand {
          0% { transform: scale(0.9); opacity: 0.6; }
          100% { transform: scale(1.15); opacity: 0; }
        }
        .anim-shield-pulse {
          animation: shield-pulse 3s ease-in-out infinite;
          transform-origin: center;
        }
        .anim-ring-expand {
          animation: ring-expand 2.4s cubic-bezier(0.16, 1, 0.3, 1) infinite;
          transform-origin: center;
        }
      `}</style>

      <svg
        viewBox="0 0 160 160"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        <defs>
          <linearGradient id="shield-grad" x1="40" y1="25" x2="120" y2="135" gradientUnits="userSpaceOnUse">
            <stop stopColor="#059669" />
            <stop offset="1" stopColor="#064e3b" />
          </linearGradient>
          <linearGradient id="ring-glow-grad" x1="80" y1="20" x2="80" y2="140" gradientUnits="userSpaceOnUse">
            <stop stopColor="#10b981" stopOpacity="0.5" />
            <stop offset="1" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Pulsing Aura Rings */}
        <circle cx="80" cy="80" r="64" stroke="url(#ring-glow-grad)" strokeWidth="1.5" className="anim-ring-expand" />
        <circle cx="80" cy="80" r="52" stroke="#047857" strokeWidth="1" strokeDasharray="4 4" opacity="0.4" />

        {/* Central Geometric Shield */}
        <g className="anim-shield-pulse">
          <path
            d="M 80 32 L 122 50 C 122 88 102 118 80 132 C 58 118 38 88 38 50 Z"
            fill="url(#shield-grad)"
            stroke="#34d399"
            strokeWidth="2"
          />

          {/* Inner Highlight Geometry */}
          <path
            d="M 80 42 L 112 56 C 112 86 96 110 80 120 C 64 110 48 86 48 56 Z"
            stroke="#6ee7b7"
            strokeWidth="1"
            strokeOpacity="0.4"
            fill="none"
          />

          {/* Sharp Vector Check Mark */}
          <path
            d="M 64 80 L 76 92 L 98 68"
            stroke="#ffffff"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Floating Verification Sparks */}
          <circle cx="126" cy="46" r="2.5" fill="#34d399" />
          <circle cx="34" cy="98" r="2" fill="#6ee7b7" />
        </g>
      </svg>
    </div>
  )
}

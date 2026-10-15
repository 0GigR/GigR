/**
 * BrokenCircuitIllustration.tsx — Autonomous agent task failure vector illustration.
 *
 * Geometric circuit trace with disrupted connection nodes and subtle pulsing spark.
 */

import React from 'react'

interface BrokenCircuitIllustrationProps {
  className?: string
}

export default function BrokenCircuitIllustration({
  className = 'w-32 h-32',
}: BrokenCircuitIllustrationProps): React.ReactElement {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <style>{`
        @keyframes spark-flicker {
          0%, 100% { opacity: 0.3; transform: scale(0.9); }
          50% { opacity: 0.9; transform: scale(1.1); filter: drop-shadow(0 0 5px #f43f5e); }
        }
        .anim-spark-flicker {
          animation: spark-flicker 2s ease-in-out infinite;
          transform-origin: 80px 80px;
        }
      `}</style>

      <svg
        viewBox="0 0 160 160"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        <defs>
          <linearGradient id="fail-bg-grad" x1="20" y1="20" x2="140" y2="140" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1e1b2e" />
            <stop offset="1" stopColor="#0f0e17" />
          </linearGradient>
          <linearGradient id="trace-grad" x1="30" y1="80" x2="130" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="#475569" />
            <stop offset="0.5" stopColor="#f43f5e" />
            <stop offset="1" stopColor="#475569" />
          </linearGradient>
        </defs>

        {/* Backdrop Panel */}
        <rect x="24" y="24" width="112" height="112" rx="20" fill="url(#fail-bg-grad)" stroke="#334155" strokeWidth="1.5" />

        {/* Printed Circuit Board Traces */}
        <path d="M 38 48 L 68 48 L 78 68" stroke="#475569" strokeWidth="2" strokeLinecap="round" />
        <circle cx="38" cy="48" r="3.5" fill="#64748b" />

        <path d="M 122 112 L 92 112 L 82 92" stroke="#475569" strokeWidth="2" strokeLinecap="round" />
        <circle cx="122" cy="112" r="3.5" fill="#64748b" />

        {/* Broken Terminal Bridge */}
        <line x1="48" y1="80" x2="70" y2="80" stroke="url(#trace-grad)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="70" cy="80" r="4" fill="#fb7185" />

        <line x1="90" y1="80" x2="112" y2="80" stroke="url(#trace-grad)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="90" cy="80" r="4" fill="#fb7185" />

        {/* Central Interrupted Gap Spark */}
        <g className="anim-spark-flicker">
          <circle cx="80" cy="80" r="8" fill="#f43f5e" fillOpacity="0.2" />
          <path d="M 76 74 L 83 79 L 77 82 L 84 86" stroke="#fda4af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>

        {/* Inactive Subnodes */}
        <circle cx="112" cy="52" r="3" fill="#334155" />
        <path d="M 112 52 L 96 68" stroke="#334155" strokeWidth="1.5" strokeDasharray="3 3" />

        <circle cx="48" cy="108" r="3" fill="#334155" />
        <path d="M 48 108 L 64 92" stroke="#334155" strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
    </div>
  )
}

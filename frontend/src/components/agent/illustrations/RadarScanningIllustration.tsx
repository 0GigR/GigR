/**
 * RadarScanningIllustration.tsx — Autonomous agent radar search illustration.
 *
 * Vector radar display with sweeping beam, range rings, and target blips.
 */

import React from 'react'

interface RadarScanningIllustrationProps {
  className?: string
}

export default function RadarScanningIllustration({
  className = 'w-32 h-32',
}: RadarScanningIllustrationProps): React.ReactElement {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <style>{`
        @keyframes radar-sweep {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes target-ping {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.2); filter: drop-shadow(0 0 6px #10b981); }
        }
        .anim-radar-sweep {
          animation: radar-sweep 3s linear infinite;
          transform-origin: 80px 80px;
        }
        .anim-target-ping {
          animation: target-ping 1.8s ease-in-out infinite;
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
          <radialGradient id="radar-bg" cx="80" cy="80" r="70" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0f172a" />
            <stop offset="1" stopColor="#020617" />
          </radialGradient>
          <linearGradient id="sweep-beam" x1="80" y1="80" x2="150" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="#10b981" stopOpacity="0.8" />
            <stop offset="1" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Outer Circular Housing */}
        <circle cx="80" cy="80" r="70" fill="url(#radar-bg)" stroke="#1e293b" strokeWidth="2" />

        {/* Concentric Range Rings */}
        <circle cx="80" cy="80" r="54" stroke="#334155" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        <circle cx="80" cy="80" r="38" stroke="#334155" strokeWidth="1" opacity="0.6" />
        <circle cx="80" cy="80" r="22" stroke="#334155" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />

        {/* Crosshair Axes */}
        <line x1="80" y1="12" x2="80" y2="148" stroke="#1e293b" strokeWidth="1.2" />
        <line x1="12" y1="80" x2="148" y2="80" stroke="#1e293b" strokeWidth="1.2" />

        {/* Rotating Scanner Wedge */}
        <g className="anim-radar-sweep">
          <path
            d="M 80 80 L 150 80 A 70 70 0 0 1 129 129 Z"
            fill="url(#sweep-beam)"
            opacity="0.25"
          />
          <line x1="80" y1="80" x2="150" y2="80" stroke="#34d399" strokeWidth="2" strokeLinecap="round" />
        </g>

        {/* Target Blips */}
        <g className="anim-target-ping">
          <circle cx="108" cy="54" r="3.5" fill="#10b981" />
          <circle cx="108" cy="54" r="6" stroke="#10b981" strokeWidth="0.8" opacity="0.5" />
        </g>

        <g className="anim-target-ping" style={{ animationDelay: '0.8s' }}>
          <circle cx="58" cy="106" r="3" fill="#38bdf8" />
          <circle cx="58" cy="106" r="5.5" stroke="#38bdf8" strokeWidth="0.8" opacity="0.5" />
        </g>

        {/* Center Origin Beacon */}
        <circle cx="80" cy="80" r="3" fill="#a78bfa" />
        <circle cx="80" cy="80" r="7" stroke="#a78bfa" strokeWidth="1" opacity="0.7" />
      </svg>
    </div>
  )
}

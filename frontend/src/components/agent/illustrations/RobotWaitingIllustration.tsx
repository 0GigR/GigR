/**
 * RobotWaitingIllustration.tsx — Autonomous Agent waiting state vector illustration.
 *
 * Crafted using pure vector geometry with holographic glow gradients
 * and inline CSS keyframe animations.
 */

import React from 'react'

interface RobotWaitingIllustrationProps {
  className?: string
}

export default function RobotWaitingIllustration({
  className = 'w-36 h-36',
}: RobotWaitingIllustrationProps): React.ReactElement {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <style>{`
        @keyframes agent-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-6px); }
        }
        @keyframes visor-glow {
          0%, 100% { opacity: 0.85; filter: drop-shadow(0 0 4px #a78bfa); }
          50% { opacity: 1; filter: drop-shadow(0 0 8px #c4b5fd); }
        }
        @keyframes pulse-ring {
          0% { transform: scale(0.95); opacity: 0.4; }
          50% { transform: scale(1.05); opacity: 0.8; }
          100% { transform: scale(0.95); opacity: 0.4; }
        }
        .anim-agent-float { animation: agent-float 3.6s ease-in-out infinite; }
        .anim-visor-glow { animation: visor-glow 2.4s ease-in-out infinite; }
        .anim-pulse-ring { animation: pulse-ring 3s ease-in-out infinite; transform-origin: center; }
      `}</style>

      <svg
        viewBox="0 0 160 160"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        <defs>
          <linearGradient id="robot-body-grad" x1="40" y1="30" x2="120" y2="120" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#4338ca" />
          </linearGradient>
          <linearGradient id="robot-visor-grad" x1="55" y1="52" x2="105" y2="76" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0f172a" />
            <stop offset="1" stopColor="#020617" />
          </linearGradient>
          <linearGradient id="pedestal-grad" x1="30" y1="135" x2="130" y2="135" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8b5cf6" stopOpacity="0.05" />
            <stop offset="0.5" stopColor="#8b5cf6" stopOpacity="0.35" />
            <stop offset="1" stopColor="#8b5cf6" stopOpacity="0.05" />
          </linearGradient>
          <radialGradient id="emitter-glow" cx="80" cy="135" r="45" gradientUnits="userSpaceOnUse">
            <stop stopColor="#a78bfa" stopOpacity="0.4" />
            <stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Hologram Pedestal Base */}
        <ellipse cx="80" cy="136" rx="46" ry="12" fill="url(#emitter-glow)" />
        <ellipse cx="80" cy="136" rx="38" ry="8" stroke="url(#pedestal-grad)" strokeWidth="1.5" className="anim-pulse-ring" />
        <ellipse cx="80" cy="136" rx="22" ry="4.5" stroke="#8b5cf6" strokeWidth="1" strokeOpacity="0.6" />

        {/* Floating Autonomous Bot Body */}
        <g className="anim-agent-float">
          {/* Antennas */}
          <line x1="56" y1="36" x2="48" y2="24" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="47" cy="22" r="3.5" fill="#c4b5fd" />
          <line x1="104" y1="36" x2="112" y2="24" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="113" cy="22" r="3.5" fill="#c4b5fd" />

          {/* Head Chassis */}
          <rect x="44" y="34" width="72" height="58" rx="22" fill="url(#robot-body-grad)" stroke="#c4b5fd" strokeWidth="1.5" />

          {/* Ear Modules */}
          <rect x="38" y="52" width="6" height="18" rx="3" fill="#6366f1" />
          <rect x="116" y="52" width="6" height="18" rx="3" fill="#6366f1" />

          {/* Dark Glass Visor Screen */}
          <rect x="52" y="46" width="56" height="30" rx="10" fill="url(#robot-visor-grad)" stroke="#334155" strokeWidth="1" />

          {/* Glowing Eyes */}
          <g className="anim-visor-glow">
            <rect x="61" y="56" width="13" height="8" rx="3.5" fill="#38bdf8" />
            <rect x="86" y="56" width="13" height="8" rx="3.5" fill="#38bdf8" />
          </g>

          {/* Chest Core */}
          <path d="M 62 92 L 98 92 L 92 114 L 68 114 Z" fill="#312e81" stroke="#6366f1" strokeWidth="1" />
          <circle cx="80" cy="103" r="4" fill="#a78bfa" className="anim-visor-glow" />

          {/* Geometric Orbit Accent */}
          <circle cx="124" cy="42" r="2" fill="#38bdf8" opacity="0.8" />
          <circle cx="34" cy="80" r="1.5" fill="#a78bfa" opacity="0.6" />
        </g>
      </svg>
    </div>
  )
}

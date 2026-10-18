/**
 * agentAudio.ts — Web Audio API sound engine for the agent layer.
 *
 * All sounds are synthesised on-the-fly from oscillators (zero asset files).
 * The AudioContext is created lazily on the first user interaction so browsers
 * that block autoplay never throw an error before user gesture.
 *
 * Usage:
 *   agentAudio.setEnabled(true)
 *   agentAudio.playRadarPing()
 *   agentAudio.playSonarPulse()   // looping; call stopSonarPulse() to end
 *   agentAudio.playSuccessChime()
 */

class AgentAudioEngine {
  private ctx: AudioContext | null = null
  private enabled = false
  private sonarGain: GainNode | null = null
  private sonarOsc: OscillatorNode | null = null

  private getCtx(): AudioContext | null {
    if (!this.enabled) return null
    if (!this.ctx || this.ctx.state === 'closed') {
      try {
        this.ctx = new AudioContext()
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) {
      this.stopSonarPulse()
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Single radar ping: brief sine blip at ~880 Hz decaying over 0.3 s. */
  playRadarPing(): void {
    const ctx = this.getCtx()
    if (!ctx) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gainNode = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.3)
    gainNode.gain.setValueAtTime(0.25, now)
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc.connect(gainNode)
    gainNode.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.32)
  }

  /**
   * Success chime: ascending major triad (C5, E5, G5) as short sine tones
   * staggered by 80 ms each, each decaying over 0.5 s.
   */
  playSuccessChime(): void {
    const ctx = this.getCtx()
    if (!ctx) return
    const now = ctx.currentTime
    const frequencies = [523.25, 659.25, 783.99] // C5, E5, G5
    frequencies.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gainNode = ctx.createGain()
      const start = now + idx * 0.08
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, start)
      gainNode.gain.setValueAtTime(0.18, start)
      gainNode.gain.exponentialRampToValueAtTime(0.001, start + 0.5)
      osc.connect(gainNode)
      gainNode.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.52)
    })
  }

  /**
   * Sonar pulse: a low-frequency sine wave at ~200 Hz modulated with an
   * AM envelope that repeats every 1.2 s. Runs indefinitely until
   * stopSonarPulse() is called. Only one pulse loop runs at a time.
   */
  playSonarPulse(): void {
    const ctx = this.getCtx()
    if (!ctx || this.sonarOsc) return // already running
    const osc = ctx.createOscillator()
    const gainNode = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(200, ctx.currentTime)
    gainNode.gain.setValueAtTime(0, ctx.currentTime)
    osc.connect(gainNode)
    gainNode.connect(ctx.destination)
    osc.start()
    this.sonarOsc = osc
    this.sonarGain = gainNode
    this._scheduleSonarPulses(ctx, gainNode, ctx.currentTime)
  }

  private _scheduleSonarPulses(
    ctx: AudioContext,
    gainNode: GainNode,
    startAt: number,
  ): void {
    const interval = 1.2
    const scheduleAhead = 5
    let cursor = startAt
    const tick = () => {
      if (!this.sonarOsc) return
      const now = ctx.currentTime
      while (cursor < now + scheduleAhead) {
        gainNode.gain.setValueAtTime(0, cursor)
        gainNode.gain.linearRampToValueAtTime(0.15, cursor + 0.05)
        gainNode.gain.exponentialRampToValueAtTime(0.001, cursor + 0.4)
        cursor += interval
      }
      window.setTimeout(tick, 800)
    }
    tick()
  }

  stopSonarPulse(): void {
    if (this.sonarGain) {
      try {
        this.sonarGain.gain.setValueAtTime(0, this.ctx?.currentTime ?? 0)
      } catch {
        // AudioContext may already be closed
      }
      this.sonarGain = null
    }
    if (this.sonarOsc) {
      try { this.sonarOsc.stop() } catch {
        // Already stopped
      }
      this.sonarOsc = null
    }
  }
}

export const agentAudio = new AgentAudioEngine()

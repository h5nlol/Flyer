/**
 * Cortex executive feed: what the second control layer is commanding, right now.
 *
 * Sits above the brain scan so the two-brain conflict is visible without opening
 * the debug panel -- the fly's connectome wants to feed, and this is the thing
 * that can veto it.
 *
 * Values are polled from the `sim` module object and written straight to the DOM.
 * No React state on the data path, same rule as every other readout here.
 */
import { useEffect, useRef } from 'react'
import { sim } from './simSocket'

const BAR = 16

/** Bipolar -1..1 bar with a centre mark. */
function bipolar(v: number): string {
  const half = BAR / 2
  const n = Math.max(-half, Math.min(half, Math.round(v * half)))
  const cells: string[] = []
  for (let i = -half; i < half; i++) {
    const inBand = n >= 0 ? i >= 0 && i < n : i < 0 && i >= n
    cells.push(inBand ? '=' : i === 0 ? '|' : '.')
  }
  return cells.join('')
}

export function CortexHUD() {
  const box = useRef<HTMLPreElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setInterval(() => {
      const el = box.current
      const host = root.current
      if (!el || !host) return
      const { cortex } = sim
      const live = sim.status === 'live' && cortex.online
      const ex = cortex.executive

      host.classList.toggle('override', cortex.engaged)
      host.classList.toggle('offline', !live)

      el.textContent = live
        ? [
            `yaw    [${bipolar(cortex.yaw)}] ${cortex.yaw >= 0 ? '+' : ''}${cortex.yaw.toFixed(3)} V`,
            `pitch  [${bipolar(cortex.pitch)}] ${cortex.pitch >= 0 ? '+' : ''}${cortex.pitch.toFixed(3)} V`,
            `walk   [${bipolar(cortex.forward)}] ${cortex.forward >= 0 ? '+' : ''}${cortex.forward.toFixed(3)}`,
            `steer  [${bipolar(cortex.lateral)}] ${cortex.lateral >= 0 ? '+' : ''}${cortex.lateral.toFixed(3)}`,
            `hands  ${cortex.hands ? 'ACTIVE' : 'idle'}`,
            cortex.engaged
              ? `OVERRIDE ${ex.toFixed(2)}  hijacking giant fiber + inhibition`
              : ex > 0.5
                ? `override ${ex.toFixed(2)}  requested, no threat in reflex range`
                : `override ${ex.toFixed(2)}  fly has motor control`,
          ].join('\n')
        : 'no culture on the bus'
    }, 100)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="cortex-hud" ref={root}>
      <div className="cortex-hud-title">
        CORTEX EXECUTIVE FEED <span>MEA gateway</span>
      </div>
      <pre ref={box} />
    </div>
  )
}

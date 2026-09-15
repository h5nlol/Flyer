/**
 * Environmental perturbation chip: shown while the server runs a stochastic event
 * (dust influx, odor waft). Fades in and out; counts down locally between the
 * ~7 Hz broadcasts. DOM-direct, no React state on the data path.
 */
import { useEffect, useRef } from 'react'
import { sim } from './simSocket'

const TITLES: Record<string, string> = {
  dust_influx: 'PARTICULATE / DUST INFLUX',
  ambient_odor_waft: 'AMBIENT ODOR WAFT',
}

export function EventChip() {
  const root = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLDivElement>(null)
  const sub = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setInterval(() => {
      const el = root.current
      if (!el) return
      const e = sim.status === 'live' ? sim.world.event : null
      el.classList.toggle('on', !!e)
      if (!e) return // keep the last text while fading out
      const left = Math.max(0, e.remaining - (performance.now() - e.at) / 1000)
      const t = `[ENVIRONMENTAL PERTURBATION: ${TITLES[e.type] ?? e.type.toUpperCase()}]`
      if (title.current && title.current.textContent !== t) title.current.textContent = t
      if (sub.current) sub.current.textContent = `${e.label} · ${left.toFixed(1)} s`
      if (bar.current) bar.current.style.width = `${e.duration > 0 ? (left / e.duration) * 100 : 0}%`
    }, 100)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="event-chip" ref={root} role="status" aria-live="polite">
      <div className="event-chip-title" ref={title} />
      <div className="event-chip-sub" ref={sub} />
      <div className="event-chip-bar"><div ref={bar} /></div>
    </div>
  )
}

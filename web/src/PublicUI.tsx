/**
 * Public view, strictly spectator: a status badge with the sound toggle (top
 * left) and the Behavioral Intent & Internal State panel (right). Nothing here
 * sends a command; the server would close a public connection that did.
 *
 * Every readout is a plain-language reading of a value the server already sends:
 * satiety, the escape command (MDN), the walk / steer / groom descending neurons,
 * and the cortex channels that add to them. Written straight to the DOM on an
 * interval; no React state on the data path.
 */
import { useEffect, useRef, useState } from 'react'
import { isMuted, mute, unmute } from './audio'
import { controls } from './controls'
import { onSimStatus, sim } from './simSocket'

// Thresholds on the 0..1 drives the server sends (fraction of an 80 Hz saturation).
const ESCAPE_DRIVE = 0.15 // same value the gait uses to let an escape take the body
const WALK_DRIVE = 0.15
const STEER_DIFF = 0.1
const GROOM_DRIVE = 0.3

const MOTOR = [
  { id: 'escape', label: 'Aversive Escape (Reverse Scramble)' },
  { id: 'forward', label: 'Forward Locomotion' },
  { id: 'steer', label: 'Chemotactic Course Correction' },
  { id: 'groom', label: 'Cephalic Grooming / Antenna Maintenance' },
  { id: 'feed', label: 'Stationary Feeding (Locomotion Braked)' },
  { id: 'idle', label: 'Stationary / Idle Survey' },
] as const

type MotorId = (typeof MOTOR)[number]['id']

function metabolic(satiety: number): string {
  if (satiety < 0.2) return 'Active Foraging (Seeking sucrose gradient)'
  if (satiety <= 0.5) return 'Feeding / Digesting'
  return 'Satiated (Proboscis retracted)'
}

function motorState(): Record<MotorId, boolean> {
  const r = sim.raw
  const c = sim.cortex.online ? sim.cortex : null
  const escape = r.mdn > ESCAPE_DRIVE
  // An escape or the feeding brake suppresses walking and steering at the motor
  // layer, so do not claim them.
  const held = escape || sim.feedingBrake
  const forward = !held && (r.dnp09 > WALK_DRIVE || (c ? c.forward > WALK_DRIVE : false))
  const steer = !held && (Math.abs(r.dna_l - r.dna_r) > STEER_DIFF || (c ? Math.abs(c.lateral) > WALK_DRIVE : false))
  const groom = sim.dng11 > GROOM_DRIVE || controls.isPlaying('groom_face') || controls.isPlaying('groom_hands')
  const feed = sim.feedingBrake && !escape
  return { escape, forward, steer, groom, feed, idle: !(escape || forward || steer || groom || feed) }
}

/** Spike sonification. The first click is the user gesture browsers require to start audio. */
function SoundToggle() {
  const [on, setOn] = useState(() => !isMuted())
  return (
    <button
      className={`sound-toggle${on ? ' on' : ''}`}
      aria-pressed={on}
      title="Neuron clicks, MN9 feeding pops, and a drone that follows the E/I ratio"
      onClick={() => {
        if (on) mute()
        else unmute()
        setOn(!on)
      }}
    >
      SOUND [{on ? 'ON' : 'OFF'}]
    </button>
  )
}

export function PublicUI() {
  const [live, setLive] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => onSimStatus((s) => setLive(s === 'live')), [])

  // DOM-direct readouts, ~7 Hz like the broadcasts they read.
  useEffect(() => {
    const id = setInterval(() => {
      const root = panel.current
      if (!root) return
      const set = (key: string, text: string) => {
        const el = root.querySelector<HTMLElement>(`[data-k="${key}"]`)
        if (el && el.textContent !== text) el.textContent = text
      }
      const on = sim.status === 'live'

      const sat = sim.satiety
      set('metabolic', on ? metabolic(sat) : '--')
      set('satiety', on ? sat.toFixed(2) : '--')
      const fill = root.querySelector<HTMLElement>('[data-k="satiety-bar"]')
      if (fill) fill.style.width = `${Math.round((on ? sat : 0) * 100)}%`

      const m = motorState()
      const alert = on && (m.escape || sim.threat)
      set('arousal', on
        ? alert ? 'High Alert — Aversive escape reflex engaged' : 'Nominal — Ambient environmental exploration'
        : '--')
      root.querySelector('[data-k="arousal-card"]')?.classList.toggle('alert', alert)

      for (const { id } of MOTOR) {
        root.querySelector(`[data-motor="${id}"]`)?.classList.toggle('on', on && m[id])
      }
      // During a dust influx the grooming is aimed at the eye bristles that were hit.
      const groomRow = root.querySelector<HTMLElement>('[data-motor="groom"]')
      const groomText = on && sim.world.event?.type === 'dust_influx'
        ? 'Cephalic Grooming / Eye Bristle Clearance'
        : 'Cephalic Grooming / Antenna Maintenance'
      if (groomRow && groomRow.textContent !== groomText) groomRow.textContent = groomText
      set('behaviour', on ? (sim.autonomous ? `autonomous · ${sim.behaviour}` : 'manual control') : 'connecting…')
    }, 150)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      <div className="status-badge">
        <div className="status-row">
          <div className="status-phase">PHASE N: MOTOR ARBITRATION &amp; GAIT TUNING</div>
          <SoundToggle />
        </div>
        <div className="status-day">Day 01 — Baseline Connectome Integration &amp; Autonomous Chemotaxis</div>
      </div>

      <aside className="intent-panel" ref={panel}>
        <div className="intent-title">
          BEHAVIORAL INTENT &amp; INTERNAL STATE
          <span data-k="behaviour">connecting…</span>
        </div>

        <section className="intent-card">
          <h3>Metabolic Drive <em>appetite</em></h3>
          <p data-k="metabolic">--</p>
          <div className="intent-meter">
            <div className="intent-bar"><div data-k="satiety-bar" /></div>
            <code>satiety <span data-k="satiety">--</span></code>
          </div>
        </section>

        <section className="intent-card" data-k="arousal-card">
          <h3>Arousal / Threat State</h3>
          <p data-k="arousal">--</p>
        </section>

        <section className="intent-card">
          <h3>Motor Intent <em>descending neurons</em></h3>
          <ul className="intent-motor">
            {MOTOR.map(({ id, label }) => (
              <li key={id} data-motor={id}>{label}</li>
            ))}
          </ul>
        </section>

        <div className="public-note">
          {live
            ? 'spectating a live leaky integrate-and-fire simulation of 139,255 FlyWire FAFB v783 neurons'
            : 'connecting to the connectome…'}
        </div>
      </aside>
    </>
  )
}

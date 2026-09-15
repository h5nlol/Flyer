import { useEffect, useRef, useState } from 'react'
import { controls, HEAD_MORPHS, type SceneInfo } from './controls'
import {
  onSimStatus, sendAutonomous, sendDeploy, sendFlush, sendLesion, sendLoom, sendResetFly, sendRestore, sendStimulus, sim,
  type SimStatus,
} from './simSocket'
import { onCameraMode, setCameraMode } from './CameraRig'
import { onBrainVisible, setBrainVisible } from './brainData'
import { proximity } from './Environment'
import { isMuted, mute, setVolume, unmute } from './audio'

/** Uncontrolled slider: writes straight into `controls`, never into React state. */
function Slider({ label, min, max, step, initial, onChange }: {
  label: string
  min: number
  max: number
  step: number
  initial: number
  onChange: (v: number) => void
}) {
  // ponytail: the readout is written straight to the DOM. Putting it in state
  // re-renders the input on every drag frame, which fights the uncontrolled value.
  const readout = useRef<HTMLElement>(null)
  // No React children on the readout: React would restore them on re-render.
  useEffect(() => { if (readout.current) readout.current.textContent = initial.toFixed(2) }, [initial])
  return (
    <label className="slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={initial}
        onInput={(e) => {
          const v = e.currentTarget.valueAsNumber
          onChange(v)
          if (readout.current) readout.current.textContent = v.toFixed(2)
        }}
      />
      <code ref={readout} />
    </label>
  )
}

/** Mute and volume. The first unmute is the user gesture audio needs to start. */
function AudioControls() {
  const [on, setOn] = useState(!isMuted())
  return (
    <div className="audio">
      <button
        className={on ? 'on' : undefined}
        onClick={() => {
          if (on) mute()
          else unmute()
          setOn(!on)
        }}
        title="spike sonification"
      >
        {on ? 'sound on' : 'sound off'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        defaultValue={0.6}
        aria-label="volume"
        onInput={(e) => setVolume(e.currentTarget.valueAsNumber)}
      />
    </div>
  )
}

/** Admin overlays. Writes a flag the field renderer reads per frame; no re-render in the scene. */
function Overlays() {
  const [fields, setFields] = useState(controls.showFields)
  return (
    <section>
      <h2>Overlays / Debug visualization</h2>
      <div className="buttons">
        <button
          className={fields ? 'on' : undefined}
          aria-pressed={fields}
          onClick={() => {
            controls.showFields = !fields
            setFields(!fields)
          }}
        >
          Show Sensory Fields / Range Rings [{fields ? 'ON' : 'OFF'}]
        </button>
      </div>
      <p className="note">
        Rings use the radii the server applies. Food distance is measured from the head, threat
        distance from the body, so a food ring is where the <strong>head</strong> must reach.
        Outer ring: sensing starts (odor or shadow grows toward the centre). Inner ring: contact
        reflex (feeding, bitter suppression, loom escape); it brightens while in range. Chemotaxis
        steering has no radius: in autonomous mode the fly heads for the sugar from anywhere.
      </p>
    </section>
  )
}

/** Camera presets; keys 1/2/3 do the same. State changes on click only. */
function CameraPresets() {
  const [mode, setMode] = useState(1)
  const [scan, setScan] = useState(true)
  useEffect(() => onCameraMode(setMode), [])
  useEffect(() => onBrainVisible(setScan), [])
  const presets = [
    [1, 'Follow orbit'],
    [2, 'Head macro'],
    [3, 'Free orbit'],
  ] as const
  return (
    <section>
      <h2>Camera <span className="hint">keys 1 / 2 / 3</span></h2>
      <div className="buttons">
        {presets.map(([m, label]) => (
          <button key={m} className={mode === m ? 'on' : undefined} onClick={() => setCameraMode(m)}>
            {m} {label}
          </button>
        ))}
        <button className={scan ? 'on' : undefined} onClick={() => setBrainVisible(!scan)}>
          Toggle brain scan
        </button>
      </div>
    </section>
  )
}

/** Loom trigger, autonomous mode, and what the fly is currently doing. */
function BehaviourPanel() {
  const [live, setLive] = useState(false)
  const [auto, setAuto] = useState(false)
  // Autonomy is an admin action server-side; loom is a public stimulus.
  const [admin, setAdmin] = useState(false)
  const box = useRef<HTMLPreElement>(null)

  useEffect(() => onSimStatus((s) => {
    setLive(s === 'live')
    if (s !== 'live') setAuto(false)
  }), [])

  useEffect(() => {
    const flash = document.getElementById('loom-flash')
    let wasLoom = false
    const id = setInterval(() => {
      // Mirror the server's autonomy flag: a reloaded page must not show OFF
      // while the sim is still choosing behaviour.
      setAuto((was) => (was === sim.autonomous ? was : sim.autonomous))
      setAdmin((was) => (was === (sim.role === 'admin') ? was : sim.role === 'admin'))
      if (flash && sim.loom !== wasLoom) {
        flash.classList.toggle('on', sim.loom)
        wasLoom = sim.loom
      }
      if (!box.current) return
      box.current.textContent = live
        ? [
            `behaviour   ${sim.autonomous ? sim.behaviour : 'manual'}`,
            `DNp01 giant fiber  ${sim.dnp01.toFixed(2)}${sim.loom ? '   LOOMING' : ''}`,
            `escapes     ${sim.escapeSeq}`,
            `bypass      ${sim.bypass.length ? sim.bypass.join(', ') : 'none'}`,
            `threat      ${sim.threat ? 'IN RANGE' : 'clear'}`,
            ...(['sugar', 'bitter', 'threat'] as const).map((t) => {
              const d = proximity.distance[t]
              const b = proximity.bearing[t]
              return `${t.padEnd(7)} ${Number.isFinite(d) ? d.toFixed(1).padStart(5) : '   --'} u  ` +
                `sense ${proximity.intensity[t].toFixed(2)}  bearing ${b >= 0 ? '+' : ''}${b.toFixed(2)}` +
                (proximity.inRange[t] ? '  REFLEX' : '')
            }),
          ].join('\n')
        : 'offline'
    }, 100)
    return () => clearInterval(id)
  }, [live])

  return (
    <section>
      <h2>Behaviour</h2>
      <div className="buttons">
        <button className="loom" disabled={!live || !admin} onClick={() => sendLoom()}>
          Visual loom / threat
        </button>
        <button
          className={auto ? 'on' : undefined}
          disabled={!live || !admin}
          onClick={() => {
            if (sendAutonomous(!auto)) setAuto(!auto)
          }}
        >
          Autonomous foraging {auto ? 'ON' : 'OFF'}
        </button>
      </div>
      <h2>Deploy into reflex range <span className="hint">shared world, every viewer sees it</span></h2>
      <div className="buttons">
        <button disabled={!live || !admin} onClick={() => sendDeploy('sugar')}>Deploy sugar cube</button>
        <button disabled={!live || !admin} onClick={() => sendDeploy('bitter')}>Deploy quinine spike</button>
        <button className="loom" disabled={!live || !admin} onClick={() => sendDeploy('threat')}>Deploy threat</button>
      </div>
      <p className="note">
        Loom drives the LC4 and LPLC2 loom detectors, which reach the giant fiber (DNp01)
        through the real wiring. The backward scramble it launches is a <strong>bypass</strong>:
        DNp01 has no path to MDN in this brain-only volume.
      </p>
      <p className="note">
        Drag the green cube (sugar) or red spike (bitter) to the mouth, or the dark plane
        (threat) over the body. Positions live on the server. In autonomous mode the fly
        walks to the sugar cube (the turn is a <strong>bypass</strong>).
      </p>
      <pre className="phases" ref={box} />
    </section>
  )
}

/** The manual drive sliders stand down while the sim is choosing behaviour. */
function GaitDrives() {
  const [auto, setAuto] = useState(false)
  useEffect(() => {
    const id = setInterval(() => {
      setAuto((was) => (was === controls.autonomous ? was : controls.autonomous))
    }, 250)
    return () => clearInterval(id)
  }, [])
  return (
    <section>
      <h2>Gait drives {auto && <span className="hint">autonomous: sliders disabled</span>}</h2>
      <fieldset className="drives" disabled={auto}>
        <Slider label="dnp09 fwd" min={0} max={1} step={0.01} initial={0}
          onChange={(v) => { controls.drives.dnp09 = v }} />
        <Slider label="mdn back" min={0} max={1} step={0.01} initial={0}
          onChange={(v) => { controls.drives.mdn = v }} />
        <Slider label="dna_l left" min={0} max={1} step={0.01} initial={0}
          onChange={(v) => { controls.drives.dna_l = v }} />
        <Slider label="dna_r right" min={0} max={1} step={0.01} initial={0}
          onChange={(v) => { controls.drives.dna_r = v }} />
      </fieldset>
      <div className="buttons">
        <button onClick={() => { controls.resetBody(); sendResetFly() }}>recenter body</button>
      </div>
      <pre className="phases" ref={(el) => { controls.phaseEl = el }} />
    </section>
  )
}

const STIMULI = [
  { id: 'sugar', label: 'Sugar', bypass: false },
  { id: 'bitter', label: 'Bitter (control)', bypass: false },
  { id: 'odor', label: 'Odor', bypass: false },
  { id: 'dust', label: 'Dust', bypass: false },
  { id: 'walk', label: 'Walk (bypass)', bypass: true },
  { id: 'groom', label: 'Groom (bypass)', bypass: true },
]

/** Satiety meter, polled from the module object -- never a per-message render. */
function Satiety({ live }: { live: boolean }) {
  const fill = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const id = setInterval(() => {
      if (!fill.current || !label.current) return
      const pct = Math.round(sim.satiety * 100)
      fill.current.style.width = `${pct}%`
      fill.current.className = `bar-fill${sim.fed ? ' full' : ''}`
      label.current.textContent = live
        ? `${pct}%${sim.fed ? '  FULL - not feeding' : ''}`
        : 'offline'
    }, 100)
    return () => clearInterval(id)
  }, [live])
  return (
    <div className="meter">
      <span>satiety</span>
      <div className="bar"><div className="bar-fill" ref={fill} /></div>
      <span ref={label} className="meter-val" />
    </div>
  )
}

const LESIONS = [
  { target: 'gaba_inhibitory', fraction: 0.5, label: 'Ablate 50% GABAergic',
    effect: 'breaks bitter suppression, drives runaway firing' },
  { target: 'dnp09', fraction: 1.0, label: 'Sever DNp09',
    effect: 'paralyses forward gait' },
  { target: 'mn9', fraction: 1.0, label: 'Ablate MN9 / ingestion',
    effect: 'paralyses tongue extension' },
]

/** Live ablation of the connectome. Kept apart from the array telemetry above:
 *  that panel reports hardware, this one cuts the fly's own wiring. */
function LesionPanel() {
  // Own subscription rather than a prop: `status` is not in scope at the call
  // site, and the DOM's legacy global `status` makes that typecheck silently.
  const [live, setLive] = useState(false)
  // Surgery is admin-only server-side. Without the role these buttons would be
  // no-ops, so they are disabled and say why.
  const [admin, setAdmin] = useState(false)
  const [on, setOn] = useState<Record<string, boolean>>({})
  const box = useRef<HTMLPreElement>(null)

  useEffect(() => onSimStatus((s) => setLive(s === 'live')), [])

  useEffect(() => {
    const id = setInterval(() => {
      if (!box.current) return
      setAdmin((was) => (was === (sim.role === 'admin') ? was : sim.role === 'admin'))
      const c = sim.circuit
      const lost = c.total ? c.total - c.alive : 0
      const supp = c.suppression === null ? '--' : `${(c.suppression * 100).toFixed(0)}%`
      box.current.textContent = live
        ? [
            `neurons     ${c.alive.toLocaleString()} / ${c.total.toLocaleString()}` +
              (lost ? `   (${lost.toLocaleString()} ablated)` : ''),
            `E/I spikes  ${c.ei.toFixed(2)}   exc ${c.exc.toLocaleString()}  inh ${c.inh.toLocaleString()}`,
            `MN9 suppression by bitter  ${supp}`,
          ].join('\n')
        : 'offline'
    }, 150)
    return () => clearInterval(id)
  }, [live])

  useEffect(() => {
    if (!live) setOn({})
  }, [live])

  const toggle = (target: string, fraction: number) => {
    const next = !on[target]
    if (sendLesion(target, next ? fraction : 0)) setOn((s) => ({ ...s, [target]: next }))
  }

  return (
    <section>
      <h2>Circuit surgery (connectome lesions)
        {live && !admin && <span className="hint">read-only: add ?admin=true&amp;token=… for control</span>}
      </h2>
      <div className="buttons">
        {LESIONS.map(({ target, fraction, label, effect }) => (
          <button
            key={target}
            className={on[target] ? 'lesion on' : 'lesion'}
            disabled={!live || !admin}
            onClick={() => toggle(target, fraction)}
            title={effect}
          >
            {label} {on[target] ? 'CUT' : ''}
          </button>
        ))}
        <button
          disabled={!live || !admin}
          onClick={() => {
            if (sendRestore()) setOn({})
          }}
        >
          Restore connectome
        </button>
        <button
          disabled={!live || !admin}
          onClick={() => sendFlush()}
          title="Clear voltages, synaptic current and refractory state. Lesions and stimuli are kept."
        >
          Flush voltages
        </button>
      </div>
      <pre className="phases" ref={box} />
    </section>
  )
}

/** Live housekeeping from the multi-electrode array. */
function CorticalArray() {
  const box = useRef<HTMLPreElement>(null)
  const dot = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const bar = (v: number) => {
      const n = Math.max(0, Math.min(20, Math.round((v + 1) * 10)))
      return `[${'-'.repeat(n)}|${'-'.repeat(20 - n)}]`
    }
    const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)} V`
    const id = setInterval(() => {
      if (!box.current || !dot.current) return
      const { cortex, telemetry } = sim
      dot.current.className = `dot${cortex.online ? ' on' : ''}`
      box.current.textContent = cortex.online
        ? [
            `impedance   ${telemetry.impedance.toFixed(3)} MOhm`,
            `array temp  ${telemetry.temp.toFixed(2)} C`,
            `SNR         ${telemetry.snr.toFixed(1)} dB`,
            '',
            `neck yaw    ${bar(cortex.yaw)} ${sign(cortex.yaw)}`,
            `neck pitch  ${bar(cortex.pitch)} ${sign(cortex.pitch)}`,
            `hand unit   ${cortex.hands ? 'ACTIVE' : 'idle'}`,
            `executive   ${cortex.executive.toFixed(2)}${cortex.executive > 0.5 ? '  OVERRIDE ENGAGED' : ''}`,
          ].join('\n')
        : ['array offline - no culture on the bus',
           'head falls back to the fly neck pools'].join('\n')
    }, 100)
    return () => clearInterval(id)
  }, [])
  return (
    <section>
      <h2>Cortical array (human MEA)</h2>
      <p className="array-head">
        <span ref={dot} className="dot" /> 60-channel culture, head and hand units
      </p>
      <pre className="phases" ref={box} />
    </section>
  )
}

/** Connection state and stimulus triggers. Status is the only React state here --
 *  it changes on connect/disconnect, not per message. */
function SimPanel() {
  const [status, setStatus] = useState<SimStatus>('offline')
  const [active, setActive] = useState<Record<string, boolean>>({})
  const readout = useRef<HTMLPreElement>(null)

  useEffect(() => onSimStatus(setStatus), [])

  // A dropped socket takes the server's stimulus state with it, so the local
  // button state has to go too or it lies until the next click.
  useEffect(() => {
    if (status !== 'live') setActive({})
  }, [status])

  // Poll the module object for display only; the 3D path never goes through React.
  useEffect(() => {
    const id = setInterval(() => {
      if (!readout.current) return
      readout.current.textContent =
        status === 'live'
          ? `t ${(sim.t_ms / 1000).toFixed(1)}s   ${sim.realtime.toFixed(2)}x realtime   ` +
            `msgs ${sim.messages}
tongue ${sim.raw.tongue_out.toFixed(3)}   ` +
            `dnp09 ${sim.raw.dnp09.toFixed(3)}   mdn ${sim.raw.mdn.toFixed(3)}   ` +
            `dna ${sim.raw.dna_l.toFixed(2)}/${sim.raw.dna_r.toFixed(2)}` +
            `
stimulus: ${sim.stimulus.length ? sim.stimulus.join(', ') : 'none'}`
          : 'sliders are driving; start: python src/server.py'
    }, 100)
    return () => clearInterval(id)
  }, [status])

  const toggle = (name: string) => {
    const next = !active[name]
    if (sendStimulus(name, next)) setActive((a) => ({ ...a, [name]: next }))
  }

  return (
    <section>
      <h2>Connectome sim</h2>
      <p className={status === 'live' ? 'live' : 'missing'}>
        <strong>{status}</strong>
        {status === 'live' ? ' — sim drives the walk drives and tongue' : ' — debug sliders in control'}
      </p>
      <div className="buttons">
        {STIMULI.map(({ id, label, bypass }) => (
          <button
            key={id}
            className={`${active[id] ? 'on' : ''}${bypass ? ' bypass' : ''}`.trim() || undefined}
            disabled={status !== 'live'}
            onClick={() => toggle(id)}
            title={bypass ? 'Injects the descending neuron directly: not a connectome pathway' : undefined}
          >
            {label} {active[id] ? 'ON' : 'OFF'}
          </button>
        ))}
      </div>
      <Satiety live={status === 'live'} />
      <p className="note">
        walk / groom drive DNp09 and DNg11 <strong>directly</strong>. Measured at 150 Hz,
        odor reaches the steering DNs (dna_l 25.7 Hz) but nothing reaches DNp09 or DNg11,
        so those two are a bypass, not a connectome result.
      </p>
      <pre className="phases" ref={readout} />
    </section>
  )
}

function Missing({ what, why }: { what: string; why: string }) {
  return (
    <p className="missing">
      <strong>none found</strong> — this GLB has no {what}. {why}
    </p>
  )
}

export function DebugPanel({ info }: { info: SceneInfo | null }) {
  const [loop, setLoop] = useState(true)
  if (!info) return <aside className="panel">loading {'…'}</aside>

  const zFightRisk = info.materials.filter((m) => m.transparent && m.depthWrite)

  return (
    <aside className="panel">
      <header className="panel-head">
        <h1>flyer_web.glb</h1>
        <AudioControls />
      </header>

      <SimPanel />
      <BehaviourPanel />
      <CameraPresets />
      <Overlays />
      <CorticalArray />
      <LesionPanel />
      <GaitDrives />

      <section>
        <h2>Head (morphs)</h2>
        <Slider label="yaw L/R" min={-1} max={1} step={0.01} initial={0}
          onChange={(v) => { controls.headYaw = v }} />
        <Slider label="pitch U/D" min={-1} max={1} step={0.01} initial={0}
          onChange={(v) => { controls.headPitch = v }} />
      </section>

      <section>
        <h2>Morph targets ({controls.morphNames.length})</h2>
        {controls.morphNames.length === 0
          ? <Missing what="morph targets" why="" />
          : controls.morphNames.filter((n) => !HEAD_MORPHS.includes(n)).map((name) => (
            <Slider
              key={name}
              label={name}
              min={0}
              max={1}
              step={0.01}
              initial={0}
              onChange={(v) => { controls.morphs[name] = v }}
            />
          ))}
      </section>

      <section>
        <h2>Bones ({info.bones.length})</h2>
        {info.bones.length === 0 ? (
          <Missing
            what="skin or armature"
            why="The scene is a single static mesh node. Re-export from Blender with Armature included."
          />
        ) : (
          <ul className="names">{info.bones.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
      </section>

      <section>
        <h2>Animation clips ({info.clips.length})</h2>
        {info.clips.length === 0 ? (
          <Missing
            what="animation clips"
            why="Enable Animation in the glTF exporter and bake the actions."
          />
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              loop
            </label>
            <div className="buttons">
              {info.clips.map((c) => (
                <button key={c.name} onClick={() => controls.play(c.name, loop)}>
                  {c.name} <small>{c.duration.toFixed(2)}s</small>
                </button>
              ))}
              <button onClick={() => controls.stopAll()}>stop</button>
            </div>
          </>
        )}
      </section>

      <section>
        <h2>Meshes ({info.meshes.length})</h2>
        <table>
          <thead><tr><th>mesh</th><th>material</th><th>skinned</th><th>morphTargetDictionary</th></tr></thead>
          <tbody>
            {info.meshes.map((m, i) => (
              <tr key={`${m.name}-${i}`}>
                <td>{m.name || <em>(unnamed)</em>}</td>
                <td>{m.material}</td>
                <td>{m.skinned ? 'yes' : 'no'}</td>
                <td><code>{m.morphTargetDictionary ? JSON.stringify(m.morphTargetDictionary) : '-'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Materials</h2>
        <table>
          <thead><tr><th>name</th><th>transparent</th><th>opacity</th><th>depthWrite</th><th>side</th></tr></thead>
          <tbody>
            {info.materials.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td>{String(m.transparent)}</td>
                <td>{m.opacity}</td>
                <td>{String(m.depthWrite)}</td>
                <td>{m.side}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {zFightRisk.length > 0 && (
          <p className="missing">
            depthWrite is on for transparent material{zFightRisk.length > 1 ? 's' : ''}{' '}
            {zFightRisk.map((m) => m.name).join(', ')} — sort artefacts possible on overlapping wings.
          </p>
        )}
      </section>
    </aside>
  )
}

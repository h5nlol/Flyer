/**
 * WebSocket client for the PyTorch LIF server.
 *
 * Inbound payloads are written into module-level targets and then eased into
 * `controls` from the render loop -- never into React state. The server
 * broadcasts roughly 7 times a second (one chunk of sim per message), which is
 * far too coarse to drive a morph directly, so `pumpSim` smooths between them.
 *
 * When the socket is down, this module touches nothing: the debug sliders keep
 * whatever they were set to and stay in charge.
 */
import { controls } from './controls'
import { onBrainFrame } from './brainData'

export const SIM_URL = import.meta.env.VITE_SIM_URL ?? 'ws://localhost:8765'

export type SimStatus = 'offline' | 'connecting' | 'live'
export type SimRole = 'unknown' | 'admin' | 'public'

/**
 * The admin token is never stored in this bundle -- it comes from the URL only
 * (?admin=true&token=...), so a public build contains no credential to leak.
 */
function authPayload(): Record<string, string> {
  try {
    const q = new URLSearchParams(window.location.search)
    const token = q.get('token')
    if (q.get('admin') === 'true' && token) return { type: 'auth', token }
  } catch {
    /* fall through to public */
  }
  return { type: 'auth', role: 'public' }
}

export type PropName = 'sugar' | 'bitter' | 'threat'
type WorldWire = {
  fly?: { x?: number; z?: number; yaw?: number; vx?: number; vz?: number; vyaw?: number }
  props?: Partial<Record<PropName, number[]>>
  in_range?: Partial<Record<PropName, boolean>>
  sugar_health_pct?: number
  sugar_present?: boolean
  environmental_event?: { type?: string; label?: string; duration_s?: number; remaining_s?: number } | null
}

type Payload = {
  world?: WorldWire
  fly_drives?: Partial<Record<'dnp09' | 'mdn' | 'dna_l' | 'dna_r' | 'dnp01' | 'dng11', number>>
  cortex_drives?: {
    yaw_voltage?: number
    pitch_voltage?: number
    hands_active?: boolean
    executive_override?: number
    forward_drive?: number
    lateral_steer?: number
    executive_engaged?: boolean
  }
  hardware_telemetry?: { mea_snr?: number; impedance?: number; temp?: number }
  circuit?: {
    alive?: number
    total?: number
    lesions?: Record<string, number>
    ei_ratio?: number
    exc_spikes?: number
    inh_spikes?: number
    suppression?: number | null
    mn9_baseline?: number
    active_count?: number
  }
  morphs?: Partial<Record<'tongue_out', number>>
  clips?: Partial<Record<'groom_face', boolean>>
  sim?: {
    t_ms?: number
    stimulus?: string[]
    realtime?: number
    neck?: number[]
    array_online?: boolean
    satiety?: number
    fed?: boolean
    bypass?: string[]
    autonomous?: boolean
    behaviour?: string
    escape_seq?: number
    loom?: boolean
    threat?: boolean
    feeding_brake?: boolean
  }
}

const target = {
  dnp09: 0,
  mdn: 0,
  dna_l: 0,
  dna_r: 0,
  tongue_out: 0,
  headYaw: 0,
  headPitch: 0,
  cortexForward: 0,
  cortexLateral: 0,
}

export const sim = {
  status: 'offline' as SimStatus,
  /** last values the server sent, before smoothing -- for the debug panel */
  raw: { ...target },
  t_ms: 0,
  realtime: 0,
  stimulus: [] as string[],
  bypass: [] as string[],
  /** role the server granted; admin-only commands are suppressed unless 'admin' */
  role: 'unknown' as SimRole,
  satiety: 0,
  fed: false,
  neck: [0, 0] as [number, number],
  /** cortical array: conditioned channel voltages and array housekeeping */
  cortex: { yaw: 0, pitch: 0, hands: false, online: false, executive: 0, engaged: false, forward: 0, lateral: 0 },
  threat: false,
  telemetry: { snr: 0, impedance: 0, temp: 0 },
  /** connectome integrity: ablation state and live excitation/inhibition balance */
  circuit: {
    alive: 0,
    total: 0,
    lesions: {} as Record<string, number>,
    ei: 0,
    exc: 0,
    inh: 0,
    suppression: null as number | null,
    active: 0,
  },
  dnp01: 0,
  /** server motor brake: standing still at the food while feeding */
  feedingBrake: false,
  /** grooming command (DNg11), 0..1 */
  dng11: 0,
  autonomous: false,
  behaviour: 'off',
  loom: false,
  escapeSeq: 0,
  messages: 0,
  /**
   * The shared world, as the server last reported it. The server owns it: every
   * viewer renders the same fly pose and prop positions. `at` is when it arrived,
   * so the body can be extrapolated between broadcasts.
   */
  world: {
    fly: null as null | { x: number; z: number; yaw: number; vx: number; vz: number; vyaw: number; at: number },
    props: null as null | Record<PropName, [number, number, number]>,
    /** which props are inside reflex range right now, per the server */
    inRange: { sugar: false, bitter: false, threat: false } as Record<PropName, boolean>,
    /** finite sugar: 1 = full cube, 0 = eaten */
    sugarHealth: 1,
    /** false between a cube being eaten and its respawn */
    sugarPresent: true,
    /** a stochastic perturbation in progress (dust, odor), or null */
    event: null as null | { type: string; label: string; duration: number; remaining: number; at: number },
    /** sensing thresholds the server applies, sent on the handshake */
    fields: null as null | { sense: number; reflex: number; reflexExit: number; headAhead: number },
  },
}

const finite = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function applyWorld(w: WorldWire | undefined) {
  if (!w) return
  const f = w.fly
  if (f) {
    sim.world.fly = {
      x: finite(f.x), z: finite(f.z), yaw: finite(f.yaw),
      vx: finite(f.vx), vz: finite(f.vz), vyaw: finite(f.vyaw), at: performance.now(),
    }
  }
  const p = w.props
  if (p) {
    const vec = (v: number[] | undefined): [number, number, number] | null =>
      Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : null
    const sugar = vec(p.sugar), bitter = vec(p.bitter), threat = vec(p.threat)
    if (sugar && bitter && threat) sim.world.props = { sugar, bitter, threat }
  }
  if (typeof w.sugar_health_pct === 'number' && Number.isFinite(w.sugar_health_pct)) {
    sim.world.sugarHealth = Math.max(0, Math.min(1, w.sugar_health_pct))
  }
  if (typeof w.sugar_present === 'boolean') sim.world.sugarPresent = w.sugar_present
  if (w.environmental_event === null) sim.world.event = null
  else if (w.environmental_event && typeof w.environmental_event.type === 'string') {
    const e = w.environmental_event
    sim.world.event = {
      type: e.type!, label: typeof e.label === 'string' ? e.label : e.type!,
      duration: finite(e.duration_s), remaining: finite(e.remaining_s), at: performance.now(),
    }
  }
  const r = w.in_range
  if (r) sim.world.inRange = { sugar: r.sugar === true, bitter: r.bitter === true, threat: r.threat === true }
}

let socket: WebSocket | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let backoff = 500
const listeners = new Set<(s: SimStatus) => void>()

export function onSimStatus(cb: (s: SimStatus) => void): () => void {
  listeners.add(cb)
  cb(sim.status)
  return () => listeners.delete(cb)
}

function setStatus(s: SimStatus) {
  if (sim.status === s) return
  sim.status = s
  for (const cb of listeners) cb(s)
}

const num = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback

/** Same guard, but for channels that are genuinely bipolar. */
const signed = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : fallback

function apply(p: Payload) {
  applyWorld(p.world)
  target.dnp09 = num(p.fly_drives?.dnp09)
  target.mdn = num(p.fly_drives?.mdn)
  target.dna_l = num(p.fly_drives?.dna_l)
  target.dna_r = num(p.fly_drives?.dna_r)
  target.tongue_out = num(p.morphs?.tongue_out)

  // Head pose has two possible sources and the array wins outright.
  //
  // The fly's own neck pools do reach the head, but measured at 0.02 of range --
  // about 2%, which is invisible. When the array is streaming, its conditioned
  // channels take the head completely; the fly neck is only a fallback for when
  // the array is offline.
  const [nl, nr] = Array.isArray(p.sim?.neck) ? p.sim.neck : [0, 0]
  const c = p.cortex_drives
  const arrayOnline = p.sim?.array_online === true

  if (arrayOnline && c) {
    target.headYaw = signed(c.yaw_voltage)
    target.headPitch = signed(c.pitch_voltage)
  } else {
    target.headYaw = Math.max(-1, Math.min(1, num(nl) - num(nr)))
    target.headPitch = num((num(nl) + num(nr)) / 2)
  }

  sim.cortex = {
    yaw: signed(c?.yaw_voltage),
    pitch: signed(c?.pitch_voltage),
    hands: c?.hands_active === true,
    online: arrayOnline,
    executive: num(c?.executive_override),
    engaged: c?.executive_engaged === true,
    forward: signed(c?.forward_drive),
    lateral: signed(c?.lateral_steer),
  }
  sim.threat = p.sim?.threat === true
  const tel = p.hardware_telemetry
  sim.telemetry = {
    snr: typeof tel?.mea_snr === 'number' ? tel.mea_snr : sim.telemetry.snr,
    impedance: typeof tel?.impedance === 'number' ? tel.impedance : sim.telemetry.impedance,
    temp: typeof tel?.temp === 'number' ? tel.temp : sim.telemetry.temp,
  }

  // Hand channel drives the two-handed groom. Re-armed while held, and never
  // started on top of the face groom, which keys the same limbs.
  if (sim.cortex.hands && !controls.isPlaying('groom_hands') && !controls.isPlaying('groom_face')) {
    controls.play('groom_hands', false)
  }

  Object.assign(sim.raw, target)
  sim.neck = [num(nl), num(nr)]
  sim.satiety = num(p.sim?.satiety)
  sim.fed = p.sim?.fed === true
  sim.bypass = Array.isArray(p.sim?.bypass) ? p.sim.bypass : []

  const ci = p.circuit
  if (ci) {
    sim.circuit = {
      alive: typeof ci.alive === 'number' ? ci.alive : sim.circuit.alive,
      total: typeof ci.total === 'number' ? ci.total : sim.circuit.total,
      lesions: ci.lesions && typeof ci.lesions === 'object' ? ci.lesions : {},
      ei: typeof ci.ei_ratio === 'number' ? ci.ei_ratio : 0,
      exc: typeof ci.exc_spikes === 'number' ? ci.exc_spikes : 0,
      inh: typeof ci.inh_spikes === 'number' ? ci.inh_spikes : 0,
      suppression: typeof ci.suppression === 'number' ? ci.suppression : null,
      active: typeof ci.active_count === 'number' ? ci.active_count : 0,
    }
  }

  sim.dnp01 = num(p.fly_drives?.dnp01)
  sim.dng11 = num(p.fly_drives?.dng11)
  sim.autonomous = p.sim?.autonomous === true
  controls.autonomous = sim.autonomous
  sim.behaviour = typeof p.sim?.behaviour === 'string' ? p.sim.behaviour : 'off'
  sim.loom = p.sim?.loom === true
  sim.feedingBrake = p.sim?.feeding_brake === true

  // Escape arrives as a counter, not a flag: a broadcast can be missed, and a
  // counter still tells us an escape happened since the last one we saw.
  const seq = typeof p.sim?.escape_seq === 'number' ? p.sim.escape_seq : sim.escapeSeq
  if (seq > sim.escapeSeq && sim.messages > 0) controls.resetGaitPhases()
  sim.escapeSeq = seq

  sim.t_ms = typeof p.sim?.t_ms === 'number' ? p.sim.t_ms : sim.t_ms
  sim.realtime = typeof p.sim?.realtime === 'number' ? p.sim.realtime : sim.realtime
  sim.stimulus = Array.isArray(p.sim?.stimulus) ? p.sim.stimulus : []
  sim.messages++

  // Re-arm while the command is held rather than firing once on the edge: DNg11
  // staying active means the fly is still grooming, so the clip should repeat
  // until it stops. Guarded on the mixer so it never restarts mid-clip.
  if (p.clips?.groom_face === true && !controls.isPlaying('groom_face')) {
    controls.play('groom_face', false)
  }
}

export function connectSim(url: string = SIM_URL): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return
  setStatus('connecting')
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    scheduleRetry(url)
    return
  }
  socket = ws
  // Brain-scan frames are binary; everything else is JSON text.
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    backoff = 500
    // Identify before anything else: the server serves nothing until we do.
    ws.send(JSON.stringify(authPayload()))
    setStatus('live')
  }
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      onBrainFrame(e.data)
      return
    }
    try {
      const parsed = JSON.parse(e.data as string) as Payload & {
        type?: string
        role?: string
        fields?: { sense?: number; reflex?: number; reflex_exit?: number; head_ahead?: number }
      }
      if (parsed.type === 'auth_ok') {
        sim.role = parsed.role === 'admin' ? 'admin' : 'public'
        applyWorld(parsed.world) // the handshake carries the current world snapshot
        const f = parsed.fields
        if (f && [f.sense, f.reflex, f.reflex_exit, f.head_ahead].every((v) => typeof v === 'number' && v > 0)) {
          sim.world.fields = { sense: f.sense!, reflex: f.reflex!, reflexExit: f.reflex_exit!, headAhead: f.head_ahead! }
        }
        return
      }
      apply(parsed)
    } catch {
      /* a malformed frame is not worth tearing the connection down for */
    }
  }
  ws.onerror = () => ws.close()
  ws.onclose = () => {
    socket = null
    sim.role = 'unknown'
    sim.world.fly = null // a reconnect must not correct toward a pose from before the drop
    setStatus('offline')
    scheduleRetry(url)
  }
}

function scheduleRetry(url: string) {
  if (retry) return
  retry = setTimeout(() => {
    retry = null
    connectSim(url)
  }, backoff)
  backoff = Math.min(backoff * 2, 8000) // keep trying, but stop hammering
}

export function disconnectSim(): void {
  if (retry) {
    clearTimeout(retry)
    retry = null
  }
  const ws = socket
  socket = null
  if (ws) {
    ws.onclose = null
    ws.close()
  }
  setStatus('offline')
}

function send(msg: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(msg))
  return true
}

/**
 * Every command is admin-only: public connections are spectators and the server
 * closes one that sends anything. Guarded here too, so a view rendered without the
 * admin role can never disconnect itself.
 */
function sendAdmin(msg: unknown): boolean {
  if (sim.role !== 'admin') return false
  return send(msg)
}

export function sendStimulus(stimulus: string, state: boolean): boolean {
  return sendAdmin({ stimulus, state })
}

/** Move a prop in the shared world; the server clamps it and broadcasts to everyone. */
export function sendProp(name: PropName, x: number, y: number, z: number): boolean {
  return sendAdmin({ action: 'prop', name, x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3) })
}

/** Teleport a prop into reflex range of the fly, placed server-side from the shared pose. */
export function sendDeploy(name: PropName): boolean {
  return sendAdmin({ action: 'deploy', name })
}

export function sendResetFly(): boolean {
  return sendAdmin({ action: 'reset_fly' })
}

/** fraction 0 lifts the lesion; the server treats the active set as declarative. */
export function sendLesion(target: string, fraction: number): boolean {
  return sendAdmin({ action: 'lesion', target, fraction })
}

export function sendRestore(): boolean {
  return sendAdmin({ action: 'restore' })
}

export function sendThreat(state: boolean): boolean {
  return sendAdmin({ action: 'threat', state })
}

/** Clear membrane and synaptic state; lesions and stimuli are kept. */
export function sendFlush(): boolean {
  return sendAdmin({ action: 'flush' })
}

export function sendLoom(): boolean {
  return sendAdmin({ action: 'loom' })
}

export function sendAutonomous(state: boolean): boolean {
  return sendAdmin({ action: 'autonomous', state })
}

/**
 * Ease `controls` toward the last payload. Called once per frame.
 *
 * No-op while offline, which is the whole fallback story: the sliders wrote
 * those same fields and nothing here overwrites them.
 */
export function pumpSim(dt: number): boolean {
  if (sim.status !== 'live') return false
  // ~90 ms time constant: slow enough to bridge the gap between broadcasts,
  // fast enough that a tongue still looks like it reacts.
  const k = 1 - Math.exp(-dt / 0.09)
  const d = controls.drives
  d.brake = sim.feedingBrake
  d.dnp09 += (target.dnp09 - d.dnp09) * k
  d.mdn += (target.mdn - d.mdn) * k
  d.dna_l += (target.dna_l - d.dna_l) * k
  d.dna_r += (target.dna_r - d.dna_r) * k
  const t = controls.morphs.tongue_out ?? 0
  controls.morphs.tongue_out = t + (target.tongue_out - t) * k
  // Flyer's useFrame splits these into the four head morphs, so the sim reaches
  // the head through exactly the same path the sliders use.
  controls.headYaw += (target.headYaw - controls.headYaw) * k
  controls.headPitch += (target.headPitch - controls.headPitch) * k
  // Cortical locomotion. The array adds a noise floor of about +-0.03, so a small
  // deadband keeps an idle cortex from making the body creep; outside it the
  // channel is rescaled so the response stays continuous.
  const band = (v: number) => {
    const DEAD = 0.08
    const m = Math.abs(v)
    return m <= DEAD ? 0 : Math.sign(v) * ((m - DEAD) / (1 - DEAD))
  }
  target.cortexForward = sim.cortex.online ? band(sim.cortex.forward) : 0
  target.cortexLateral = sim.cortex.online ? band(sim.cortex.lateral) : 0
  const cf = d.cortex_forward ?? 0
  const cl = d.cortex_lateral ?? 0
  d.cortex_forward = cf + (target.cortexForward - cf) * k
  d.cortex_lateral = cl + (target.cortexLateral - cl) * k
  return true
}

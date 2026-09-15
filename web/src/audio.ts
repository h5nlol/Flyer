/**
 * Spike sonification with the Web Audio API.
 *
 *   clicks   high-passed noise gated into ~1 ms bursts at Poisson times, rate
 *            following how many neurons fired in the last chunk -- the sound of
 *            an extracellular rig
 *   pops     a resonant mid tone with a fast pitch drop, fired at MN9's rate
 *   drone    two detuned low sines whose pitch rises with the E/I ratio
 *
 * The graph is built once, on the first user gesture (browsers refuse to start
 * audio before one). After that every sound is an automation event on an
 * existing AudioParam: no node is created per click, per pop or per tick.
 */
import { sim } from './simSocket'

const LOOKAHEAD_S = 0.12 // how far ahead each tick schedules
const TICK_MS = 40
const CLICK_BASE_HZ = 12
const CLICK_PER_NEURON = 0.22 // clicks/s per neuron active in the last chunk
const CLICK_MAX_HZ = 420 // bounds automation events per tick
const POP_MAX_HZ = 14 // pops/s at full MN9 drive
const POP_MIN_GAP_S = 0.09

let ctx: AudioContext | null = null
let master: GainNode
let clickGain: GainNode
let popGain: GainNode
let popOsc: OscillatorNode
let droneA: OscillatorNode
let droneB: OscillatorNode
let droneGain: GainNode
let timer: ReturnType<typeof setInterval> | null = null

let volume = 0.6
let muted = true
let nextClick = 0
let nextPop = 0

function build(): void {
  ctx = new AudioContext()
  const c = ctx

  master = c.createGain()
  master.gain.value = 0
  master.connect(c.destination)

  // clicks: looping white noise -> high-pass -> gated gain
  const noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = noise
  src.loop = true
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 2200
  clickGain = c.createGain()
  clickGain.gain.value = 0
  src.connect(hp).connect(clickGain).connect(master)
  src.start()

  // pops: sine through a resonant band-pass, gated
  popOsc = c.createOscillator()
  popOsc.type = 'sine'
  popOsc.frequency.value = 520
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 480
  bp.Q.value = 7
  popGain = c.createGain()
  popGain.gain.value = 0
  popOsc.connect(bp).connect(popGain).connect(master)
  popOsc.start()

  // drone: two detuned sines through a low-pass
  droneA = c.createOscillator()
  droneB = c.createOscillator()
  droneA.type = droneB.type = 'sine'
  droneA.frequency.value = 90
  droneB.frequency.value = 90 * 1.006
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 700
  droneGain = c.createGain()
  droneGain.gain.value = 0
  droneA.connect(lp)
  droneB.connect(lp)
  lp.connect(droneGain).connect(master)
  droneA.start()
  droneB.start()
}

/** Glide a param to `value` over `seconds`, from wherever it is now. */
function glide(param: AudioParam, value: number, now: number, seconds: number) {
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(value, now + seconds)
}

function tick(): void {
  if (!ctx) return
  const now = ctx.currentTime
  const horizon = now + LOOKAHEAD_S
  const live = sim.status === 'live'

  // --- clicks: Poisson process on the gate --------------------------------
  const clickHz = live
    ? Math.min(CLICK_MAX_HZ, CLICK_BASE_HZ + sim.circuit.active * CLICK_PER_NEURON)
    : 0
  if (nextClick < now) nextClick = now
  if (clickHz > 0.5) {
    const gate = clickGain.gain
    while (nextClick < horizon) {
      const amp = 0.05 + Math.random() * 0.08
      gate.setValueAtTime(amp, nextClick)
      gate.setValueAtTime(0, nextClick + 0.0011)
      nextClick += -Math.log(1 - Math.random()) / clickHz
    }
  } else {
    nextClick = horizon
  }

  // --- pops: Poisson at MN9's rate ------------------------------------------
  const popHz = live ? sim.raw.tongue_out * POP_MAX_HZ : 0
  if (nextPop < now) nextPop = now
  if (popHz > 0.3) {
    const g = popGain.gain
    const f = popOsc.frequency
    while (nextPop < horizon) {
      const t = nextPop
      g.setValueAtTime(0, t)
      g.linearRampToValueAtTime(0.32, t + 0.004)
      g.exponentialRampToValueAtTime(0.0001, t + 0.13)
      f.setValueAtTime(640, t)
      f.exponentialRampToValueAtTime(250, t + 0.11)
      nextPop += Math.max(POP_MIN_GAP_S, -Math.log(1 - Math.random()) / popHz)
    }
  } else {
    nextPop = horizon
  }

  // --- drone: pitch follows E/I, higher when disinhibited -----------------
  const ei = live ? sim.circuit.ei : 0
  const pitch = 80 + 28 * Math.min(3, Math.max(0, ei / 4))
  glide(droneA.frequency, pitch, now, 0.4)
  glide(droneB.frequency, pitch * 1.006, now, 0.4)
  glide(droneGain.gain, live ? 0.045 : 0, now, 0.5)
}

function applyMaster(): void {
  if (!ctx) return
  glide(master.gain, muted ? 0 : volume, ctx.currentTime, 0.08)
}

/** Must run inside a user gesture the first time. */
export function unmute(): void {
  if (!ctx) build()
  void ctx!.resume()
  muted = false
  if (!timer) timer = setInterval(tick, TICK_MS)
  applyMaster()
}

export function mute(): void {
  muted = true
  applyMaster()
}

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v))
  applyMaster()
}

export function isMuted(): boolean {
  return muted
}

// dev-only handle for checking the graph is alive from the console
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__audio = {
    get state() { return ctx?.state ?? 'not built' },
    get time() { return ctx?.currentTime ?? 0 },
    get nextClick() { return nextClick },
    get nextPop() { return nextPop },
    get muted() { return muted },
  }
}

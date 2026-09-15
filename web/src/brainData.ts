/**
 * Live brain-scan data: the bridge between the socket's binary frames and the
 * point cloud's GPU buffers.
 *
 * Firing is stored as a *time*, not a brightness. Each spike frame writes the
 * current clock into `fire[i]` for the neurons that fired; the shader turns
 * `now - fire[i]` into a decaying glow. So the CPU touches only the neurons that
 * actually fired, ~7 times a second, and nothing is looped or uploaded per frame.
 *
 * Frame layout (see server.py): u8 type, u8 encoding, u16 reserved, u32 count,
 * then either uint32 LE indices or a 1-bit-per-neuron LE bitmask.
 */
import type * as THREE from 'three'

const FRAME_SPIKES = 1
const FRAME_ALIVE = 2
const ENC_INDICES = 0
const ENC_BITMASK = 1

export const brain = {
  n: 0,
  /** seconds on the performance clock when each neuron last fired */
  fire: null as Float32Array | null,
  /** 1 alive, 0 ablated */
  alive: null as Float32Array | null,
  fireAttr: null as THREE.BufferAttribute | null,
  aliveAttr: null as THREE.BufferAttribute | null,
  /** neurons that fired in the most recent chunk, for the HUD */
  firing: 0,
  aliveCount: 0,
  frames: 0,
  visible: true,
}

/** The shared clock: the shader's uTime reads the same one. */
export const nowSeconds = () => performance.now() / 1000

// An alive mask can land before the geometry has loaded; hold it and apply on load.
let pendingAlive: Uint8Array | null = null

function eachSetBit(bytes: Uint8Array, n: number, fn: (i: number) => void) {
  for (let b = 0; b < bytes.length; b++) {
    const v = bytes[b]
    if (v === 0) continue
    for (let bit = 0; bit < 8; bit++) {
      if (v & (1 << bit)) {
        const i = b * 8 + bit
        if (i < n) fn(i)
      }
    }
  }
}

function applyAlive(bytes: Uint8Array) {
  const alive = brain.alive
  if (!alive) {
    pendingAlive = bytes.slice() // the frame's buffer is not ours to keep
    return
  }
  alive.fill(0)
  let count = 0
  eachSetBit(bytes, brain.n, (i) => {
    alive[i] = 1
    count++
  })
  brain.aliveCount = count
  if (brain.aliveAttr) brain.aliveAttr.needsUpdate = true
}

export function onBrainFrame(buf: ArrayBuffer): void {
  if (buf.byteLength < 8) return
  const head = new DataView(buf, 0, 8)
  const kind = head.getUint8(0)
  const enc = head.getUint8(1)
  const count = head.getUint32(4, true)
  brain.frames++

  if (kind === FRAME_ALIVE && enc === ENC_BITMASK) {
    applyAlive(new Uint8Array(buf, 8))
    return
  }
  if (kind !== FRAME_SPIKES) return

  brain.firing = count
  const fire = brain.fire
  if (!fire || count === 0) return
  const t = nowSeconds()
  const n = brain.n

  if (enc === ENC_INDICES) {
    // The 8-byte header keeps the indices 4-byte aligned, so this is a view, not a copy.
    const idx = new Uint32Array(buf, 8, Math.min(count, (buf.byteLength - 8) >> 2))
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k]
      if (i < n) fire[i] = t
    }
  } else if (enc === ENC_BITMASK) {
    eachSetBit(new Uint8Array(buf, 8), n, (i) => {
      fire[i] = t
    })
  }
  if (brain.fireAttr) brain.fireAttr.needsUpdate = true
}

/** Called by the point cloud once its geometry exists. */
export function attachBrain(
  n: number,
  fire: Float32Array,
  alive: Float32Array,
  fireAttr: THREE.BufferAttribute,
  aliveAttr: THREE.BufferAttribute,
): void {
  brain.n = n
  brain.fire = fire
  brain.alive = alive
  brain.fireAttr = fireAttr
  brain.aliveAttr = aliveAttr
  brain.aliveCount = n
  if (pendingAlive) {
    const p = pendingAlive
    pendingAlive = null
    applyAlive(p)
  }
}

const visListeners = new Set<(v: boolean) => void>()

export function setBrainVisible(v: boolean): void {
  brain.visible = v
  for (const cb of visListeners) cb(v)
}

export function onBrainVisible(cb: (v: boolean) => void): () => void {
  visListeners.add(cb)
  cb(brain.visible)
  return () => visListeners.delete(cb)
}

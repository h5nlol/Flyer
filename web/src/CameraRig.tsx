/**
 * Tracking camera, camera presets and a ground that follows the fly. Everything
 * per-frame mutates existing objects; React only renders this once.
 *
 * There is no mouse-gesture loom any more. Pointer motion over the canvas is
 * viewport navigation, and it kept reading as a threat; threats now come only from
 * the threat prop in range or an explicit button.
 *
 *   1  follow orbit   target eases onto the body, camera carried along, so any
 *                     orbit offset the user dialled in is kept while walking
 *   2  head macro     tight on the face, for the mouth and tongue morphs
 *   3  free orbit     tracking off, for inspection
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { chamber, FLOOR_Y, FLY_SCALE } from './chamber'
import { controls } from './controls'

type Mode = 1 | 2 | 3
const listeners = new Set<(m: Mode) => void>()

export function setCameraMode(m: Mode) {
  if (controls.cameraMode === m) return
  controls.cameraMode = m
  for (const cb of listeners) cb(m)
}

export function onCameraMode(cb: (m: Mode) => void): () => void {
  listeners.add(cb)
  cb(controls.cameraMode)
  return () => listeners.delete(cb)
}

// Frame-rate independent easing rates (per second): k = 1 - exp(-rate * dt).
const FOLLOW_RATE = 2.5
const HEIGHT_RATE = 0.4 // bob is +-0.07 at ~5 Hz; this filters it to nothing
const MACRO_RATE = 3
const MACRO_DISTANCE = 2.2 * FLY_SCALE
const BODY_LIFT = 1.2 * FLY_SCALE // aim above the root bone, at the thorax rather than the floor

// Camera containment. The camera may never leave `cameraBox` (the inside of the
// glass). Clamping position alone would squash the orbit radius permanently, so
// the rig keeps an IDEAL distance -- what the viewer zoomed to -- and each frame
// places the camera at min(ideal, room to the wall along the view ray). Near a wall
// that dollies in; away from it the camera eases back out.
const WALL_PAD = 0.03 // stay this far inside the glass
const DOLLY_OUT_RATE = 2.5 // per second, easing back out once there is room
export const ZOOM_LIMITS = { public: [0.5, 3.2], admin: [0.15, 6] } as const

// Screen-ratio framing. A portrait phone sees a narrow slice of a 40 degree vertical
// FOV, so the camera pulls back and widens as the screen gets taller than wide:
// nothing at aspect >= 1, full effect by aspect 0.5 (a typical phone is ~0.46).
export const MAX_BOOST = 1.5 // distance multiplier at full portrait
const PORTRAIT_EXTRA_FOV = 14 // degrees added at full portrait
const ASPECT_RATE = 4 // per second, eases rotation between portrait and landscape
const portraitAmount = (aspect: number) => THREE.MathUtils.clamp((1 - aspect) / 0.5, 0, 1)

// scratch -- reused every frame
const _goal = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _cam = new THREE.Vector3()
const _dir = new THREE.Vector3()

/** Largest t >= 0 with origin + dir * t still inside the camera box (origin assumed inside). */
function roomAlong(origin: THREE.Vector3, dir: THREE.Vector3): number {
  const b = chamber.cameraBox
  let t = Infinity
  const slab = (o: number, d: number, lo: number, hi: number) => {
    if (d > 1e-9) t = Math.min(t, (hi - WALL_PAD - o) / d)
    else if (d < -1e-9) t = Math.min(t, (lo + WALL_PAD - o) / d)
  }
  slab(origin.x, dir.x, b.minX, b.maxX)
  slab(origin.y, dir.y, b.minY, b.maxY)
  slab(origin.z, dir.z, b.minZ, b.maxZ)
  return Math.max(0, t)
}

function clampToBox(v: THREE.Vector3) {
  const b = chamber.cameraBox
  v.x = THREE.MathUtils.clamp(v.x, b.minX + WALL_PAD, b.maxX - WALL_PAD)
  v.y = THREE.MathUtils.clamp(v.y, b.minY + WALL_PAD, b.maxY - WALL_PAD)
  v.z = THREE.MathUtils.clamp(v.z, b.minZ + WALL_PAD, b.maxZ - WALL_PAD)
}

/** `locked`: public view. Always follow mode, no presets; the orbit target sits on the body. */
export function CameraRig({ locked = false }: { locked?: boolean }) {
  const { camera } = useThree()
  const size = useThree((s) => s.size)
  const baseFov = useRef((camera as THREE.PerspectiveCamera).fov)
  const orbit = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null
  const shadows = useRef<THREE.Group>(null)
  const [zoomMin, zoomMax] = locked ? ZOOM_LIMITS.public : ZOOM_LIMITS.admin
  // ideal = the distance the viewer asked for; applied = where the camera actually is
  const dolly = useRef({ ideal: -1, applied: -1, boost: 1 })

  // keyboard presets
  useEffect(() => {
    if (locked) {
      setCameraMode(1)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === '1' || e.key === '2' || e.key === '3') setCameraMode(Number(e.key) as Mode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked])

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 20)
    const body = controls.body

    // Ground detail follows the fly so the shadow never gets left behind.
    if (shadows.current) shadows.current.position.set(body.x, FLOOR_Y + 0.001, body.z)

    if (!orbit) return
    const mode = controls.cameraMode

    // Portrait screens (phones) get a wider, further-back view, updated live as the
    // ratio changes. Landscape is untouched: t = 0 means boost 1 and the base FOV.
    const t = portraitAmount(size.width / Math.max(1, size.height))
    const boost = 1 + (MAX_BOOST - 1) * t
    const persp = camera as THREE.PerspectiveCamera
    const fovGoal = baseFov.current + PORTRAIT_EXTRA_FOV * t
    if (persp.isPerspectiveCamera && Math.abs(persp.fov - fovGoal) > 0.01) {
      persp.fov += (fovGoal - persp.fov) * (1 - Math.exp(-ASPECT_RATE * dt))
      persp.updateProjectionMatrix()
    }

    if (mode === 1) {
      // Move target and camera by the same delta: the fly stays framed and the
      // user's orbit angle and distance survive.
      // No hard lock: the root bone bobs twice per stride and takes small server
      // corrections, and a camera glued to it shakes with every step. Horizontal
      // follow is eased; height is eased so slowly that the bob averages out.
      const k = 1 - Math.exp(-FOLLOW_RATE * dt)
      const ky = 1 - Math.exp(-HEIGHT_RATE * dt)
      _goal.copy(body).setY(body.y + BODY_LIFT)
      _delta.subVectors(_goal, orbit.target)
      _delta.x *= k
      _delta.z *= k
      _delta.y *= ky
      orbit.target.add(_delta)
      camera.position.add(_delta)

      // --- dolly: the orbit controls own direction and zoom, the rig owns distance ---
      _dir.subVectors(camera.position, orbit.target)
      const d = _dir.length()
      if (d < 1e-6) return
      _dir.divideScalar(d)
      const s = dolly.current
      if (s.ideal < 0) {
        s.ideal = THREE.MathUtils.clamp(d / boost, zoomMin, zoomMax)
        s.applied = d
        s.boost = boost
      }
      // Rotation and following keep the distance; any change since last frame is the
      // viewer zooming (wheel / pinch, including damping), so it moves the ideal. The
      // ideal is stored unboosted, so rotating the phone rescales it instead of drifting.
      s.ideal = THREE.MathUtils.clamp(s.ideal + (d - s.applied) / s.boost, zoomMin, zoomMax)
      s.boost = boost
      const room = roomAlong(orbit.target, _dir)
      const want = Math.min(s.ideal * boost, room)
      // In immediately (never through the glass), out gently (no pumping).
      s.applied = want < s.applied ? want : s.applied + (want - s.applied) * (1 - Math.exp(-DOLLY_OUT_RATE * dt))
      camera.position.copy(orbit.target).addScaledVector(_dir, s.applied)
    } else if (mode === 2) {
      // Face direction without assuming bone axes: body -> head is forward.
      const k = 1 - Math.exp(-MACRO_RATE * dt)
      _fwd.subVectors(controls.head, body).setY(0)
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1)
      _fwd.normalize()
      _cam.copy(controls.head).addScaledVector(_fwd, MACRO_DISTANCE)
      _cam.y += 0.35
      orbit.target.lerp(controls.head, k)
      camera.position.lerp(_cam, k)
      clampToBox(camera.position)
      dolly.current.ideal = -1 // re-read the distance on the way back to follow mode
    } else {
      clampToBox(camera.position)
      dolly.current.ideal = -1
    }
  })

  return (
    <>
      <group ref={shadows}>
        <ContactShadows position={[0, 0, 0]} opacity={0.55} scale={16 * FLY_SCALE} blur={2.4} far={6 * FLY_SCALE} />
      </group>
    </>
  )
}

/**
 * The environment props, rendered from the shared world the server owns.
 *
 *   sugar   donut          near the mouth  -> sugar GRNs, feeding, finite (shrinks)
 *   bitter  rock           near the mouth  -> bitter GRNs
 *   threat  tweezers       over the body   -> threat state (repeated looms, and the
 *                                             cortex is told a threat is present)
 *
 * Models and their scales live in Props.tsx; every model's base is at y = 0, so a
 * prop's position is its footprint on the floor.
 *
 * Positions come from `sim.world.props`: every viewer sees the same props, and a
 * reload shows where they actually are. Proximity, reflexes and chemotaxis are all
 * computed on the server now; this component sends no stimuli. An admin can drag a
 * prop, which sends its new position to the server, and the server broadcasts it.
 *
 * `proximity` below is a local reading of the same geometry for the debug
 * readouts only. It triggers nothing.
 */
import { memo, useRef } from 'react'
import { DragControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FLOOR_Y, FLY_SCALE } from './chamber'
import { controls } from './controls'
import { sendProp, sim, type PropName } from './simSocket'
import { PropModel } from './Props'

type Target = PropName

// Fly-relative lengths, scaled with the fly (the server sends the authoritative values).
export const SENSE_RADIUS = 5.0 * FLY_SCALE // sensing starts here, intensity 0
export const REFLEX = 1.5 * FLY_SCALE // contact reflexes fire inside this
const EXIT = 1.15 // hysteresis on leaving reflex range
const TARGETS = ['sugar', 'bitter', 'threat'] as const
const DRAG_SEND_MS = 150 // while dragging; the server allows 10 messages a second
const HOLD_AFTER_DRAG_MS = 800 // ignore stale broadcasts until the server echoes the drop
const SHRINK_RATE = 6 // per second, smooths the ~7 Hz health updates

export const proximity = {
  scale: 0,
  distance: { sugar: Infinity, bitter: Infinity, threat: Infinity } as Record<Target, number>,
  inRange: { sugar: false, bitter: false, threat: false } as Record<Target, boolean>,
  intensity: { sugar: 0, bitter: 0, threat: 0 } as Record<Target, number>,
  /** -1 hard left .. +1 hard right, relative to the fly's heading */
  bearing: { sugar: 0, bitter: 0, threat: 0 } as Record<Target, number>,
}

/** Used until the server's first snapshot arrives (and when no server is running). */
const DEFAULTS: Record<Target, [number, number, number]> = {
  sugar: [7 * FLY_SCALE, FLOOR_Y, 5 * FLY_SCALE],
  bitter: [-7 * FLY_SCALE, FLOOR_Y, 5 * FLY_SCALE],
  threat: [0, FLOOR_Y + 0.45, 10 * FLY_SCALE],
}

const _p = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _to = new THREE.Vector3()

export const Environment = memo(function Environment({ editable = false }: { editable?: boolean }) {
  const { controls: orbit } = useThree() as unknown as { controls: { enabled: boolean } | null }
  const refs = {
    sugar: useRef<THREE.Group>(null),
    bitter: useRef<THREE.Group>(null),
    threat: useRef<THREE.Group>(null),
  }
  const drag = useRef({
    active: null as Target | null,
    start: new THREE.Vector3(),
    sentAt: 0,
    holdUntil: { sugar: 0, bitter: 0, threat: 0 } as Record<Target, number>,
  })

  const sugarScale = useRef(1)

  useFrame((_, rawDelta) => {
    const now = performance.now()
    const live = sim.status === 'live'
    const props = live ? sim.world.props : null
    for (const t of TARGETS) {
      const mesh = refs[t].current
      if (!mesh || !props || drag.current.active === t || now < drag.current.holdUntil[t]) continue
      mesh.position.fromArray(props[t])
    }

    // Finite food: the donut shrinks as it is eaten (about its base, which sits on the
    // floor) and is gone until it respawns.
    const sugar = refs.sugar.current
    if (sugar) {
      const present = !live || sim.world.sugarPresent
      const goal = live ? Math.max(0.1, sim.world.sugarHealth) : 1
      // A respawned cube arrives full size rather than growing back in place.
      if (!sugar.visible && present) sugarScale.current = goal
      sugarScale.current += (goal - sugarScale.current) * (1 - Math.exp(-SHRINK_RATE * Math.min(rawDelta, 0.1)))
      sugar.visible = present
      sugar.scale.setScalar(sugarScale.current)
    }

    // Local proximity reading, for the debug readouts only.
    const body = controls.body
    const head = controls.head
    const scale = Math.hypot(head.x - body.x, head.z - body.z)
    if (scale < 1e-3) return
    proximity.scale = scale
    _fwd.set(head.x - body.x, 0, head.z - body.z).normalize()
    for (const t of TARGETS) {
      const mesh = refs[t].current
      if (!mesh || !mesh.visible) {
        proximity.distance[t] = Infinity
        proximity.intensity[t] = 0
        proximity.inRange[t] = false
        continue
      }
      mesh.getWorldPosition(_p)
      const from = t === 'threat' ? body : head
      const d = Math.hypot(_p.x - from.x, _p.z - from.z)
      proximity.distance[t] = d
      proximity.intensity[t] = Math.max(0, Math.min(1, 1 - d / SENSE_RADIUS))
      _to.set(_p.x - body.x, 0, _p.z - body.z)
      if (_to.lengthSq() > 1e-8) {
        _to.normalize()
        const cross = _fwd.x * _to.z - _fwd.z * _to.x // > 0 is the fly's left
        proximity.bearing[t] = Math.max(-1, Math.min(1, Math.atan2(-cross, _fwd.dot(_to)) / (Math.PI / 2)))
      }
      proximity.inRange[t] = proximity.inRange[t] ? d < REFLEX * EXIT : d < REFLEX
    }
  })

  // Dragging is admin-only and never auto-transforms the group: the mesh position
  // is the only transform, so a server update can always be applied directly.
  const dragProps = (t: Target) => ({
    axisLock: 'y' as const,
    autoTransform: false,
    onDragStart: () => {
      const mesh = refs[t].current
      if (!mesh) return
      drag.current.active = t
      drag.current.start.copy(mesh.position)
      if (orbit) orbit.enabled = false
    },
    onDrag: (local: THREE.Matrix4) => {
      const mesh = refs[t].current
      if (!mesh) return
      mesh.position.copy(drag.current.start).add(_p.setFromMatrixPosition(local))
      const now = performance.now()
      if (now - drag.current.sentAt >= DRAG_SEND_MS) {
        drag.current.sentAt = now
        sendProp(t, mesh.position.x, mesh.position.y, mesh.position.z)
      }
    },
    onDragEnd: () => {
      const mesh = refs[t].current
      if (mesh) sendProp(t, mesh.position.x, mesh.position.y, mesh.position.z)
      drag.current.active = null
      drag.current.holdUntil[t] = performance.now() + HOLD_AFTER_DRAG_MS
      if (orbit) orbit.enabled = true
    },
  })

  const start = (t: Target) => (sim.world.props ?? DEFAULTS)[t]
  const meshes = {
    sugar: <group ref={refs.sugar} position={start('sugar')}><PropModel role="sugar" /></group>,
    bitter: <group ref={refs.bitter} position={start('bitter')}><PropModel role="bitter" /></group>,
    threat: <group ref={refs.threat} position={start('threat')}><PropModel role="threat" /></group>,
  }

  return (
    <>
      {TARGETS.map((t) =>
        editable ? (
          <DragControls key={t} {...dragProps(t)}>{meshes[t]}</DragControls>
        ) : (
          <group key={t}>{meshes[t]}</group>
        ),
      )}
    </>
  )
})

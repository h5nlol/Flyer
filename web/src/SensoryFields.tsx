/**
 * Admin debug overlay: the sensory ranges the server actually applies, drawn on
 * the ground.
 *
 *   sugar    outer ring  sensing horizon: odor drive grows as the HEAD moves inside
 *            inner ring  contact reflex: gustatory receptors, MN9 feeding
 *   bitter   outer ring  sensing horizon (smell)
 *            inner ring  contact: bitter receptors, feeding suppression
 *   threat   outer ring  shadow on the loom detectors (capped at 2 Hz, measured never
 *                        to fire an escape); distance from the BODY
 *            inner ring  reflex: repeated loom bursts, giant fiber, escape
 *   fly      sector      the head's sensing reach, front half (bearing saturates at 90 deg)
 *            ring        contact reach around the head
 *
 * Radii come from the server handshake. Food rings are centred on the prop but
 * measured to the fly's head, so a ring marks where the head has to get to.
 * Chemotaxis steering has no radius and is not drawn: in autonomous mode the fly
 * heads for the sugar from any distance.
 *
 * Mounted only in the admin view. Visibility follows `controls.showFields` per
 * frame; geometry is a shared unit circle scaled per ring, so nothing is rebuilt.
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FLOOR_Y, FLY_SCALE } from './chamber'
import { controls } from './controls'
import { sim, type PropName } from './simSocket'

const FALLBACK = { sense: 5.0 * FLY_SCALE, reflex: 1.5 * FLY_SCALE, reflexExit: 1.725 * FLY_SCALE, headAhead: 3.45 * FLY_SCALE }
const GROUND = FLOOR_Y + 0.004 // just above the chamber floor
const COLORS: Record<PropName, { outer: string; inner: string }> = {
  sugar: { outer: '#3fff7a', inner: '#3fff7a' },
  bitter: { outer: '#ff5a5a', inner: '#ff3030' },
  threat: { outer: '#ffb020', inner: '#ff2a2a' },
}
const APEX = '#5ee0b0'
const PROPS = ['sugar', 'bitter', 'threat'] as const

function unitCircle(): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < 128; i++) {
    const a = (i / 128) * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
  }
  return new THREE.BufferGeometry().setFromPoints(pts)
}

const line = (color: string, opacity: number) =>
  new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
const fill = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })

type PropRefs = { group: THREE.Group | null; outer: THREE.LineLoop | null; inner: THREE.LineLoop | null; disc: THREE.Mesh | null }

export function SensoryFields() {
  const root = useRef<THREE.Group>(null)
  const apex = useRef<THREE.Group>(null)
  const apexSector = useRef<THREE.Mesh>(null)
  const apexEdge = useRef<THREE.LineLoop>(null)
  const apexReach = useRef<THREE.LineLoop>(null)
  const refs = useRef<Record<PropName, PropRefs>>({
    sugar: { group: null, outer: null, inner: null, disc: null },
    bitter: { group: null, outer: null, inner: null, disc: null },
    threat: { group: null, outer: null, inner: null, disc: null },
  })

  const assets = useMemo(() => {
    const circle = unitCircle()
    const disc = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2)
    // Front half-disc: centred on +z so a group yawed like the fly points it forward.
    const sector = new THREE.CircleGeometry(1, 48, -Math.PI, Math.PI).rotateX(-Math.PI / 2)
    const sectorEdge = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      ...Array.from({ length: 49 }, (_, i) => {
        const a = -Math.PI / 2 + (i / 48) * Math.PI
        return new THREE.Vector3(Math.sin(a), 0, Math.cos(a))
      }),
    ])
    const mats = Object.fromEntries(PROPS.map((t) => [t, {
      outer: line(COLORS[t].outer, 0.3),
      inner: line(COLORS[t].inner, 0.55),
      disc: fill(COLORS[t].inner, 0.05),
    }])) as Record<PropName, { outer: THREE.LineBasicMaterial; inner: THREE.LineBasicMaterial; disc: THREE.MeshBasicMaterial }>
    return {
      circle, disc, sector, sectorEdge, mats,
      apexFill: fill(APEX, 0.045), apexLine: line(APEX, 0.35), apexReach: line(APEX, 0.5),
    }
  }, [])

  useFrame(() => {
    const g = root.current
    if (!g) return
    const props = sim.status === 'live' ? sim.world.props : null
    g.visible = controls.showFields && props !== null
    if (!g.visible || !props) return
    const f = sim.world.fields ?? FALLBACK

    for (const t of PROPS) {
      const r = refs.current[t]
      if (!r.group || !r.outer || !r.inner || !r.disc) continue
      r.group.visible = t !== 'sugar' || sim.world.sugarPresent // an eaten cube has no field
      const [x, , z] = props[t]
      r.group.position.set(x, GROUND, z)
      r.outer.scale.setScalar(f.sense)
      const inRange = sim.world.inRange[t]
      // In range, the exit threshold (with hysteresis) is the one that applies.
      const reflex = inRange ? f.reflexExit : f.reflex
      r.inner.scale.setScalar(reflex)
      r.disc.scale.setScalar(reflex)
      const m = assets.mats[t]
      m.inner.opacity = inRange ? 1 : 0.55
      m.disc.opacity = inRange ? 0.22 : 0.05
    }

    // The fly's sensing apex, centred on the head and turned with the body.
    const a = apex.current
    if (a && apexSector.current && apexEdge.current && apexReach.current) {
      const body = controls.body
      const head = controls.head
      a.position.set(head.x, GROUND, head.z)
      a.rotation.y = Math.atan2(head.x - body.x, head.z - body.z)
      apexSector.current.scale.setScalar(f.sense)
      apexEdge.current.scale.setScalar(f.sense)
      apexReach.current.scale.setScalar(f.reflex)
    }
  })

  return (
    <group ref={root} visible={false}>
      {PROPS.map((t) => (
        <group key={t} ref={(el) => { refs.current[t].group = el }}>
          <lineLoop ref={(el) => { refs.current[t].outer = el }} geometry={assets.circle} material={assets.mats[t].outer} />
          <lineLoop ref={(el) => { refs.current[t].inner = el }} geometry={assets.circle} material={assets.mats[t].inner} />
          <mesh ref={(el) => { refs.current[t].disc = el }} geometry={assets.disc} material={assets.mats[t].disc} renderOrder={1} />
        </group>
      ))}
      <group ref={apex}>
        <mesh ref={apexSector} geometry={assets.sector} material={assets.apexFill} renderOrder={1} />
        <lineLoop ref={apexEdge} geometry={assets.sectorEdge} material={assets.apexLine} />
        <lineLoop ref={apexReach} geometry={assets.circle} material={assets.apexReach} />
      </group>
    </group>
  )
}

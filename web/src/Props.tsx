/**
 * Custom Blender props standing in for the placeholder primitives.
 *
 *   donut     sugar     base 1.92 x 0.80 x 1.92 -> x0.10: 0.19 wide, about the fly's head span
 *   rock      bitter    base 1.80 x 0.83 x 1.30 -> x0.10: 0.18 wide
 *   tweezers  threat    base 3.66 x 0.28 x 0.37 -> x0.30: 1.10 long, hovering and tipped
 *                       down toward the floor, over the body when deployed
 *
 * Every model's base sits at y = 0, so a prop's position IS its footprint on the
 * floor (the server places food at floorY). Scales are logged once on load so they
 * can be baked into the next Blender export.
 */
import { Suspense, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { PropName } from './simSocket'
import { DRACO, ModelBoundary, withoutImagelessTextures } from './models'

type Profile = {
  url: string
  node: string
  scale: number
  /** local tilt, radians: only the tweezers use it */
  rotation?: [number, number, number]
}

export const PROP_MODELS: Record<PropName, Profile> = {
  sugar: { url: '/models/prop_donut.glb', node: 'prop_donut', scale: 0.1 },
  bitter: { url: '/models/prop_rock.glb', node: 'prop_rock', scale: 0.1 },
  // Tilted 30 degrees about z so one end dips toward the floor; the server hangs the
  // prop above the fly, so the tips point down at it.
  threat: { url: '/models/prop_tweezers.glb', node: 'prop_tweezers', scale: 0.3, rotation: [0, 0, +Math.PI / 6] },
}

for (const p of Object.values(PROP_MODELS)) useGLTF.preload(p.url, DRACO, true, withoutImagelessTextures)

let logged = false
function logScales() {
  if (logged) return
  logged = true
  console.info('[props] visual scale ratios (bake into the next Blender export):',
    Object.fromEntries(Object.entries(PROP_MODELS).map(([role, p]) => [p.node, { role, scale: p.scale, rotation: p.rotation ?? [0, 0, 0] }])))
}

function Model({ profile }: { profile: Profile }) {
  const { scene } = useGLTF(profile.url, DRACO, true, withoutImagelessTextures)

  const object = useMemo(() => {
    logScales()
    const root = scene.getObjectByName(profile.node) ?? scene
    // Clone so a remount (or a second use) never re-applies the material fix-ups.
    const copy = root.clone(true)
    copy.position.set(0, 0, 0)
    copy.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      const fix = (m: THREE.Material): THREE.Material => {
        // prop_rock is exported unlit (KHR_materials_unlit); it has to answer to the
        // chamber lights like everything else in the room.
        if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
          const basic = m as THREE.MeshBasicMaterial
          return new THREE.MeshStandardMaterial({ map: basic.map, color: basic.color, roughness: 0.9, side: THREE.DoubleSide })
        }
        m.side = THREE.DoubleSide
        return m
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material)
    })
    return copy
  }, [scene, profile.node])

  return <primitive object={object} scale={profile.scale} rotation={profile.rotation ?? [0, 0, 0]} />
}

/** A prop model, loaded lazily inside its own Suspense so the rest of the scene never waits on it. */
export function PropModel({ role }: { role: PropName }) {
  const profile = PROP_MODELS[role]
  return (
    <ModelBoundary name={profile.url}>
      <Suspense fallback={null}>
        <Model profile={profile} />
      </Suspense>
    </ModelBoundary>
  )
}

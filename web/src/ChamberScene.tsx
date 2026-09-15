/**
 * The glass test chamber the fly lives in.
 *
 * Normalised once per loaded scene (the GLTF cache hands back the same object on a
 * remount, so the work is flagged on userData and never applied twice):
 *   - KHR_lights_punctual intensities arrive as Blender watts (~16,305 for the
 *     spot/points, ~615 for the sun) and are scaled by 0.001 for three.js.
 *   - `glass_*` panels get light, clean transparency that does not write depth, so
 *     the fly stays visible through them from any angle.
 */
import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { loadChamberBounds } from './chamber'
import { DRACO, ModelBoundary, withoutImagelessTextures } from './models'

const MODEL = '/models/chamber.glb'
const LIGHT_SCALE = 0.001

useGLTF.preload(MODEL, DRACO, true, withoutImagelessTextures)

function isGlass(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    if (n.name.startsWith('glass_')) return true
  }
  return false
}

function ChamberModel() {
  const { scene } = useGLTF(MODEL, DRACO, true, withoutImagelessTextures)

  useMemo(() => {
    if (scene.userData.flyerNormalised) return
    scene.userData.flyerNormalised = true
    const glassMats = new Map<THREE.Material, THREE.Material>()
    scene.traverse((o) => {
      const light = o as THREE.Light
      if (light.isLight) light.intensity *= LIGHT_SCALE

      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.receiveShadow = true
      if (!isGlass(mesh)) return
      const swap = (m: THREE.Material) => {
        let g = glassMats.get(m)
        if (!g) {
          g = m.clone()
          const std = g as THREE.MeshStandardMaterial
          std.transparent = true
          std.opacity = 0.35
          std.depthWrite = false
          if ('roughness' in std) std.roughness = 0.1
          glassMats.set(m, g)
        }
        return g
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
      mesh.castShadow = false
      mesh.renderOrder = 2 // after the opaque fly and props
    })
  }, [scene])

  return <primitive object={scene} />
}

export function Chamber() {
  useEffect(() => {
    void loadChamberBounds()
  }, [])
  return (
    <ModelBoundary name="chamber.glb">
      <ChamberModel />
    </ModelBoundary>
  )
}

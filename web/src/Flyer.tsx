import { useEffect, useMemo, useRef } from 'react'
import { useAnimations, useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { controls, type SceneInfo } from './controls'
import { pumpSim, sim } from './simSocket'
import { FLOOR_Y, FLY_SCALE } from './chamber'
import {
  createGait, sampleRestPose, FRONT_LEGS, GROOM_BONES, GROOM_EASE_S, GROUP_A,
  PARAMS, type BoneMap, type Gait,
} from './gait'

const MODEL = '/models/flyer_web.glb'
const DRACO = '/draco/'
// Per second: how hard the local body is pulled toward the server pose. Slow enough
// that stance feet absorb it, fast enough that viewers converge within a second.
const POSE_RATE = 3

useGLTF.preload(MODEL, DRACO)

/**
 * The 2026-09-12 re-export merged the body and wing material slots into a single
 * `FLYER_baked` with alphaMode BLEND ("Primitives created: 1"). That makes the
 * whole body transparent with depthWrite off, so the mesh renders as an x-ray:
 * triangles are drawn in index order with no depth to sort them.
 *
 * The basecolor alpha is 95% fully opaque (body) and 5% partial (wings), so
 * alpha-to-coverage resolves it correctly and order-independently using the MSAA
 * samples we already pay for -- opaque body, soft wings, correct depth.
 *
 * ponytail: stopgap, not the fix. The fix is re-exporting with the wing material
 * in its own slot; this no-ops as soon as that lands, since it only fires when a
 * single material has to cover both.
 */
function patchMergedMaterial(scene: THREE.Object3D): boolean {
  const mats = new Set<THREE.Material>()
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) mats.add(m.material as THREE.Material)
  })
  if (mats.size !== 1) return false
  const mat = [...mats][0]
  if (!mat.transparent) return false
  mat.transparent = false
  mat.depthWrite = true
  mat.alphaToCoverage = true
  mat.needsUpdate = true
  return true
}

/** Walk the loaded scene once and collect everything the debug panel shows. */
function describe(scene: THREE.Object3D, clips: THREE.AnimationClip[]): SceneInfo {
  const meshes: SceneInfo['meshes'] = []
  const bones: string[] = []
  const materials = new Map<string, THREE.Material>()

  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o.name)
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    meshes.push({
      name: m.name,
      morphTargetDictionary: m.morphTargetDictionary ?? null,
      skinned: !!(m as unknown as THREE.SkinnedMesh).isSkinnedMesh,
      material: (m.material as THREE.Material).name,
    })
    const mat = m.material as THREE.Material
    materials.set(mat.name || mat.uuid, mat)
  })

  // A SkinnedMesh can reference bones that are not descendants of the scene root.
  scene.traverse((o) => {
    const sm = o as THREE.SkinnedMesh
    if (sm.isSkinnedMesh && sm.skeleton) {
      for (const b of sm.skeleton.bones) if (!bones.includes(b.name)) bones.push(b.name)
    }
  })

  return {
    meshes,
    bones,
    clips: clips.map((c) => ({ name: c.name, duration: c.duration })),
    materials: [...materials.values()].map((m) => ({
      name: m.name,
      transparent: m.transparent,
      opacity: m.opacity,
      depthWrite: m.depthWrite,
      side: m.side === THREE.DoubleSide ? 'double' : m.side === THREE.BackSide ? 'back' : 'front',
      alphaTest: m.alphaTest,
    })),
  }
}

const BAR = 24

/** True when every component of a track holds one value for the whole clip. */
function isConstant(track: THREE.KeyframeTrack): boolean {
  const stride = track.getValueSize()
  const n = track.values.length / stride
  for (let k = 0; k < stride; k++) {
    const first = track.values[k]
    for (let i = 1; i < n; i++) {
      if (Math.abs(track.values[i * stride + k] - first) > 1e-6) return false
    }
  }
  return true
}

/** Text tripod chart: A and B should always sit half a cycle apart. */
function formatPhases(gait: Gait, grooming: boolean, headAuthority: number): string {
  let anyClamp = false
  const rows = gait.phases().map(({ id, phase, stance, peakReach, limited }) => {
    const at = Math.min(BAR - 1, Math.floor(phase * BAR))
    const track = Array.from({ length: BAR }, (_, i) => (i === at ? '#' : i / BAR < PARAMS.DUTY ? '=' : '.'))
    const group = GROUP_A.includes(id) ? 'A' : 'B'
    const owned = grooming && FRONT_LEGS.has(id)
    if (limited || peakReach > PARAMS.REACH_LIMIT) anyClamp = true
    const peak = `${(peakReach * 100).toFixed(1)}%`
    return (
      `${id} ${group} |${track.join('')}| ${phase.toFixed(2)} ${stance ? 'stance' : 'swing '}` +
      ` peak ${peak.padStart(6)}${peakReach > PARAMS.REACH_LIMIT ? ' LIMITED' : ''}${owned ? ' <groom>' : ''}`
    )
  })
  const { yaw, escaping } = gait.state()
  rows.push(`     |${'='.repeat(BAR)}|  = stance  . swing  # foot   peak = max reach, of l1+l2`)
  rows.push(
    `body yaw ${(yaw * (180 / Math.PI)).toFixed(1)}deg` +
      `${anyClamp ? `   held at REACH_LIMIT ${(PARAMS.REACH_LIMIT * 100).toFixed(0)}%` : '   no leg near its limit'}` +
      `${escaping ? '   ESCAPE overriding foraging' : ''}` +
      `${grooming || headAuthority < 1
        ? `   groom owns front limbs + head (head morphs at ${(headAuthority * 100).toFixed(0)}%)`
        : ''}`,
  )
  return rows.join('\n')
}

export function Flyer({ onInfo }: { onInfo: (info: SceneInfo) => void }) {
  const group = useRef<THREE.Group>(null)
  const { scene, animations } = useGLTF(MODEL, DRACO)

  // Groom clips key all 28 bones, so playing one used to mean freezing the whole
  // gait. Dropping the tracks a groom has no business driving is the cheaper half
  // of the fix: the mixer then physically cannot reach the other four legs or the
  // body, so there is no per-frame arbitration and the stock mixer stays stock.
  const maskedClips = useMemo(
    () =>
      animations.map((clip) => {
        const masked = clip.clone()
        masked.tracks = clip.tracks.filter((t) => {
          if (!GROOM_BONES.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName ?? '')) return false
          // Drop tracks that never change value: they only pin a bone the clip
          // does not actually animate. Measured, not assumed by name -- neck is
          // constant in both clips, but head.quaternion really does move in
          // groom_face (delta 0.447) as the head tilts into the hands.
          return !isConstant(t)
        })
        return masked
      }),
    [animations],
  )

  const { actions } = useAnimations(maskedClips, group)

  // Which clips actually drive the head, measured from the masked tracks rather
  // than assumed: groom_face keys head.quaternion, groom_hands does not. Only a
  // clip that really owns the head should take the head morphs away.
  const headClips = useMemo(
    () =>
      new Set(
        maskedClips
          .filter((c) =>
            c.tracks.some((t) => THREE.PropertyBinding.parseTrackName(t.name).nodeName === 'head'),
          )
          .map((c) => c.name),
      ),
    [maskedClips],
  )

  // Skinned meshes keep the bounding sphere of their bind pose, near the origin.
  // The gait moves the root bone far from there, so once the fly has walked a few
  // units the sphere no longer overlaps the view and three culls a body that is
  // plainly on screen. Culling a single mesh saves nothing worth that.
  useMemo(() => {
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false
    })
  }, [scene])

  // Every mesh carrying each morph name, so one slider drives all primitives.
  const morphTargets = useMemo(() => {
    const byName = new Map<string, { mesh: THREE.Mesh; index: number }[]>()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || !m.morphTargetDictionary) return
      for (const [name, index] of Object.entries(m.morphTargetDictionary)) {
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name)!.push({ mesh: m, index })
      }
    })
    return byName
  }, [scene])

  const [rootBone, headBone] = useMemo(() => {
    let root: THREE.Object3D | null = null
    let head: THREE.Object3D | null = null
    scene.traverse((o) => {
      if (o.name === 'root') root = o
      if (o.name === 'head') head = o
    })
    return [root as THREE.Object3D | null, head as THREE.Object3D | null]
  }, [scene])

  // Built once per loaded scene: the rest pose is sampled before anything has
  // had a chance to move, so it stays the reference the gait solves against.
  const gait = useMemo<Gait | null>(() => {
    const bones: BoneMap = {}
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name] = o
    })
    if (!bones.root) return null
    try {
      return createGait(bones, sampleRestPose(bones))
    } catch (err) {
      console.error('gait disabled:', err)
      return null
    }
  }, [scene])

  // The describe/report pass must run once per loaded scene. It used to re-run on
  // every render: onInfo -> setInfo -> re-render -> effect -> onInfo, which spun up
  // a fresh Draco decoder each pass and never settled.
  const reportedFor = useRef<THREE.Object3D | null>(null)

  useEffect(() => {
    controls.play = (name, loop) => {
      const action = actions[name]
      if (!action) return
      action.reset()
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
      action.clampWhenFinished = !loop
      action.fadeIn(0.2).play()
    }
    controls.stopAll = () => Object.values(actions).forEach((a) => a?.fadeOut(0.2).stop())
    controls.resetBody = () => gait?.reset()
    controls.resetGaitPhases = () => gait?.resetPhases()
    controls.isPlaying = (name) => !!actions[name]?.isRunning()
    // dev-only handle for poking at live state from the console
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__flyer = { controls, gait, PARAMS }

    if (reportedFor.current === scene) return
    reportedFor.current = scene

    const patched = patchMergedMaterial(scene)
    const info = describe(scene, animations)
    controls.morphNames = [...morphTargets.keys()]
    controls.clipNames = info.clips.map((c) => c.name)
    /* eslint-disable no-console */
    console.group('%cflyer_web.glb', 'font-weight:bold')
    console.log('meshes', info.meshes)
    console.table(info.meshes.map((m) => ({
      mesh: m.name,
      skinned: m.skinned,
      material: m.material,
      morphs: m.morphTargetDictionary ? Object.keys(m.morphTargetDictionary).join(', ') : '-',
    })))
    console.log('morphTargetDictionary per mesh:',
      Object.fromEntries(info.meshes.map((m) => [m.name, m.morphTargetDictionary])))
    console.log(`bones (${info.bones.length})`, info.bones)
    console.log(`animations (${info.clips.length})`, info.clips)
    console.log('materials', info.materials)
    if (patched) console.warn('merged body+wing material detected -- alphaToCoverage stopgap applied')
    console.log('groom clips masked to', [...GROOM_BONES].join(', '))
    console.table(maskedClips.map((c, i) => ({
      clip: c.name,
      tracksBefore: animations[i].tracks.length,
      tracksAfter: c.tracks.length,
    })))
    if (gait) console.log('gait axes (root space)', {
      forward: gait.axes.forward.toArray().map((v) => +v.toFixed(3)),
      left: gait.axes.left.toArray().map((v) => +v.toFixed(3)),
      up: gait.axes.up.toArray().map((v) => +v.toFixed(3)),
      track: +gait.axes.track.toFixed(3),
      segments: Object.fromEntries(gait.legs.map((l) => [l.id, [+l.l1.toFixed(3), +l.l2.toFixed(3)]])),
    })
    console.groupEnd()
    /* eslint-enable no-console */

    onInfo(info)
  }, [scene, animations, maskedClips, headClips, actions, morphTargets, gait, onInfo])

  // ponytail: refs mutated in place every frame. `controls` is a plain module
  // object the sliders write to directly -- no React state on the hot path.
  const readoutAt = useRef(0)
  const groomBlend = useRef(0)
  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 20) // a tab regaining focus must not teleport the gait

    // Ease `controls` toward whatever the sim last sent. No-op when the socket is
    // down, which is what leaves the debug sliders in charge.
    pumpSim(dt)

    // Same arbitration as the bone mask, one layer up: a groom clip owns the head
    // pose while it plays, the sim owns it otherwise. The clips were authored
    // against a neutral head, so a yawed head turns the face out from under the
    // hands. Ease rather than snap, or the head jumps on every clip start/stop.
    const grooming = Object.values(actions).some((a) => a?.isRunning())
    // Head authority is surrendered only to a clip that keys the head, so a
    // hands-only groom leaves the head under whatever is driving it.
    const headClipRunning = [...headClips].some((n) => actions[n]?.isRunning())
    const target = headClipRunning ? 1 : 0
    const step = dt / GROOM_EASE_S
    groomBlend.current = target > groomBlend.current
      ? Math.min(target, groomBlend.current + step)
      : Math.max(target, groomBlend.current - step)
    const b = groomBlend.current
    const headAuthority = 1 - b * b * (3 - 2 * b) // smoothstep, 1 = sim, 0 = clip

    // Head yaw/pitch are one signed value each; only one morph of a pair is ever
    // active, so opposing shapes can never blend into each other. mouth_open and
    // tongue_out are deliberately untouched -- they do not move the face around.
    const { headYaw: yaw, headPitch: pitch } = controls
    controls.morphs.head_left = Math.max(0, yaw) * headAuthority
    controls.morphs.head_right = Math.max(0, -yaw) * headAuthority
    controls.morphs.head_up = Math.max(0, pitch) * headAuthority
    controls.morphs.head_down = Math.max(0, -pitch) * headAuthority

    for (const [name, slots] of morphTargets) {
      const v = controls.morphs[name] ?? 0
      for (const { mesh, index } of slots) {
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = v
      }
    }

    // Where the fly is, for the camera rig and loom gesture. getWorldPosition
    // writes into the existing vectors: no allocation per frame.
    rootBone?.getWorldPosition(controls.body)
    headBone?.getWorldPosition(controls.head)

    if (!gait) return
    // The clip owns the front limbs and head; the other four legs keep walking
    // and every phase keeps advancing, so the tripod is still in step when the
    // groom ends.
    gait.update(controls.drives, dt, grooming ? FRONT_LEGS : undefined)

    // The server owns where the body is. Extrapolate its last pose to now and ease
    // toward it, so every viewer's fly stands in the same place.
    const pose = sim.status === 'live' ? sim.world.fly : null
    if (pose) {
      const age = Math.min((performance.now() - pose.at) / 1000, 0.5)
      gait.correct(pose.x + pose.vx * age, controls.body.y, pose.z + pose.vz * age,
        pose.yaw + pose.vyaw * age, 1 - Math.exp(-POSE_RATE * dt))
    }

    const now = performance.now()
    if (controls.phaseEl && now - readoutAt.current > 90) {
      readoutAt.current = now
      controls.phaseEl.textContent = formatPhases(gait, grooming, headAuthority)
    }
  })

  // Scaled to the chamber and stood on its floor (the mesh's lowest vertex is y = 0).
  // The gait works in rig units underneath; only this wrapper knows the scale.
  return (
    <group scale={FLY_SCALE} position={[0, FLOOR_Y, 0]}>
      <primitive ref={group} object={scene} />
    </group>
  )
}

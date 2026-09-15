import * as THREE from 'three'
import type { Drives } from './gait'

/**
 * Mutable control state, read in useFrame and written by the sliders.
 *
 * ponytail: a plain module object, not a store. Nothing here should ever cause
 * a re-render -- that is the whole point. zustand is installed for the sim
 * state that arrives in a later phase; using it here would just add a
 * subscription on the hot path.
 */
export const controls = {
  /** morph name -> influence. Head morphs are written each frame from headYaw/headPitch. */
  morphs: {} as Record<string, number>,
  /** signed -1..1; split into the head_left/head_right and head_up/head_down pairs */
  headYaw: 0,
  headPitch: 0,
  /** stand-ins for the firing rates the sim will supply later */
  drives: { dnp09: 0, mdn: 0, dna_l: 0, dna_r: 0 } as Drives,
  morphNames: [] as string[],
  clipNames: [] as string[],
  /** <pre> the gait writes leg phases into, bypassing React entirely */
  phaseEl: null as HTMLElement | null,
  resetBody: () => {},
  /** snap the tripod back to its start, body untouched (escape reflex) */
  resetGaitPhases: () => {},
  /**
   * World positions written by Flyer every frame and read by the camera rig and
   * the loom gesture. Mutated in place, never replaced.
   */
  body: new THREE.Vector3(),
  head: new THREE.Vector3(),
  /** 1 follow orbit, 2 head macro, 3 free orbit */
  cameraMode: 1 as 1 | 2 | 3,
  /** admin overlay: sensory range rings around props and the fly's head */
  showFields: false,
  /** true while the sim is choosing behaviour; the manual drive sliders stand down */
  autonomous: false,
  play: (_name: string, _loop: boolean) => {},
  /** is an animation clip currently running? */
  isPlaying: (_name: string) => false,
  stopAll: () => {},
}

/** Driven indirectly by the yaw/pitch sliders, so they get no slider of their own. */
export const HEAD_MORPHS = ['head_up', 'head_down', 'head_left', 'head_right']

export type SceneInfo = {
  meshes: {
    name: string
    morphTargetDictionary: Record<string, number> | null
    skinned: boolean
    material: string
  }[]
  bones: string[]
  clips: { name: string; duration: number }[]
  materials: {
    name: string
    transparent: boolean
    opacity: number
    depthWrite: boolean
    side: string
    alphaTest: number
  }[]
}

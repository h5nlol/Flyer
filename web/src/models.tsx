/**
 * Shared GLB loading for the scene models (chamber and props).
 *
 * - `withoutImagelessTextures`: some Blender exports write a texture entry with no
 *   image (chamber.glb texture 22, prop_tweezers.glb texture 1). The loader reads the
 *   missing image and fails the whole file; this drops those references before the
 *   parse.
 * - `ModelBoundary`: a model that fails to load renders nothing instead of taking the
 *   canvas (and the sim) down with it.
 */
import { Component, type ReactNode } from 'react'
import type { GLTFLoader } from 'three-stdlib'

export const DRACO = '/draco/'

type TexRef = { index?: number }
type GltfJson = {
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[]
  materials?: Record<string, unknown>[]
}

export function withoutImagelessTextures(loader: GLTFLoader) {
  loader.register((parser) => ({
    name: 'flyer_imageless_textures',
    beforeRoot() {
      const json = (parser as unknown as { json: GltfJson }).json
      const textures = json.textures ?? []
      const hasImage = (i: number) => {
        const t = textures[i]
        return !!t && (t.source !== undefined || Object.values(t.extensions ?? {}).some((e) => e?.source !== undefined))
      }
      const scrub = (o: unknown): void => {
        if (!o || typeof o !== 'object') return
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          const ref = v as TexRef
          if (k.endsWith('Texture') && ref && typeof ref.index === 'number' && !hasImage(ref.index)) {
            console.warn(`GLB: dropped ${k} -> texture ${ref.index} (no image)`)
            delete (o as Record<string, unknown>)[k]
          } else scrub(v)
        }
      }
      for (const m of json.materials ?? []) scrub(m)
      return null
    },
  }) as never)
}

export class ModelBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.error(`${this.props.name} failed to load; continuing without it:`, err)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

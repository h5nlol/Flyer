/**
 * Full-screen loading overlay for the 3D assets.
 *
 * Raw CSS over the canvas, no UI library. `useProgress` is drei's hook over
 * three's DefaultLoadingManager, so it works outside <Canvas> -- this sits beside
 * it in the DOM rather than inside the scene graph.
 *
 * It tracks what the loading manager sees: the GLB and its textures. The brain
 * scan's .bin files are plain fetches and are not counted, which is fine -- they
 * stream in behind the overlay and the point cloud simply appears.
 */
import { useEffect, useRef, useState } from 'react'
import { useProgress } from '@react-three/drei'

const FADE_MS = 700
// Cached assets can finish in under a frame. Dismissing that fast makes the
// overlay flash like a glitch, so hold it briefly before fading.
const MIN_SHOW_MS = 900

export function Loader() {
  const { progress, active } = useProgress()
  const [done, setDone] = useState(false)
  const [gone, setGone] = useState(false)
  const started = useRef(performance.now())

  useEffect(() => {
    if (progress < 100 || active) return
    const wait = Math.max(0, MIN_SHOW_MS - (performance.now() - started.current))
    const fade = setTimeout(() => setDone(true), wait)
    const drop = setTimeout(() => setGone(true), wait + FADE_MS)
    return () => {
      clearTimeout(fade)
      clearTimeout(drop)
    }
  }, [progress, active])

  if (gone) return null
  const pct = Math.min(100, Math.round(progress))

  return (
    <div className={`loader${done ? ' loader-done' : ''}`}>
      <div className="loader-inner">
        <div className="loader-title">FLYER</div>
        <div className="loader-sub">INITIALIZING BIOLOGICAL ASSETS</div>
        <div className="loader-bar">
          <div className="loader-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="loader-pct">{pct}%</div>
        <div className="loader-note">FAFB v783 connectome · 139,255 neurons</div>
      </div>
    </div>
  )
}

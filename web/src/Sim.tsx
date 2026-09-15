import { Suspense, useCallback, useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, OrbitControls } from '@react-three/drei'
import { Flyer } from './Flyer'
import { CameraRig } from './CameraRig'
import { Environment as TargetEnvironment } from './Environment'
import { Chamber } from './ChamberScene'
import { ZOOM_LIMITS } from './CameraRig'
import { SensoryFields } from './SensoryFields'
import { BrainScan } from './BrainScan'
import { CortexHUD } from './CortexHUD'
import { Loader } from './Loader'
import { PublicUI } from './PublicUI'
import { EventChip } from './EventChip'
import { isAdmin } from './admin'
import { DebugPanel } from './DebugPanel'
import type { SceneInfo } from './controls'
import { connectSim, disconnectSim } from './simSocket'
import './App.css'

export default function Sim() {
  const [info, setInfo] = useState<SceneInfo | null>(null)
  // Evaluated once per mount. Only ?admin=true gets the debug panel; everyone
  // else gets the scene, the cortex feed, the brain scan and the intent panel.
  const [admin] = useState(isAdmin)
  const onInfo = useCallback((i: SceneInfo) => setInfo(i), [])

  // The sim is optional: if nothing is listening on 8765 this retries quietly in
  // the background and the debug sliders keep driving the fly.
  useEffect(() => {
    connectSim()
    return disconnectSim
  }, [])

  return (
    <div className={admin ? 'app' : 'app app-public'}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: admin ? [1.1, 1.2, 1.3] : [0.8, 0.9, 1.0], fov: 40, near: 0.005, far: 60 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#2a2d32']} />

        {/* studio: key / fill / rim over a soft environment.
            Must stay inside a Suspense INSIDE the canvas: the preset suspends while
            its HDR loads, and a suspension that escapes to the route-level Suspense
            in App.tsx hides the whole sim, which runs the canvas cleanup, disposes
            the renderer ("Context Lost") and leaves a white canvas. */}
        <Suspense fallback={null}>
          <Environment preset="studio" environmentIntensity={0.35} />
        </Suspense>
        {/* The chamber brings its own lights (normalised in Chamber.tsx); this stands in
            for the world lighting Blender did not export. */}
        <hemisphereLight args={['#ffffff', '#222233', 0.35]} />

        <Suspense fallback={null}>
          <Chamber />
        </Suspense>

        <Suspense fallback={null}>
          {/* No <Bounds>: framing is the tracking camera's job now, and a one-shot
              fit would fight the rig's first few frames. */}
          <Flyer onInfo={onInfo} />
        </Suspense>

        {admin ? (
          // min/maxDistance are left wide on purpose: the camera rig enforces zoom
          // limits itself and dollies in at the glass, and a controls-side minimum
          // would push the camera back out through the wall every frame.
          <OrbitControls makeDefault target={[0, 0.2, 0]} minDistance={0.01} maxDistance={ZOOM_LIMITS.admin[1]} />
        ) : (
          // Public: orbit around the fly, never pan off it. Zoom limits and the
          // dolly-in at the glass are enforced by CameraRig (ZOOM_LIMITS.public); the
          // start pose is ~1.5 units out. The target follows the body every frame.
          <OrbitControls
            makeDefault
            target={[0, 0.2, 0]}
            enablePan={false}
            enableRotate
            enableDamping
            dampingFactor={0.08}
            minDistance={0.01}
            maxDistance={ZOOM_LIMITS.public[1]}
          />
        )}
        <CameraRig locked={!admin} />
        <TargetEnvironment editable={admin} />
        {/* Admin-only: never mounted for spectators, not merely hidden. */}
        {admin && <SensoryFields />}
      </Canvas>

      <div className="loom-flash" id="loom-flash" />
      <CortexHUD />
      <EventChip />
      {!admin && <PublicUI />}
      <BrainScan />
      <Loader />
      {admin && <DebugPanel info={info} />}
    </div>
  )
}

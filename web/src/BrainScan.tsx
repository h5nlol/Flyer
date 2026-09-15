/**
 * Picture-in-picture brain scan: all 139,255 neurons of FAFB v783 at their real
 * positions, lighting up as they fire.
 *
 * A separate, CSS-positioned <Canvas> rather than a <View> or <Hud> inside the
 * main scene: the brain has its own camera, lighting-free shader and blending, and
 * isolating it means toggling it can stop its render loop outright instead of
 * leaving it in the main scene's frame budget.
 *
 * It is kept mounted while hidden. Unmounting a Canvas throws away its WebGL
 * context, and browsers cap live contexts -- repeated toggling would eventually
 * leave the page unable to render at all.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { attachBrain, brain, nowSeconds, onBrainVisible } from './brainData'

const VERT = /* glsl */ `
  attribute float aFire;
  attribute float aAlive;
  attribute float aClass;
  uniform float uTime;
  uniform float uDecay;
  uniform float uSize;
  uniform float uPixelRatio;
  varying float vAct;
  varying float vClass;
  varying float vAlive;
  void main() {
    vClass = aClass;
    vAlive = aAlive;
    vAct = exp(-max(uTime - aFire, 0.0) / uDecay);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float shown = 1.0 - step(254.5, aClass);   // class 255 = no geometry
    gl_PointSize = shown * uSize * uPixelRatio * (1.0 + 2.2 * vAct) / -mv.z;
  }
`

const FRAG = /* glsl */ `
  varying float vAct;
  varying float vClass;
  varying float vAlive;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = dot(c, c);
    if (r > 0.25) discard;
    float soft = 1.0 - r * 4.0;

    // firing colour by transmitter class: unknown, excitatory, inhibitory, modulatory
    vec3 fire = vClass < 0.5 ? vec3(0.85, 0.9, 1.0)
              : vClass < 1.5 ? vec3(0.15, 1.0, 0.35)
              : vClass < 2.5 ? vec3(1.0, 0.15, 0.85)
              :                vec3(1.0, 0.72, 0.15);
    vec3 rest = vec3(0.32, 0.42, 0.62);

    vec3 col = mix(rest, fire, vAct);
    float a = mix(0.03, 0.95, vAct) * soft;
    if (vAlive < 0.5) {            // ablated: a dim dead-red ghost
      col = vec3(0.55, 0.04, 0.04);
      a = 0.05 * soft;
    }
    gl_FragColor = vec4(col, a);
  }
`

function BrainCloud() {
  const group = useRef<THREE.Group>(null)
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uDecay: { value: 0.35 },
          uSize: { value: 5.5 },
          uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/models/brain_coords.bin').then((r) => r.arrayBuffer()),
      fetch('/models/brain_class.bin').then((r) => r.arrayBuffer()),
    ]).then(([coordBuf, classBuf]) => {
      if (cancelled) return
      const pos = new Float32Array(coordBuf)
      const n = pos.length / 3
      const cls = new Float32Array(new Uint8Array(classBuf))
      const fire = new Float32Array(n).fill(-1e6) // "fired long ago": dark at start
      const alive = new Float32Array(n).fill(1)

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('aClass', new THREE.BufferAttribute(cls, 1))
      const fireAttr = new THREE.BufferAttribute(fire, 1).setUsage(THREE.DynamicDrawUsage)
      const aliveAttr = new THREE.BufferAttribute(alive, 1).setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aFire', fireAttr)
      geo.setAttribute('aAlive', aliveAttr)
      // The cloud is normalised into a 2-unit box, so the bounds are known; setting
      // them skips a 139k-vertex scan.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.25)

      attachBrain(n, fire, alive, fireAttr, aliveAttr)
      setGeometry(geo)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useFrame((_, rawDelta) => {
    material.uniforms.uTime.value = nowSeconds()
    if (group.current) group.current.rotation.y += Math.min(rawDelta, 0.05) * 0.22
  })

  return (
    <group ref={group}>
      {geometry && <points geometry={geometry} material={material} frustumCulled={false} />}
    </group>
  )
}

export function BrainScan() {
  const [visible, setVisible] = useState(true)
  const hud = useRef<HTMLDivElement>(null)

  useEffect(() => onBrainVisible(setVisible), [])

  useEffect(() => {
    const id = setInterval(() => {
      if (!hud.current) return
      hud.current.textContent =
        `${brain.aliveCount.toLocaleString()} neurons` +
        (brain.n && brain.aliveCount < brain.n
          ? `  (${(brain.n - brain.aliveCount).toLocaleString()} ablated)`
          : '') +
        `   ${brain.firing.toLocaleString()} firing`
    }, 150)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="brain-pip" style={{ display: visible ? 'block' : 'none' }}>
      <div className="brain-title">
        BRAIN SCAN <span>FAFB v783</span>
      </div>
      <Canvas
        frameloop={visible ? 'always' : 'never'}
        dpr={[1, 1.5]}
        camera={{ position: [0, 0.35, 3.3], fov: 36, near: 0.05, far: 20 }}
        gl={{ antialias: false, alpha: false }}
      >
        <color attach="background" args={['#05070b']} />
        <BrainCloud />
      </Canvas>
      <div className="brain-hud" ref={hud} />
      <div className="brain-legend">
        <i className="exc" /> exc <i className="inh" /> inh <i className="mod" /> mod{' '}
        <i className="dead" /> ablated
      </div>
    </div>
  )
}

/**
 * Procedural tripod gait with closed-form 2-bone IK.
 *
 * Pure maths over a bone map -- no React, no three.js scene assumptions beyond
 * Object3D transforms. `update()` is called once per frame from useFrame and
 * mutates bone quaternions/positions in place.
 *
 * Frames used here:
 *   "root space"  = the local space of the `root` bone, i.e. the body frame.
 *                   Every coxa is a direct child of root, so a coxa's rest
 *                   translation is already a root-space position.
 *   "coxa space"  = the space the femur's local transform lives in.
 *
 * Body axes are derived from the coxa layout rather than hardcoded: this rig is
 * visibly asymmetric (bl femur 2.29 vs br 1.58) and there is no guarantee a
 * re-export keeps the same axis convention.
 */
import * as THREE from 'three'

export const LEGS = ['fl', 'fr', 'ml', 'mr', 'bl', 'br'] as const
export type LegId = (typeof LEGS)[number]

/** Tripod grouping: A and B alternate, B offset half a cycle. */
export const GROUP_A: LegId[] = ['fl', 'mr', 'bl']
export const GROUP_B: LegId[] = ['fr', 'ml', 'br']

/** How long the head morphs take to fade out of / back into a groom, in seconds. */
export const GROOM_EASE_S = 0.15

/** Limbs a groom clip takes over; the gait leaves these alone while it plays. */
export const FRONT_LEGS: ReadonlySet<LegId> = new Set<LegId>(['fl', 'fr'])

/**
 * The only bones a groom clip is allowed to drive. Every other track is dropped
 * from the clip at load, which is what lets the remaining four legs keep walking
 * through a groom. `root` is deliberately excluded: the gait owns body travel.
 */
export const GROOM_BONES: ReadonlySet<string> = new Set([
  'head',
  'neck',
  ...[...FRONT_LEGS].flatMap((id) => [`coxa_${id}`, `femur_${id}`, `tibia_${id}`, `hand_${id}`]),
])

export type Drives = {
  dnp09: number // 0..1 forward walk
  mdn: number // 0..1 backward walk
  dna_l: number // 0..1 left steering
  dna_r: number // 0..1 right steering
  /** second control layer: -1 walk backward .. +1 forward, added to dnp09 */
  cortex_forward?: number
  /** second control layer: -1 steer left .. +1 right, added to the DNa drives */
  cortex_lateral?: number
  /** feeding brake from the server: forward and steering suppressed, escape still allowed */
  brake?: boolean
}

/**
 * ponytail: every one of these is a tuning knob, not a derived truth. A gait
 * that looks right is fitted by eye against a body whose proportions the maths
 * cannot see -- leave them reachable.
 */
export const PARAMS = {
  /**
   * Scales (dnp09 - mdn) into stride frequency. Because `travel` below is derived
   * from the same dPhase, raising this speeds the gait clock and the translation
   * by the same factor -- the feet keep their grip and nothing skates.
   */
  MAX_SPEED: 2.17, // with STRIDE_LENGTH 0.30: 2.39 u/s at full drive, 1.3x the original baseline
  /**
   * Backward drive above this takes the body outright. Without it the escape and
   * the forage cancel in `dnp09 - mdn` and the fly freezes on the spot exactly
   * when it should be fleeing.
   */
  ESCAPE_OVERRIDE: 0.15,
  /**
   * Stride multiplier for any backward walking -- an escape, or the cortex
   * reversing. Reverse has less reach headroom than forward (the rest pose sits
   * nearer its backward limit), so a full-length reverse stride slides. Shortening
   * the stride and raising the step frequency by the same factor leaves ground
   * speed and the non-skating identity untouched.
   */
  REVERSE_STRIDE: 0.75,
  STRIDE_FREQ: 2.2, // cycles per second at full drive
  /**
   * Fore-aft foot travel per stance. Bounded by the reach envelope, not by taste:
   * at 0.5 the back-left leg (the longest femur, and the closest to full extension
   * at rest) asks for 101% of its reach in late stance, gets held at REACH_LIMIT
   * and slides. At 1/240 s sampling, 0.42 still spends 8.8% of leg-frames at the
   * limit (5.6% slip); 0.30 is at 1.2% (0.8% forward, 0.04% reverse). Ground speed
   * is held by raising MAX_SPEED in proportion, so the step rate goes up instead.
   */
  STRIDE_LENGTH: 0.30,
  DUTY: 0.6, // fraction of the cycle spent in stance
  LIFT: 0.13, // peak swing height, scaled with the stride
  STEER_K: 0.85, // stride shortening at full steering drive
  /**
   * Cap on how far a foot target may sit from the femur head, as a fraction of
   * l1+l2. The neutral stance is already 92-93% extended, so fore-aft travel plus
   * swing lift can ask for more than the leg has -- fr requests 100.1% at full
   * drive. Letting that hit the geometric limit locks the knee dead straight,
   * which reads as broken; stopping a little short keeps a visible bend and the
   * shortfall is under a millimetre of body width.
   */
  REACH_LIMIT: 0.97,
  BOB: 0.07, // body rise/fall amplitude, twice per cycle
  /**
   * Fraction of the rest foot's horizontal offset kept as the neutral stance.
   * Back to 1 (no tuck) now that the bind pose ships bent knees: 135 degrees on
   * all six, 92-93% extension, which leaves the solver real headroom. It only
   * ever existed to work around a near-straight bind pose.
   */
  CROUCH: 1.0,
}

export type BoneMap = Record<string, THREE.Object3D>

export type RestPose = Record<string, { position: THREE.Vector3; quaternion: THREE.Quaternion }>

/** Snapshot every bone's rest transform. Call once, right after load. */
export function sampleRestPose(bones: BoneMap): RestPose {
  const rest: RestPose = {}
  for (const [name, bone] of Object.entries(bones)) {
    rest[name] = { position: bone.position.clone(), quaternion: bone.quaternion.clone() }
  }
  return rest
}

const Y = new THREE.Vector3(0, 1, 0)

// Beyond these the local body is not "a bit off", it is somewhere else entirely.
const SNAP_DISTANCE = 2.5
const SNAP_YAW = 0.8

type LegRig = {
  id: LegId
  femur: THREE.Object3D
  tibia: THREE.Object3D
  /** femur and tibia segment lengths, read from the rest pose */
  l1: number
  l2: number
  /** femur head, in coxa space */
  origin: THREE.Vector3
  restFemurQ: THREE.Quaternion
  restTibiaQ: THREE.Quaternion
  /** rest chain orientation in coxa space */
  restFemurDir: THREE.Vector3
  restTibiaDir: THREE.Vector3
  /** knee-out direction in coxa space: keeps the solver bending the way the artist posed it */
  pole: THREE.Vector3
  /** neutral foot position, in root space */
  restFoot: THREE.Vector3
  rootToCoxa: THREE.Matrix4
  /** +1 left, -1 right -- which steering drive shortens this leg's stride */
  side: 1 | -1
  phase: number
  /** live telemetry: requested |target - origin| as a fraction of l1+l2 */
  reach: number
  peakReach: number
  /** the request was outside REACH_LIMIT and got held back */
  limited: boolean
  /** stance foot locked here, in the root bone's parent space (the world, as far as the gait is concerned) */
  pin: THREE.Vector3
  pinned: boolean
  /** where the foot left the ground, in root space: swing starts here, not at the nominal stride end */
  liftoff: THREE.Vector3
  lifted: boolean
}

export type Gait = ReturnType<typeof createGait>

export function createGait(bones: BoneMap, rest: RestPose) {
  const root = bones.root
  if (!root) throw new Error('gait: no `root` bone')

  // ---- body axes, derived from where the coxae actually sit in root space ----
  const coxa = (id: LegId) => rest[`coxa_${id}`].position
  const mean = (ids: LegId[]) =>
    ids.reduce((a, id) => a.add(coxa(id)), new THREE.Vector3()).divideScalar(ids.length)

  const forward = mean(['fl', 'fr']).sub(mean(['bl', 'br'])).normalize()
  const left = mean(['fl', 'ml', 'bl']).sub(mean(['fr', 'mr', 'br'])).normalize()
  // re-orthogonalise: the two means are not exactly perpendicular on a hand-made rig
  const up = new THREE.Vector3().crossVectors(left, forward).normalize()
  left.crossVectors(forward, up).normalize()

  /** lateral half-spread of the coxae: the lever arm turning stride difference into yaw */
  const track =
    LEGS.reduce((a, id) => a + Math.abs(coxa(id).dot(left)), 0) / LEGS.length

  // ---- per-leg IK setup ----
  const legs: LegRig[] = LEGS.map((id) => {
    const femur = bones[`femur_${id}`]
    const tibia = bones[`tibia_${id}`]
    const rf = rest[`femur_${id}`]
    const rt = rest[`tibia_${id}`]
    const rh = rest[`hand_${id}`]
    if (!femur || !tibia || !rf || !rt || !rh) throw new Error(`gait: leg ${id} incomplete`)

    const l1 = rt.position.length() // femur head -> tibia head
    const l2 = rh.position.length() // tibia head -> foot

    const restFemurDir = Y.clone().applyQuaternion(rf.quaternion)
    const chainQ = rf.quaternion.clone().multiply(rt.quaternion)
    const restTibiaDir = Y.clone().applyQuaternion(chainQ)

    const origin = rf.position.clone()
    const knee = origin.clone().addScaledVector(restFemurDir, l1)
    const foot = knee.clone().addScaledVector(restTibiaDir, l2)

    // knee offset from the straight line origin->foot, i.e. which way this knee bends
    const straight = foot.clone().sub(origin).normalize()
    const pole = knee.clone().sub(origin)
    pole.addScaledVector(straight, -pole.dot(straight))
    // On a near-straight rest leg the knee offset is numerically noise; an
    // insect knee points up and out, so that is the honest fallback.
    if (pole.length() < 0.02 * l1) pole.copy(up)
    pole.normalize()

    const rc = rest[`coxa_${id}`]
    const coxaToRoot = new THREE.Matrix4().compose(rc.position, rc.quaternion, new THREE.Vector3(1, 1, 1))

    // Neutral stance, in root space: pull the foot horizontally toward its own
    // coxa so the knee has something to bend, leaving the height untouched.
    const footRoot = foot.clone().applyMatrix4(coxaToRoot)
    const v = footRoot.clone().sub(rc.position)
    const vUp = up.clone().multiplyScalar(v.dot(up))
    const restFoot = rc.position.clone().add(vUp).addScaledVector(v.sub(vUp), PARAMS.CROUCH)

    return {
      id,
      femur,
      tibia,
      l1,
      l2,
      origin,
      restFemurQ: rf.quaternion.clone(),
      restTibiaQ: rt.quaternion.clone(),
      restFemurDir,
      restTibiaDir,
      pole,
      restFoot,
      rootToCoxa: coxaToRoot.clone().invert(),
      side: (coxa(id).dot(left) > 0 ? 1 : -1) as 1 | -1,
      phase: GROUP_B.includes(id) ? 0.5 : 0,
      reach: 0,
      peakReach: 0,
      limited: false,
      pin: new THREE.Vector3(),
      pinned: false,
      liftoff: new THREE.Vector3(),
      lifted: false,
    }
  })

  // ---- body state, integrated in the rig space the root bone lives in ----
  const restRootPos = rest.root.position.clone()
  const restRootQ = rest.root.quaternion.clone()
  const yawAxis = up.clone().applyQuaternion(restRootQ).normalize()
  const forwardRig = forward.clone().applyQuaternion(restRootQ)
  const upRig = up.clone().applyQuaternion(restRootQ)

  let yaw = 0
  let escaping = false
  const offset = new THREE.Vector3()

  // scratch, reused every frame -- no per-frame allocation on the hot path
  const _target = new THREE.Vector3()
  const _p = new THREE.Vector3()
  const _u = new THREE.Vector3()
  const _v = new THREE.Vector3()
  const _dir = new THREE.Vector3()
  const _fwd = new THREE.Vector3()
  const _knee = new THREE.Vector3()
  const _q = new THREE.Quaternion()
  const _q2 = new THREE.Quaternion()
  const _heading = new THREE.Quaternion()
  const _rootM = new THREE.Matrix4()
  const _rootInv = new THREE.Matrix4()
  const _parentInv = new THREE.Matrix4()

  /** Closed-form 2-bone IK: law of cosines, no iteration. */
  function solve(leg: LegRig, targetCoxa: THREE.Vector3) {
    const { l1, l2, origin } = leg
    _u.copy(targetCoxa).sub(origin)
    const raw = _u.length()
    const span = l1 + l2
    const lo = Math.abs(l1 - l2) + 1e-4
    const hi = Math.min(span - 1e-4, PARAMS.REACH_LIMIT * span)
    // telemetry reports what the gait *asked* for, so the margin stays visible
    leg.reach = raw / span
    leg.peakReach = Math.max(leg.peakReach, leg.reach)
    leg.limited = raw > hi || raw < lo
    const d = THREE.MathUtils.clamp(raw, lo, hi)
    if (_u.lengthSq() < 1e-12) _u.copy(leg.restTibiaDir)
    _u.normalize()

    // interior angle at the femur head, between the femur and the line to the foot
    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)
    const a = Math.acos(cosA)

    // bend plane: _u toward the foot, _v the perpendicular on the knee's side
    _v.copy(leg.pole).addScaledVector(_u, -leg.pole.dot(_u))
    if (_v.lengthSq() < 1e-8) _v.set(_u.z, _u.x, _u.y).cross(_u) // degenerate: any perpendicular
    _v.normalize()

    _dir.copy(_u).multiplyScalar(Math.cos(a)).addScaledVector(_v, Math.sin(a))
    _knee.copy(origin).addScaledVector(_dir, l1)

    // Minimal-arc delta from the rest orientation preserves the bone's rest roll,
    // which a rotate-Y-onto-target construction would throw away.
    _q.setFromUnitVectors(leg.restFemurDir, _dir)
    leg.femur.quaternion.copy(_q).multiply(leg.restFemurQ)

    // the foot sits at origin + d*_u by construction, so the tibia just points at it
    _p.copy(origin).addScaledVector(_u, d).sub(_knee).normalize()
    // tibia local = inverse(femur-in-coxa) * (desired tibia-in-coxa)
    _q2.setFromUnitVectors(leg.restTibiaDir, _p)
    _q2.multiply(leg.restFemurQ).multiply(leg.restTibiaQ)
    leg.tibia.quaternion.copy(leg.femur.quaternion).invert().multiply(_q2)
  }

  /**
   * `skipLegs` keeps a leg's phase advancing but leaves its bones alone, so an
   * animation clip can own that limb and it rejoins the tripod in phase when the
   * clip stops. Freezing the whole gait would have done neither.
   */
  function update(drives: Drives, dt: number, skipLegs?: ReadonlySet<LegId>) {
    const { MAX_SPEED, STRIDE_FREQ, STRIDE_LENGTH, DUTY, LIFT, STEER_K, BOB,
            ESCAPE_OVERRIDE, REVERSE_STRIDE } = PARAMS

    // Mutual inhibition at the motor layer. An escape is not a vote to be summed
    // with foraging: while MDN is driving, the forward command and both steering
    // commands are suppressed outright, so the fly scrambles instead of stalling
    // in the middle of a tug of war. Read-only -- `drives` belongs to the caller,
    // which is still easing it toward the socket's targets.
    escaping = drives.mdn > ESCAPE_OVERRIDE
    // The cortex adds to the fly's own commands rather than replacing them, and it
    // is subject to the same inhibition: an escape suppresses cortical locomotion
    // as completely as it suppresses foraging.
    // The feeding brake suppresses the same commands, so the legs stand still at the
    // food instead of stepping in place under a body the server is holding.
    const hold = escaping || !!drives.brake
    const cf = hold ? 0 : (drives.cortex_forward ?? 0)
    const cl = hold ? 0 : (drives.cortex_lateral ?? 0)
    const fwdDrive = hold ? 0 : THREE.MathUtils.clamp(drives.dnp09 + cf, -1, 1)
    const turnL = hold ? 0 : THREE.MathUtils.clamp(drives.dna_l + Math.max(0, -cl), 0, 1)
    const turnR = hold ? 0 : THREE.MathUtils.clamp(drives.dna_r + Math.max(0, cl), 0, 1)

    const speed = (fwdDrive - drives.mdn) * MAX_SPEED
    // Shorter, faster steps whenever walking backward. `stride * k` with `dPhase / k` keeps
    // `stride * dPhase` -- and therefore both ground speed and the non-skating
    // identity below -- exactly as they were.
    const strideScale = speed < 0 ? REVERSE_STRIDE : 1
    const dPhase = (speed * dt * STRIDE_FREQ) / strideScale
    const strideBase = STRIDE_LENGTH * strideScale

    const strideL = strideBase * (1 - THREE.MathUtils.clamp(turnL, 0, 1) * STEER_K)
    const strideR = strideBase * (1 - THREE.MathUtils.clamp(turnR, 0, 1) * STEER_K)

    // Non-skating condition: a stance foot travels one stride length over the
    // stance fraction of the cycle, so the body must cover exactly that much
    // ground in the same time. Both fall out of dPhase.
    const travel = dPhase / DUTY
    offset.addScaledVector(
      _fwd.copy(forwardRig).applyQuaternion(_heading.setFromAxisAngle(yawAxis, yaw)),
      0.5 * (strideL + strideR) * travel,
    )
    // shorter left stride => the body pivots to its left, which is -yaw about up
    yaw += ((strideL - strideR) / (2 * track)) * travel

    // Feet are targeted in root space, so a bobbing root would carry them with it
    // and the stance feet would bounce through the floor. Subtract the bob from
    // every target: the body rises, the feet hold their ground height.
    const bob = BOB * Math.sin(4 * Math.PI * legs[0].phase)

    // Body pose first: the stance pins below are expressed against this frame's root.
    root.quaternion.copy(_heading.setFromAxisAngle(yawAxis, yaw)).multiply(restRootQ)
    root.position.copy(restRootPos).add(offset).addScaledVector(upRig, bob)
    _rootM.compose(root.position, root.quaternion, root.scale)
    _rootInv.copy(_rootM).invert()

    for (const leg of legs) {
      leg.phase = (leg.phase + dPhase) % 1
      if (leg.phase < 0) leg.phase += 1

      if (skipLegs?.has(leg.id)) {
        leg.pinned = leg.lifted = false // the clip owns the limb; re-plant from the nominal stance
        continue
      }

      const stride = leg.side > 0 ? strideL : strideR
      if (leg.phase < DUTY) {
        // Stance: the foot is locked in world space from touchdown to liftoff. The
        // stride model already keeps a straight-walking foot still; the pin also
        // holds it through yaw, which the stride model never counter-rotated, so a
        // turn used to sweep the planted feet across the floor.
        leg.lifted = false
        if (!leg.pinned) {
          _target.copy(leg.restFoot)
            .addScaledVector(forward, stride * (0.5 - leg.phase / DUTY))
            .addScaledVector(up, -bob)
          leg.pin.copy(_target).applyMatrix4(_rootM)
          leg.pinned = true
        }
        _target.copy(leg.pin).applyMatrix4(_rootInv)
      } else {
        // Swing: arc forward on a sine. It starts where the pin actually left the
        // foot and eases onto the nominal path, so releasing the pin does not pop.
        const t = (leg.phase - DUTY) / (1 - DUTY)
        if (!leg.lifted) {
          if (leg.pinned) leg.liftoff.copy(leg.pin).applyMatrix4(_rootInv).addScaledVector(up, bob)
          else leg.liftoff.copy(leg.restFoot).addScaledVector(forward, stride * (t - 0.5))
          leg.lifted = true
        }
        leg.pinned = false
        _target.copy(leg.restFoot).addScaledVector(forward, stride * (t - 0.5))
        // walking backward runs the swing from t=1 to t=0, so liftoff is at the t=1 end
        const ease = t * t * (3 - 2 * t)
        _target.lerp(leg.liftoff, dPhase < 0 ? ease : 1 - ease)
          .addScaledVector(up, LIFT * Math.sin(Math.PI * t) - bob)
      }

      solve(leg, _target.applyMatrix4(leg.rootToCoxa))
    }
  }

  /**
   * Pull the body toward an authoritative pose from the server: root bone world
   * x/z and yaw (0 = rest heading, positive turns right). The gait keeps
   * integrating its own motion between broadcasts, so this is a small nudge each
   * frame, not a teleport; stance feet are pinned in world space and absorb it.
   * Large errors (a reload, a recentre) snap instead.
   */
  function correct(x: number, y: number, z: number, targetYaw: number, k: number) {
    const parent = root.parent
    if (!parent) return
    // Before the first render the scale wrapper's matrix is still identity.
    parent.updateWorldMatrix(true, false)
    _parentInv.copy(parent.matrixWorld).invert()
    _target.set(x, y, z).applyMatrix4(_parentInv).sub(restRootPos)
    _target.addScaledVector(upRig, -_target.dot(upRig)) // offset never has a vertical part
    const dYaw = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw))
    if (_target.distanceTo(offset) > SNAP_DISTANCE || Math.abs(dYaw) > SNAP_YAW) {
      offset.copy(_target)
      yaw = targetYaw
      return
    }
    offset.lerp(_target, k)
    yaw += dYaw * k
  }

  /** Drop the fly back on its starting mark. The gait really does travel. */
  function reset() {
    yaw = 0
    for (const leg of legs) leg.peakReach = 0
    offset.set(0, 0, 0)
    resetPhases()
  }

  /**
   * Snap every leg back to the start of its tripod cycle without moving the body.
   * An escape scramble starts from a planted stance instead of finishing whatever
   * swing the legs happened to be in.
   */
  function resetPhases() {
    for (const leg of legs) {
      leg.phase = GROUP_B.includes(leg.id) ? 0.5 : 0
      leg.pinned = leg.lifted = false
    }
  }

  return {
    update,
    correct,
    reset,
    resetPhases,
    legs,
    axes: { forward, left, up, track },
    phases: () =>
      legs.map((l) => ({
        id: l.id,
        phase: l.phase,
        stance: l.phase < PARAMS.DUTY,
        reach: l.reach,
        peakReach: l.peakReach,
        limited: l.limited,
      })),
    clearPeaks: () => legs.forEach((l) => { l.peakReach = 0 }),
    state: () => ({ yaw, offset, escaping }),
  }
}

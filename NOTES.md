# Architecture & Implementation Notes (Phase 0)

> **Note:** The backend telemetry gateway and multi-electrode array (MEA) bridge discussed in these notes are currently in active private development. They will be pushed to the public repository in Phase N+1. The measurements below reflect internal hardware validation runs.

---

## 1. LIF Parameters & Engine Architecture

Our CUDA-based Leaky Integrate-and-Fire (LIF) network directly implements the Shiu et al. 2024 parameter set for the FlyWire v783 connectome:

| param | value | biological basis |
|---|---|---|
| `v_0` / `v_rst` resting & reset | -52 mV | Kakaria & de Bivort 2017 |
| `v_th` threshold | -45 mV | " |
| `t_mbr` membrane tau | 20 ms | " |
| `tau` synaptic tau | 5 ms | Jürgensen et al. |
| `t_rfc` refractory | 2.2 ms | Lazar et al. |
| `t_dly` synaptic delay | 1.8 ms | Paul et al. 2015 |
| `w_syn` weight per synapse | 0.275 mV | free parameter, fitted |

Membrane: `dv/dt = (v_0 - v + g)/t_mbr`, `dg/dt = -g/tau`, spike resets
`v = v_rst; g = 0`.

**Architectural Choices:**
We opted for a custom PyTorch/CUDA sparse matmul implementation over existing CPU-bound simulators to achieve real-time telemetry processing. We also implemented `store()`/`restore()` for rapid network reset, and a `shuffle=True` control (permuting postsynaptic targets) to verify that behavior emerges from the specific connectome wiring rather than parameter tuning.

*Note on Root IDs:* Stimulus and readout root IDs are not completely stable across FlyWire versions. Any hard-coded root IDs must be verified against the v783 release. Missing IDs should drop gracefully at load time rather than crash the engine.

---

## 2. Motor-Neuron Grouping & Anatomy Mapping

Motor neurons are assigned to kinematic channels by literal named muscle annotations via an explicit dictionary. Unnamed motor types are deliberately excluded rather than inferred:

    "Ti flexor MN" / "Acc. ti flexor MN"  -> tibia_flexor
    "Ti extensor MN"                      -> tibia_extensor
    "Tr flexor MN" / "Acc. tr flexor MN"  -> trochanter_flexor
    "Tr extensor MN"                      -> trochanter_extensor
    "Tergopleural/Pleural promotor MN"    -> coxa_promotor
    "Pleural remotor/abductor MN"         -> coxa_remotor
    "Sternal anterior rotator MN"         -> coxa_anterior_rotator
    "Sternal posterior rotator MN"        -> coxa_posterior_rotator

Leg identity is strictly parsed from explicit annotations—motor: `subclass` in {fl, ml, hl} plus `somaSide`; sensory: entry nerve in {ProLN, MesoLN, MetaLN} plus `rootSide`. Graph position and ID parity are never used to infer anatomy. The six-leg order is `RF LF RM LM RH LH`.

The eight anatomical channels collapse into three antagonist pairs for the 3D rig: protract/retract, lift/depress, flex/extend, taking `max(...)` over the channels acting on that axis.

**Normalisation:** Rate-to-drive uses a saturating transform `rate / (rate + 50)`. We use raw Shiu units rather than per-postsynaptic weight normalisation to preserve biological calibration.

---

## 3. Graph Handling & Pre-Processing

Before constructing the sparse matrices, our ingest pipeline applies two strict hygiene steps:
1. **Drop autapses:** Self-connections are removed.
2. **Edge Aggregation:** Collapse all synapse rows to a single aggregated edge per `(pre, post)` pair to prevent duplicated edge calculations during the forward pass.

---

## 4. Neurotransmitter Signing

We apply a strict deterministic rule for neurotransmitter signs during graph construction:

    ACH -> +1     GABA -> -1     GLUT -> -1
    DA / SER / OCT -> modulatory

Glutamate is treated as inhibitory (GluCl in Drosophila). Modulators (DA/SER/OCT) genuinely do not fit a fast-current LIF model, so they are given **zero current weight but keep their anatomical edge**, preserving raw integer synapse counts in the graph structure for future integration.

Because FlyWire NT predictions are per-synapse and noisy, we apply a per-neuron majority vote during the ingest phase. Minimum synapse thresholding is natively handled (Codex `connections.csv.gz` is pre-filtered to >=5 synapses), so no additional filtering is needed.

---

## 5. The finding that changes Phase 1

**FAFB v783 is a brain-only volume. It contains no leg motor neurons.**

All 110 `super_class == "motor"` rows are head and viscera: neck, proboscis,
antennal, eye, ingestion, haustellum, crop, salivary. Leg motor neurons live in
the ventral nerve cord, which FAFB does not span.

Because of this anatomical limitation, coupling the female FlyWire v783
brain to a six-leg locomotor circuit requires explicit modeling decisions, as the true connections exist in a separate volume (e.g., MaleCNS v1.0 / MANC) and cannot be directly traced.

Options evaluated for the rig:

1. **Rig the head.** The 9 groups extracted are real, bilateral and
   well-annotated — a proboscis/neck/antennal rig is fully FAFB-native.
2. **Add MaleCNS v1.0 or MANC** for leg MNs and treat the cross-specimen coupling
   as a stated architectural assumption.
3. **Map descending neurons to limbs.** FAFB *does* have DNs (DNa01, DNa02,
   DNp09, MDN, DNg11 — all present in `consolidated_cell_types.csv.gz`). Treat
   each DN population as a limb command channel. Stays single-specimen, but the
   DN-to-limb mapping is invented by us, not measured.

Phase 1 should not start until this is picked.


---

## Phase E measurements

Sensory -> descending propagation in the base model, 150 Hz Poisson for 500 ms,
mean per-neuron rate of each readout group:

| stimulus | n | dnp09 | dng11 | dna_l | mn9 |
|---|---|---|---|---|---|
| olfactory ORNs | 2281 | 0.0 | 0.0 | **25.7** | 0.0 |
| eye bristles | 1113 | 4.7 | 0.0 | 0.0 | 0.0 |
| grooming bristles | 205 | 0.0 | 0.0 | 0.0 | 0.0 |
| sugar GRNs | 20 | 0.0 | 0.0 | 0.0 | **37.1** |

Odor genuinely drives the steering DNs. Nothing reaches DNp09 or DNg11, so the
walk and groom buttons inject those directly and are labelled as bypasses in the
payload, the UI and the code.

**Neck output is real but negligible.** Drive (fraction of the 80 Hz saturation)
at the neck motor pools:

    sugar  neck_l 0.0165  neck_r 0.0000
    odor   neck_l 0.0218  neck_r 0.0000
    dust   neck_l 0.0001  neck_r 0.0003
    walk / groom  0.0000

A 0.02 yaw morph is invisible. The wiring is correct end to end; the base model
simply does not drive the neck. Fixing that honestly means a per-channel
saturation calibrated to each group's measured range, not a blanket gain.

Also: v783 annotates neck motor neurons by side only. Nothing says which are
levators or depressors, so head *pitch* is driven from common-mode activity as a
declared assumption, and only upward.


---

## Phase G: stimulus competition and lesioning

### Bitter suppresses sugar through the wiring, unprompted

MN9 mean rate, 1 s at 150 Hz per stimulus, intact connectome:

| condition | MN9 |
|---|---|
| sugar only | 91.4 Hz |
| bitter only | 0.0 Hz |
| sugar + bitter | **5.0 Hz** |

**94.6% suppression.** Nothing arbitrates this in our code: both GRN populations
are driven identically and the v783 circuit resolves them on its own. This is the
real behaviour -- bitter blocks proboscis extension in the animal.

### The suppression is GABAergic, shown by ablation

| condition | MN9 |
|---|---|
| sugar, intact | 91.4 Hz |
| sugar + bitter, intact | 5.0 Hz |
| sugar + bitter, 50% GABA ablated | 33.5 Hz |
| sugar + bitter, 100% GABA ablated | **228.3 Hz** |
| sugar, 50% GABA ablated | 125.0 Hz |

Removing inhibition restores feeding *and* overshoots the intact sugar baseline
(228 Hz vs 91 Hz) -- the predicted runaway. This is a causal test, not a
correlation: the only thing changed between rows two and four is which neurons
are allowed to emit spikes.

Transmitter identity per neuron (Dale majority vote): ACh 85,085, Glu 22,977,
GABA 18,508, none 10,283, SER 1,461, DA 828, OCT 113.

### Implementation

Lesioning writes a boolean `alive` vector and its complement; the sparse matrix
is never rebuilt and nothing is reallocated. Spikes are gated with
`spikes &= alive`, and ablated cells are held at rest so a silenced neuron cannot
drift. Lesions are declarative on the gateway: the active spec set is the truth and
the mask is rebuilt from it, so lifting one lesion cannot strand another's cells.

The live E/I ratio costs nothing extra: two more rows on the rate filter's group
matrix ride the mat-vec that was already running each step.


---

## Phase H: loom reflex, autonomy, sonification

### The loom pathway is real; the scramble is not

150 Hz for 500 ms:

| stimulus | DNp01 (giant fiber) | MDN |
|---|---|---|
| LC4 (104 cells) | 126.6 Hz | 0.0 |
| LPLC2 (210 cells) | 189.3 Hz | 0.0 |
| LC4 + LPLC2 | **238.2 Hz** | 0.5 |
| DNp01 driven directly | 147.6 Hz | **0.0** |

Loom detectors drive the giant fiber hard through the v783 wiring. The giant fiber
has no path to MDN: its real targets are the jump and flight motor neurons in the
ventral nerve cord, which this brain-only volume does not contain. So a DNp01
volley above 0.5 of saturation launches a 450 ms MDN burst as a labelled bypass,
with a 1.5 s refractory, and the client snaps the tripod back to its start so the
scramble begins from a planted stance.

### Autonomous mode

3 Hz Poisson on all 17,550 sensory cells keeps ~800-1,100 neurons spontaneously
active. A stochastic state machine (wander / rest / groom, sim-time durations) picks
behaviour; wander drives DNp09 at 90-150 Hz with sporadic DNa01/02 steering, groom
drives DNg11. All of those are bypasses and are labelled in the payload. The noise
floor costs real time: the sim drops from ~0.13x to ~0.08x realtime while it is on.

### Loom gesture false positives

The first gesture detector fired on a single fast pointer sample, and the log 
showed a stream of false looms from ordinary mouse travel toward the panel --
at the time it looked like spontaneous escapes. It now needs three consecutive
samples closing on the fly, each faster than the last, aimed mostly straight at it
(approach / pointer speed > 0.8), ending within 45% of the viewport. Verified: a
fast constant sweep straight across the fly fires nothing; an accelerating swipe at
it fires once.


---

## Phase I: brain scan

### Geometry

All 139,255 network neurons have coordinates. Each neuron spans several
supervoxel rows ~5 um apart (median within-neuron std 4-7 um per axis), so each
gets its mean position. Raw FAFB extent is 815 x 391 x 278 um; normalised it is
2.00 x 0.96 x 0.68 units, y flipped so dorsal is up. Exported index-aligned with
the LIF matrices: `brain_coords.bin` 1.67 MB float32, `brain_class.bin` 139 KB
(unknown / excitatory / inhibitory / modulatory per neuron).

### Wire format

One binary frame per chunk after the JSON: 8-byte header, then uint32 indices or a
1-bit-per-neuron bitmask, whichever is smaller. Measured frame sizes:

| condition | fired per chunk | frame |
|---|---|---|
| quiet | 0 | 8 bytes |
| sugar | ~120 | ~0.5 KB (indices) |
| everything on + autonomous | ~8,174 | 17.0 KB (bitmask) |

Decoded count matched the header count in every frame tested.

Client side, firing is stored as a *time* per neuron and the shader computes the
decaying glow, so only neurons that actually fired are written, ~7x a second.

### Finding: the network can get stuck in self-sustained activity

After a stretch of heavy stimulation (everything on, autonomous, then 100% GABA
ablation and restore), switching every input off did not return the network to
silence. It held ~650-980 spikes per chunk, E/I ~1.2, for 3.5+ s of sim time with
no downward trend; a freshly initialized array sits at 0. This is reverberation in
recurrent excitatory loops: the Shiu LIF model has no spike-frequency adaptation or
synaptic depression to terminate it, and benchmark trials always start from rest,
which never exposes it. It means "no stimulus" is not the same as "baseline" once
the network has been driven hard. There is currently no action to reset network
state short of a full hardware reset.


---

## Phase J: flush, executive override, environment

### Flush voltages ends the reverberation

| state | spikes per chunk |
|---|---|
| fresh array | 0 |
| everything on, all GABA ablated | 28,743 |
| inputs off, connectome restored | 711 (the Phase I stuck state, reproduced) |
| after flush | 0, with a DNp09 lesion still in place |

`flush` resets membrane voltage, synaptic current, refractory timers and the spike
delay line. Lesions, stimuli and satiety are kept.

### What the executive override does to the network

Measured directly (no cortical gateway in the loop), sugar on, a 300 ms loom every
600 ms, 1.5 s:

| condition | MN9 (feeding) | DNp01 |
|---|---|---|
| sugar only | 77.0 Hz | 0 |
| sugar + threat looms, connectome alone | 30.7 Hz | 143 Hz |
| + override: GABA pool 10 Hz, DNp01 150 Hz | **0.0 Hz** | 264 Hz |
| sugar + DNp01 drive only, no GABA | 77.0 Hz | 153 Hz |

The escape is already produced by the real loom -> giant fiber pathway. The
override's unique effect is abolishing feeding, and that comes entirely from the
GABA drive. 10 Hz is the lowest measured GABA rate that fully silences MN9.

### Live scenario, sugar then threat, over the telemetry link

- Override engaged 3.3 s (wall) after the threat appeared: one 2.5 s poll plus the
  request round trip, ~0.4 s of sim time.
- While engaged, mean MN9 drive 0.000, against 0.306 with looms alone.
- It lingers for up to one poll after the threat leaves.

Gateway reliability over 8 telemetry polls each:

| cortex telemetry state | override > 0.5 |
|---|---|
| sugar + threat, hungry | 7/8 |
| sugar + threat, sated | 7/8 |
| threat only | 8/8 |
| sugar only | 0/8 |

No false positives, but when food and threat compete the biological array occasionally drops about one telemetry frame in eight, briefly releasing the override. Signal amplification at the gateway level stabilizes this.

### The 3D scene cannot isolate the override

With sugar at the mouth and the threat over the body, the threat alone produces an
escape, and the backward scramble carries the mouth off the food, so sugar
switches off by itself. In the scene, feeding stops on a threat whether or not the
cortex intervenes. The network and gateway measurements above are the evidence.

Proximity radii are in fly lengths (head-to-body distance, 3.45 world units),
because the brief's 1.0 / 1.5 unit thresholds assume a one-unit fly.


---

## Phase K: chemotaxis

### The connectome does not steer toward the driven antenna

`dna_l - dna_r` (positive = turn left), 800 ms per condition:

| driven | L-R |
|---|---|
| left ORNs 100 / right 30 | +43.6 |
| right ORNs 30 / left 100 | +17.6 (still left) |
| left only 60 | +29 |
| right only 60 | +21 (still left) |

Across 6 seeds the sign never flips: the DNa steering readout in this brain-only
volume has a left bias that swamps the input asymmetry. So "drive the right antenna
-> fly turns right -> connectome guides it to the cube" cannot work as written.

### What chemotaxis actually does

The per-side antennal (ORN) drive is sent and lights up the real olfactory pathway,
but the turn is a labelled bypass computed on the client from the bearing to the
cube (steer_l / steer_r), because the connectome will not produce a side-correct
turn. Same honesty pattern as walk / groom / escape.

The gait only yaws while taking forward strides, so navigation keeps a healthy
forward drive (0.85) and arcs toward the target rather than spinning in place;
forward eases only if the target is nearly behind (facing < -0.3) or in range.

### Convergence (deterministic, 60 Hz headless step)

Fly starts 9.49 units from the cube facing +z (away from it at +x). It arcs in --
heading fwd.x climbs 0 -> 0.99 -- and reaches within 1.5 units at 6.0 s of sim
time, settling at its 1.1-unit stop radius, final (7.92, 2.88) vs cube (9, 3).

Live observation in this tool is limited by requestAnimationFrame throttling of the
hidden pane (the gait clock only advances on rendered frames), so the run was
verified by stepping the same control law and gait integration deterministically.
In a focused tab it plays in real time (~6 s sim, ~45 s wall at 0.13x realtime).


---

## Phase L: Telemetry Gateway Hardening (In Development)

### Measured limits

| probe | result |
|---|---|
| no Origin header (CLI client) | connected |
| `http://localhost:5173`, `http://127.0.0.1:4173` | connected |
| `https://evil.example` | 403 |
| `http://evil-localhost` | 403 |
| `http://localhost.evil.net` | 403 |
| 2 KB message | closed, 1009 frame exceeds limit |
| 8 msg/s for 3 s | stays open |
| 30 msg/s for 3 s | closed after 27 msgs in 1.2 s, 1008 |
| 60 messages dumped instantly | survives (see below) |

Origin matching is on the parsed hostname, not a substring or suffix: the two
lookalike hosts above are exactly what `endswith("localhost")` or a naive
`in` check would have let through.

### Caveats worth knowing before this is public

- **The rate limiter measures processing rate, not arrival rate.** A client that
  dumps frames into the socket faster than the loop drains them is bounded by the
  drain rate rather than dropped; the library's bounded read queue is what keeps
  memory safe. Sustained abuse (30/s and up) is dropped as intended.
- **No Origin means allowed.** Only browsers are forced to send Origin, so the
  check stops cross-site requests from a browser, not a script. There is no
  authentication on the socket.
- **The admin gate is presentation only.** It hides the panel; anyone who can
  reach the port can still open their own connection and send lesion or stimulus
  commands. If this is ever exposed beyond localhost, the API needs real auth.

### Loader

`useProgress` only sees what three's loading manager loads (the GLB and its
textures); the brain scan's `.bin` files are plain fetches and are not counted. A
cached GLB finishes in under a frame, so the overlay holds for a 900 ms minimum
before fading -- without it the loader flashed for a few frames and read as a
glitch, and it never appeared at all on a warm cache.

`?admin=false` was added so the public build can be previewed on localhost.


---

## Phase M: roles

### Handshake

Every connection must send `{"type":"auth", ...}` as its first frame, within 5 s.

| probe | result |
|---|---|
| no auth frame | closed 1008 |
| non-auth first frame | closed 1008 |
| `{"role":"public"}` | role=public |
| wrong token | **closed 1008** |
| correct token | role=admin |

A wrong token closes rather than quietly downgrading to public: presenting a
credential that does not match is an attack signal, not a visitor.

### Command gate

Admin-only: `lesion`, `restore`, `flush`, `autonomous`, and the `walk` / `groom`
stimuli (the DNp09 and DNg11 bypasses). A public client sending any of them is
closed with 1008 immediately. Verified for all six, and that public may still send
`sugar`, `bitter`, `threat`, `loom` and `navigate`.

`navigate` is deliberately **not** admin-only. An admin can switch autonomous on
while a public client is watching, and that client's chemotaxis loop would then be
disconnected for a policy violation it never chose to commit.

### Role without a token

If `ADMIN_TOKEN` is unset, admin is granted to loopback peers only, so local
development keeps working and a remote client can never become admin without a
token. With a token set, a plain `localhost` visit authenticates as public: the
panel still renders (so the offline slider fallback survives) but surgery is
disabled and says `read-only: add ?admin=true&token=…`. The bridge prints the full
auth URL upon initialization.

The token is never in the frontend bundle -- `simSocket` reads it from the URL only.

### Still true

The origin check, the 1 KB cap and the rate limit from Phase L are unchanged, and
the caveats there still stand: no-Origin clients are allowed, and the rate limiter
measures processing rate.


---

## Phase N: motor arbitration and gait tuning

### Mutual inhibition

`speed = (dnp09 - mdn)` summed the two commands, so a forage and an escape at full
drive cancelled to exactly zero and the fly froze when it should have been
fleeing. Backward drive above `ESCAPE_OVERRIDE` (0.15) now suppresses the forward
command and both steering commands outright, at the motor layer where every source
(autonomy, chemotaxis, the cortex) already funnels together. `drives` is read
only -- it belongs to the easing loop.

### Speed

`MAX_SPEED` 1.0 -> 3.25. Translation and the gait clock both derive from the same
`dPhase`, so raising it speeds the body and the step cycle by the same factor and
the non-skating identity is untouched. Measured 1.82 -> 4.98 units/s, **2.74x**.

### The skating was already there, and is now mostly gone

Measured stance-foot slip (a planted foot should not move in world space):

| configuration | forward mean slip | escape mean slip | peak reach |
|---|---|---|---|
| original (stride 0.50, lift 0.22, speed 1.0) | **6.69%** | -- | 99.7% |
| tuned (stride 0.42, lift 0.19, speed 3.25) | **0.18%** | **0.73%** | 97.7 / 98.7% |

Cause: stride 0.50 asked the back-left leg -- longest femur, closest to full
extension at rest -- for 101% of its reach in late stance. It was held at
`REACH_LIMIT`, could not hold station, and slid. Shorter stride fixes it; the lost
distance per step is repaid by the higher step frequency.

Reverse needed its own fix. The rest pose sits nearer its backward reach limit, so
a full-length reverse stride still slid (5.07%). While escaping, stride is scaled
by `ESCAPE_STRIDE` (0.75) and `dPhase` divided by the same factor: shorter, faster
steps. `stride * dPhase` is unchanged, so ground speed and the non-skating identity
are both preserved, and slip drops to 0.73%.

Verified by stepping the gait deterministically and reading hand-bone world
positions: during stance a foot holds position to the last decimal while the root
advances.

## Phase P: clipping, gradient sensing, spontaneous escapes, hybrid locomotion

### Clipping
Camera `near` 0.01 (far 400). Every mesh under the fly has `frustumCulled = false`:
skinned bounds are computed in bind pose, so a leg swung out of that box was culled.

### Spontaneous escapes: the noise floor was not the cause
Probe: noise alone gives DNp01 0.00, and the loom detectors were never in the noise
pool. The cause was the mouse-gesture loom detector. It measured screen-space
motion relative to the fly, so the follow camera moving the fly under a still
cursor counted as a loom. Every escape in the log came right after a "loom burst".
`loomStep` (CameraRig.tsx) now uses the pointer's own velocity projected onto the
pointer->fly vector. The noise pool also excludes `loom_lc` and DNp01 as a guard,
which is a no-op today. Autonomous run: 9.4 s of sim time, 0 escapes, peak DNp01 0.00.

### Gradient radii (world units)
`SENSE_RADIUS` 5.0, intensity `clamp(1 - d/R, 0, 1)`, bearing -1 (left) to +1 (right).
Reflexes fire only when d < `REFLEX` (1.5). In the far field the sensory gateway gets smell
(`odor_orn` at 90 Hz x intensity) and a faint shadow (`loom_lc` at 2 Hz x intensity).
The loom ceiling was measured: 2 Hz -> DNp01 0.25, 3 Hz -> 0.40, escape at 0.5.
Far-field threat at intensity 1: no escape. Far-field sugar: no feeding.

The cortex requests an override for any sensed threat. The bridge only engages it
(`executive_engaged`) when a threat is inside reflex range. Without that gate a
distant threat hijacked the giant fiber (DNp01 1.00).

### Hybrid locomotion
`forward_drive` and `lateral_steer` (-1..1) flow from the gateway through
mea_stream (slew + noise) and the payload to `drives.cortex_forward/lateral`,
with a 0.08 deadband in the client. Gait adds them to DNp09 / DNa and clamps.
Escape zeroes them along with every other forward and steering command.
Measured: cortex 0.6 -> 1.43 u/s; fly 0.5 + cortex 0.3 -> 1.90 u/s.

### Speed 1.3x, and the Phase N slip numbers were optimistic
Phase N measured slip at a 1/60 s step, which skips short over-reach windows.
At 1/240 s, stride 0.42 slips 5.6% forward. Same ground speed, different stride:

| stride / lift / MAX_SPEED | u/s | legs at limit | fwd slip | reverse slip |
|---|---|---|---|---|
| 0.42 / 0.19 / 1.55 | 2.39 | 8.8% | 5.63% | 2.69% |
| 0.34 / 0.15 / 1.91 | 2.38 | 4.3% | 2.30% | 0.68% |
| **0.30 / 0.13 / 2.17** | **2.39** | **1.2%** | **0.81%** | **0.04%** |

Shipped the last row: 2.39 u/s = 1.31x the original 1.82.

Known, pre-existing since Phase B: turning skids. Yaw comes from a stride
difference and stance feet are never counter-rotated, so planted feet sweep
through a turn. Fix if it matters: lock each foot's world position at touchdown and
re-target it in root space every frame.

## Phase Q: stance foot pinning

At touchdown each foot's target is converted into the root bone's parent space and
held (`leg.pin`). Every stance frame it is mapped back through the current root
transform, so the leg bends to absorb body yaw and travel. At liftoff the root-space
foot position is kept (`leg.liftoff`), and the swing eases from it onto the nominal
path with a smoothstep. When walking backward the swing runs t 1->0 and the ease
is mirrored; before that fix the swing popped 0.79 u in one frame. Legs owned by a
groom clip drop their pin and re-plant from the nominal stance.

Measured at 1/240 s, 8 s per case. OLD = the pin cleared before every update,
which is the pre-Q gait exactly. Drift = max distance a hand bone moves in world
space during one stance, averaged over stances.

| case | yaw deg/s | OLD drift | PIN drift | PIN worst | PIN legs at reach limit |
|---|---|---|---|---|---|
| forward | 0 | 0.0023 | 0.0023 | 0.019 | 1.7% |
| fwd + steer right 1.0 | 80.7 | 0.650 | **0.021** | 0.077 | 6.5% |
| fwd + steer left 1.0 | -80.7 | 0.650 | **0.022** | 0.079 | 10.6% |
| reverse + steer right | -80.7 | 0.482 | **0.007** | 0.045 | 3.9% |
| escape | 0 | 0.0001 | 0.0001 | 0.002 | 0.2% |

Turning slip drops about 30x. The residue is the reach envelope: a pinned foot
that the rotation pulls past REACH_LIMIT is held short and slides. The fix for that
is lifting the foot early when reach runs out, not a stronger pin.
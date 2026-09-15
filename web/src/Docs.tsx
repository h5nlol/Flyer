import { useEffect } from 'react'

const NAV = [
  { id: 'overview', label: '00 // SYSTEM OVERVIEW', subs: [] },
  { id: 'engine', label: '01 // THE BIOLOGICAL ENGINE', subs: ['Connectome', 'Neuron model', 'GPU integration', 'Sensors & readouts', 'Validation', 'Lesions & flush'] },
  { id: 'gateway', label: '02 // THE EXECUTIVE GATEWAY', subs: ['Control object', 'Signal conditioning', 'The override', 'Reliability'] },
  { id: 'kinematics', label: '03 // SPATIAL KINEMATICS', subs: ['Tripod gait', 'Motor arbitration', 'Foot pinning', 'Sensing radii'] },
  { id: 'bridge', label: '04 // BRIDGE & TELEMETRY', subs: ['Handshake & roles', 'Message protocol', 'Spike frames', 'Sonification'] },
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

// ---------------------------------------------------------------- building blocks

function Section({ id, index, title, lede, children }: { id: string; index: string; title: string; lede: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-12 border-b border-white">
      <div className="border-b border-white px-5 py-10 md:px-10 md:py-14">
        <div className="mb-4 text-xs text-[#E6FF00]">[ SECTION {index} ]</div>
        <h2 className="font-sans text-5xl font-black uppercase leading-[0.85] tracking-normal md:text-7xl xl:text-8xl">{title}</h2>
        <p className="mt-6 max-w-3xl text-sm leading-relaxed text-white/80 md:text-base">{lede}</p>
      </div>
      {children}
    </section>
  )
}

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div id={slug(title)} className="scroll-mt-12 border-b border-white px-5 py-8 last:border-b-0 md:px-10 md:py-10">
      <h3 className="mb-5 text-sm font-bold uppercase text-[#E6FF00]">// {title}</h3>
      <div className="max-w-4xl space-y-4 text-sm leading-relaxed text-white/85">{children}</div>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto border border-white">
      <table className="w-full border-collapse text-left text-xs md:text-sm">
        <thead>
          <tr className="bg-white text-black">
            {head.map((h) => <th key={h} className="whitespace-nowrap border-r border-black px-3 py-2 font-bold uppercase last:border-r-0">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white">
              {r.map((c, j) => <td key={j} className="border-r border-white px-3 py-2 align-top last:border-r-0">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto border border-white bg-white/[0.03] p-4 text-xs leading-relaxed text-white md:text-sm">{children}</pre>
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="border-l-4 border-[#E6FF00] bg-[#E6FF00]/[0.06] px-4 py-3 text-white">{children}</div>
}

const c = (s: string) => <code className="bg-white/10 px-1 text-[#E6FF00]">{s}</code>

// ---------------------------------------------------------------- page

export default function Docs() {
  useEffect(() => { document.title = 'FLYER // DOCS' }, [])
  return (
    <main className="tw min-h-screen bg-black font-mono text-white antialiased selection:bg-[#E6FF00] selection:text-black">
      <header className="sticky top-0 z-50 flex flex-col border-b border-white bg-black text-xs uppercase md:flex-row md:items-stretch md:justify-between md:text-sm">
        <a href="/" className="flex items-center border-b border-white px-4 py-3 hover:bg-white hover:text-black md:border-r md:border-b-0 md:px-6">
          FLYER // WETWARE V.1 // DOCS
        </a>
        <nav className="flex divide-x divide-white whitespace-nowrap text-[11px] md:text-sm">
          <a href="/" className="flex flex-1 items-center justify-center px-2 py-3 hover:bg-white hover:text-black md:flex-none md:px-6">[ HOME ]</a>
          <a href="#" className="flex flex-1 items-center justify-center px-2 py-3 hover:bg-white hover:text-black md:flex-none md:px-6">[ SOURCE ]</a>
          <a href="/sim" className="flex flex-1 items-center justify-center bg-white px-2 py-3 font-bold text-black hover:bg-[#E6FF00] md:flex-none md:px-6">
            [ INITIALIZE LINK ]
          </a>
        </nav>
      </header>

      <div className="flex flex-col md:flex-row">
        {/* SIDEBAR */}
        <aside className="border-b border-white md:sticky md:top-[45px] md:h-[calc(100vh-45px)] md:w-1/4 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0">
          <div className="border-b border-white px-5 py-4 text-xs text-white/60">INDEX // REV 2026.09</div>
          <nav className="text-xs uppercase">
            {NAV.map((s) => (
              <div key={s.id} className="border-b border-white">
                <a href={`#${s.id}`} className="block px-5 py-3 font-bold hover:bg-white hover:text-black">{s.label}</a>
                {s.subs.length > 0 && (
                  <ul className="hidden pb-3 md:block">
                    {s.subs.map((t) => (
                      <li key={t}>
                        <a href={`#${slug(t)}`} className="block py-1 pr-5 pl-9 text-white/60 hover:text-[#E6FF00]">↳ {t}</a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </nav>
          <div className="hidden px-5 py-4 text-[10px] leading-relaxed text-white/50 md:block">
            CONNECTOME DATA: FLYWIRE FAFB V783
            <br />
            LICENSE: CC BY-NC 4.0
          </div>
        </aside>

        {/* CONTENT */}
        <article className="min-w-0 md:w-3/4">
          {/* 00 ------------------------------------------------------------ */}
          <Section
            id="overview"
            index="00"
            title="System Overview"
            lede="FLYER is a three-layer control stack driving one animated body. A whole-brain spiking simulation of the adult fruit fly runs on the GPU; a slower executive layer reads a summary of its state and can bias or veto its motor output; a browser client turns both into locomotion, head movement, sound and a live brain scan."
          >
            <Sub title="Architecture">
              <Code>{`┌──────────────────────────┐   JSON state + binary spike frames (~7 Hz)   ┌──────────────────────────┐
│  LIF ENGINE  (Python)    │ ───────────────────────────────────────────► │  CLIENT  (React / R3F)   │
│  139,255 neurons, CUDA   │ ◄─────────────────────────────────────────── │  gait · IK · audio · UI  │
└────────────┬─────────────┘   stimuli, proximity, lesions (WebSocket)    └──────────────────────────┘
             │ state summary every 2.5 s
             ▼
┌──────────────────────────┐
│  EXECUTIVE GATEWAY       │  biological MEA telemetry → JSON control object
│  BioAmplifierGateway     │  → slew-limited channel stream → override / neck / locomotion
└──────────────────────────┘`}</Code>
              <p>
                The engine is the source of truth for everything the fly does on its own: feeding, the loom escape,
                olfactory steering. The gateway and the client can only add drive to it or inhibit it. Where the
                connectome has no path to a behaviour, the drive is injected directly and labelled as a bypass
                everywhere it appears: in the payload, the UI and the code (see 01 // Sensors &amp; readouts).
              </p>
            </Sub>
            <Sub title="Components">
              <Table
                head={['Component', 'Stack', 'Responsibility']}
                rows={[
                  ['ingest.py', 'Python, pandas', 'FlyWire v783 → CSR weight matrix, transmitter signs, neuron pools, 3D coordinates'],
                  ['lif.py', 'PyTorch, CUDA', 'Leaky integrate-and-fire network, rate filter, ablation mask'],
                  ['server.py', 'asyncio, websockets', 'Sim loop, stimulus arbitration, auth, rate limiting, broadcast'],
                  ['cortical_api.py', 'Python stdlib (urllib)', 'Executive gateway: state summary out, control object in'],
                  ['mea_stream.py', 'Python', 'Slew limiting and noise on executive channels'],
                  ['web/', 'Vite, React, three.js, R3F', 'Gait, IK, foot pinning, camera, WebAudio, brain scan'],
                ]}
              />
            </Sub>
          </Section>

          {/* 01 ------------------------------------------------------------ */}
          <Section
            id="engine"
            index="01"
            title="The Biological Engine"
            lede="A leaky integrate-and-fire simulation of every neuron in the FlyWire FAFB v783 connectome, using the published parameter set of Shiu et al. (2024), integrated on the GPU with no per-step allocation."
          >
            <Sub title="Connectome">
              <p>
                Synapse tables from FlyWire FAFB v783 are collapsed to one weighted edge per neuron pair and stored as a
                sparse CSR matrix {c('W[post, pre]')}. Each presynaptic neuron is signed by the majority transmitter across
                its synapses (Dale&apos;s law), so a neuron is wholly excitatory or wholly inhibitory.
              </p>
              <Table
                head={['Transmitter', 'Neurons', 'Sign']}
                rows={[
                  ['Acetylcholine', '85,085', '+'],
                  ['Glutamate', '22,977', '−'],
                  ['GABA', '18,508', '−'],
                  ['None assigned', '10,283', '0'],
                  ['Serotonin / dopamine / octopamine', '1,461 / 828 / 113', '0 (unsigned)'],
                ]}
              />
              <Note>
                FAFB is a brain-only volume. It contains no leg motor neurons: those live in the ventral nerve cord. Limb
                commands are therefore read from descending neurons (DNp09, MDN, DNa01/02, DNg11) and mapped to the body
                by the client. That mapping is a modelling decision, not a measured synapse.
              </Note>
            </Sub>
            <Sub title="Neuron model">
              <Code>{`dv/dt = (v_rest − v + g) / τ_m        spike when v ≥ v_th → v = v_reset, g = 0, refractory
dg/dt = −g / τ_s                        g += w_syn · Σ W[post, pre] · spike_pre(t − delay)`}</Code>
              <Table
                head={['Parameter', 'Value', 'Source']}
                rows={[
                  ['Integration step', '0.1 ms', 'exponential Euler'],
                  ['Resting / reset potential', '−52 mV', 'Kakaria & de Bivort 2017'],
                  ['Threshold', '−45 mV', 'Kakaria & de Bivort 2017'],
                  ['Membrane time constant', '20 ms', 'Kakaria & de Bivort 2017'],
                  ['Synaptic time constant', '5 ms', 'Jürgensen et al.'],
                  ['Refractory period', '2.2 ms', 'Lazar et al.'],
                  ['Synaptic delay', '1.8 ms', 'Paul et al. 2015'],
                  ['Weight per synapse', '0.275 mV', 'fitted (Shiu et al. 2024)'],
                ]}
              />
            </Sub>
            <Sub title="GPU integration">
              <p>
                Every tensor in the loop is allocated once at start-up. A step is one sparse mat-vec, an in-place
                exponential-Euler update, a threshold compare and a ring-buffer write for the 18-step delay line. The
                server advances the network in chunks of 250 steps (25 ms of simulated time) and broadcasts after each.
              </p>
              <p>
                Firing rates are tracked on the GPU by an exponential moving average (τ = 35 ms) over a dense group
                matrix, so reading every motor pool costs one extra mat-vec per step. Rates are normalised to a drive of
                0–1 against an 80 Hz saturation.
              </p>
              <Note>
                Throughput on a single consumer GPU is about 0.13× real time, dropping to about 0.08× with the
                autonomous noise floor on (3 Hz on all 17,550 sensory cells). One second of simulated behaviour takes
                roughly eight seconds of wall time.
              </Note>
            </Sub>
            <Sub title="Sensors & readouts">
              <p>Stimuli are Poisson spike trains (150 Hz by default) injected into identified sensory pools:</p>
              <Table
                head={['Input', 'Pool', 'Cells']}
                rows={[
                  ['Sugar', 'Gustatory receptors (sweet)', '20'],
                  ['Bitter', 'Gustatory receptors (bitter)', 'per v783 annotation'],
                  ['Odor', 'Olfactory receptor neurons, per antenna', '2,281'],
                  ['Loom', 'LC4 + LPLC2 visual projection neurons', '104 + 210'],
                  ['Dust', 'Grooming mechanosensory bristles', '205'],
                ]}
              />
              <p>Measured propagation decides which behaviours the wiring drives and which are bypassed:</p>
              <Table
                head={['Behaviour', 'Readout', 'Driven by']}
                rows={[
                  ['Feeding', 'MN9', 'connectome (sugar → MN9)'],
                  ['Loom escape command', 'DNp01 giant fiber', 'connectome (LC4/LPLC2 → DNp01)'],
                  ['Odor steering activity', 'DNa01/02', 'connectome, with a fixed left bias'],
                  ['Forward walking', 'DNp09', 'bypass: no sensory pathway reaches it'],
                  ['Grooming', 'DNg11', 'bypass'],
                  ['Backward scramble', 'MDN', 'bypass, triggered by a DNp01 volley > 0.5'],
                  ['Side-correct chemotaxis turn', 'DNa01/02', 'bypass from target bearing'],
                ]}
              />
            </Sub>
            <Sub title="Validation">
              <Table
                head={['Test', 'Condition', 'Result']}
                rows={[
                  ['Taste conflict', 'sugar / sugar + bitter', 'MN9 91.4 Hz → 5.0 Hz (94.6% suppression)'],
                  ['Causal check', 'sugar + bitter, 100% GABA ablated', 'MN9 228.3 Hz (overshoot)'],
                  ['Loom pathway', 'LC4 / LPLC2 / both', 'DNp01 126.6 / 189.3 / 238.2 Hz'],
                  ['Giant fiber → MDN', 'DNp01 driven directly', 'MDN 0.0 Hz (no path in this volume)'],
                ]}
              />
              <p>
                Bitter suppression emerges from the wiring: no code arbitrates between the two taste pools. Removing
                inhibition restores feeding and overshoots the intact baseline, which makes it a causal result rather
                than a correlation.
              </p>
            </Sub>
            <Sub title="Lesions & flush">
              <p>
                Ablation writes a boolean {c('alive')} mask; spikes are gated with {c('spikes &= alive')} and ablated cells
                are held at rest. The weight matrix is never rebuilt. Lesions are declarative (target, fraction) and
                deterministically seeded, so the mask can always be rebuilt from the active set.
              </p>
              <p>
                The Shiu model has no adaptation or synaptic depression, so after heavy drive the network can sustain
                reverberant activity with every input off (measured: 711 spikes per chunk, no downward trend).{' '}
                {c('flush')} resets voltage, synaptic current, refractory timers and the delay line, returning the network
                to 0 spikes while keeping lesions, stimuli and satiety.
              </p>
            </Sub>
          </Section>

          {/* 02 ------------------------------------------------------------ */}
          <Section
            id="gateway"
            index="02"
            title="The Executive Gateway"
            lede="A second, much slower controller layered over the connectome. It is implemented via the BioAmplifierGateway client, interfacing directly with biological neurospheres hosted on the FinalSpark Neuroplatform. Telemetry and channel names map to their remote multi-electrode array (MEA) API."
          >
            <Sub title="Control object">
              <p>
                Every 2.5 s the server summarises the organism&apos;s state (active stimuli, satiety, feeding state and
                any sensed objects with intensity and bearing) and sends it to the biological array. The decoded response returns as a single JSON control object:
              </p>
              <Code>{`{
  "neck_yaw":           -1.0 … 1.0,   // head turn
  "neck_pitch":         -1.0 … 1.0,
  "human_hands_active": true | false,
  "executive_override":  0.0 … 1.0,   // veto strength
  "forward_drive":      -1.0 … 1.0,   // added to DNp09
  "lateral_steer":      -1.0 … 1.0    // added to DNa01/02, + = right
}`}</Code>
              <p>
                Missing or malformed fields fall back to neutral, every value is clamped, and a failed request leaves
                the last good output in place. The gateway never raises into the simulation loop.
              </p>
            </Sub>
            <Sub title="Signal conditioning">
              <p>
                {c('mea_stream.py')} low-pass filters each continuous channel toward its target (τ = 0.6 s) and adds
                Gaussian noise (σ = 0.03), so head and locomotion commands glide instead of stepping every 2.5 s. The
                client applies a 0.08 deadband so the noise floor cannot make an idle body creep.
              </p>
              <Note>
                The noise and the device telemetry (impedance, temperature, SNR) are actively monitored.
              </Note>
            </Sub>
            <Sub title="The override">
              <p>When {c('executive_override')} exceeds 0.5 and a threat is inside reflex range, the server:</p>
              <ul className="list-inside list-[square] space-y-1 marker:text-[#E6FF00]">
                <li>drives the inhibitory (GABA) pool at 10 Hz × override, the lowest rate that fully silences MN9;</li>
                <li>drives the DNp01 giant fiber, launching the escape;</li>
                <li>suppresses forward and steering commands from every source at the motor layer.</li>
              </ul>
              <Table
                head={['Condition (1.5 s, looms every 600 ms)', 'MN9 feeding', 'DNp01']}
                rows={[
                  ['Sugar only', '77.0 Hz', '0'],
                  ['Sugar + threat looms, connectome alone', '30.7 Hz', '143 Hz'],
                  ['+ override (GABA 10 Hz, DNp01 150 Hz)', '0.0 Hz', '264 Hz'],
                ]}
              />
              <p>
                A request for an override with no threat nearby is reported as {c('executive_engaged: false')} and
                does nothing. Without that gate a distant threat drove the giant fiber to saturation.
              </p>
            </Sub>
            <Sub title="Reliability">
              <Table
                head={['Input to the executive layer', 'Override > 0.5 (of 8)']}
                rows={[
                  ['Threat only', '8'],
                  ['Sugar + threat, hungry', '7'],
                  ['Sugar + threat, sated', '7'],
                  ['Sugar only', '0'],
                ]}
              />
              <p>
                No false positives were observed. When food and threat compete the layer drops about one request in
                eight, releasing the override for one poll. End-to-end latency from threat onset to engagement was
                3.3 s of wall time (one poll plus the request round trip).
              </p>
            </Sub>
          </Section>

          {/* 03 ------------------------------------------------------------ */}
          <Section
            id="kinematics"
            index="03"
            title="Spatial Kinematics"
            lede="Descending-neuron drives become six-legged locomotion in the browser: a procedural tripod gait with closed-form two-bone inverse kinematics, world-space foot pinning, and a single motor arbitration point shared by every control source."
          >
            <Sub title="Tripod gait">
              <p>
                Legs alternate in two tripods (FL, MR, BL / FR, ML, BR) half a cycle apart. Each leg spends 60% of the
                cycle in stance. Knee angles come from the law of cosines, bending toward the knee direction the rig was
                modelled with, so the solver never flips a joint.
              </p>
              <Code>{`speed   = (clamp(dnp09 + cortex_forward, −1, 1) − mdn) × MAX_SPEED
dPhase  = speed · dt · STRIDE_FREQ / strideScale
travel  = dPhase / DUTY                    // body and feet share one clock: no skating
yaw    += (strideL − strideR) / (2 · track) · travel`}</Code>
              <Table
                head={['Parameter', 'Value']}
                rows={[
                  ['Stride length / swing lift', '0.30 / 0.13 units'],
                  ['Stride frequency', '2.2 cycles/s × drive'],
                  ['Top speed', '2.39 units/s'],
                  ['Reach limit', '97% of femur + tibia'],
                  ['Reverse stride', '0.75× length, 1.33× frequency'],
                ]}
              />
              <p>
                The stride was sized by measurement: at 0.42, legs hit the reach limit on 8.8% of frames and slipped
                5.6%. At 0.30 with a proportionally higher step rate, ground speed is identical and forward slip falls
                to 0.81% (reverse 0.04%).
              </p>
            </Sub>
            <Sub title="Motor arbitration">
              <p>
                Fly and executive commands are summed and clamped. An escape is not summed: while MDN drive exceeds 0.15,
                forward and steering commands from the connectome, chemotaxis and the executive layer are all
                suppressed, so a forage and an escape cannot cancel to a standstill.
              </p>
            </Sub>
            <Sub title="Foot pinning">
              <p>
                At touchdown each foot target is transformed into the root bone&apos;s parent space and locked. Every
                stance frame the pin is mapped back through the current root transform, so the leg bends to absorb body
                yaw and translation. At liftoff the swing starts from the pinned position and eases onto the nominal
                path with a smoothstep, mirrored when walking backward.
              </p>
              <Table
                head={['Case (1/240 s steps, 8 s)', 'Yaw', 'Drift before', 'Drift after']}
                rows={[
                  ['Forward', '0°/s', '0.0023', '0.0023'],
                  ['Forward + full right steer', '80.7°/s', '0.650', '0.021'],
                  ['Forward + full left steer', '−80.7°/s', '0.650', '0.022'],
                  ['Reverse + full steer', '−80.7°/s', '0.482', '0.007'],
                ]}
              />
              <p>
                Drift is the furthest a planted foot moves in world space during one stance, averaged. The residual
                comes from the reach envelope: a pinned foot pulled past the limit is held short and slides. Lifting the
                foot early when reach runs out would remove it.
              </p>
            </Sub>
            <Sub title="Sensing radii">
              <Table
                head={['Range', 'Distance', 'Effect']}
                rows={[
                  ['Far field', '< 5.0 units', 'intensity = clamp(1 − d/5, 0, 1) with bearing; smell (ORNs, 90 Hz × I) and shadow (loom cells, 2 Hz × I)'],
                  ['Reflex', '< 1.5 units', 'contact response: gustatory receptors for food, full loom and escape for threats'],
                ]}
              />
              <p>
                The far-field loom rate is capped by measurement: 2 Hz peaks DNp01 at 0.25 and 3 Hz at 0.40, below the
                0.5 escape threshold, so a distant threat is sensed without triggering a flight.
              </p>
            </Sub>
          </Section>

          {/* 04 ------------------------------------------------------------ */}
          <Section
            id="bridge"
            index="04"
            title="Bridge & Telemetry"
            lede="A single WebSocket carries commands in and state out: authenticated, origin-checked and rate-limited, with neural activity streamed as compact binary frames and rendered as both a brain scan and sound."
          >
            <Sub title="Handshake & roles">
              <p>The first frame must be an auth message, within 5 s, or the socket closes with 1008.</p>
              <Code>{`→ {"type": "auth", "role": "public"}
→ {"type": "auth", "token": "<ADMIN_TOKEN>"}      // wrong token: closed, not downgraded`}</Code>
              <Table
                head={['Limit', 'Value']}
                rows={[
                  ['Max message size', '1 KB (close 1009)'],
                  ['Rate', '10 msg/s, burst 15 (close 1008)'],
                  ['Origin', 'parsed hostname allow-list'],
                  ['Admin-only', 'lesion, restore, flush, autonomous, walk, groom'],
                ]}
              />
              <Note>
                The origin check stops cross-site browsers, not scripts, and the limiter measures processing rate. Put
                the socket behind real network controls before exposing it publicly.
              </Note>
            </Sub>
            <Sub title="Message protocol">
              <Code>{`→ {"stimulus": "sugar", "state": true}
→ {"action": "threat", "state": true}
→ {"action": "sense", "sugar": [0.62, -0.40], "bitter": [0, 0], "threat": [0, 0]}
→ {"action": "navigate", ...}                        // chemotaxis, lapses after 400 ms
→ {"action": "lesion", "target": "gaba_inhibitory", "fraction": 0.5}       // admin

← {"morphs": {...}, "fly_drives": {"dnp09", "mdn", "dna_l", "dna_r", "dnp01", ...},
   "cortex_drives": {"neck_yaw", "executive_override", "executive_engaged",
                     "forward_drive", "lateral_steer", ...},
   "sim": {"t_ms", "behaviour", "satiety", "escape_seq", "senses", ...}}`}</Code>
            </Sub>
            <Sub title="Spike frames">
              <p>
                After each JSON state message the server sends one binary frame with every neuron that fired in the
                chunk: an 8-byte header followed by either uint32 indices or a 1-bit-per-neuron bitmask, whichever is
                smaller.
              </p>
              <Table
                head={['Condition', 'Fired per chunk', 'Frame']}
                rows={[
                  ['Quiet', '0', '8 bytes'],
                  ['Sugar', '~120', '~0.5 KB (indices)'],
                  ['Everything on + autonomous', '~8,174', '17.0 KB (bitmask)'],
                ]}
              />
              <p>
                The client stores a last-fired time per neuron and a shader computes the decaying glow across all
                139,255 soma positions, so only neurons that actually fired are written.
              </p>
            </Sub>
            <Sub title="Sonification">
              <p>
                The WebAudio graph is built once, on the first user gesture. Every sound after that is an automation
                event on an existing AudioParam: no node is created per spike.
              </p>
              <Table
                head={['Voice', 'Source', 'Driven by']}
                rows={[
                  ['Clicks', 'high-passed noise, ~1 ms gates at Poisson times', 'neurons fired in the last chunk'],
                  ['Pops', 'resonant mid tone with a fast pitch drop', 'MN9 firing rate'],
                  ['Drone', 'two detuned low sines', 'excitation / inhibition ratio'],
                ]}
              />
            </Sub>
          </Section>

          <div className="px-5 py-6 text-[10px] uppercase text-white/50 md:px-10">
            FLYER // WETWARE V.1 // CONNECTOME DATA: FLYWIRE FAFB V783 (CC BY-NC 4.0) // LIF PARAMETERS: SHIU ET AL. 2024
          </div>
        </article>
      </div>
    </main>
  )
}
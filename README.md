


# flyer

Connectome-driven simulation: the FlyWire *Drosophila* connectome (FAFB v783)
driving a six-limbed humanoid body.

**Status: Phase N — motor arbitration and gait tuning.**

## Layout

    data/        raw FlyWire dumps + derived tables (gitignored)
    reference/   read-only clones of prior art (gitignored, see NOTES.md)
    scripts/     download + extraction + inspection
    src/         ingest.py (connectome -> sparse matrix), lif.py (engine + bench),
                 server.py (WebSocket bridge)
    web/         Vite + React + three.js front end (gait, morphs, debug panel)

## Setup

Python 3.11.

```bash
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
```

Torch is pinned as `torch==2.11.0+cu128` against the PyTorch CUDA index —
the `+cu128` local tag is what forces pip to take the CUDA wheel instead of
the CPU one PyPI serves under the same version number. Bump both for a
different CUDA runtime.

Verify the GPU:

```bash
.venv/Scripts/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Verified here on an RTX 3060 Laptop GPU: `2.11.0+cu128 True NVIDIA GeForce RTX 3060 Laptop GPU`.

## Scripts

### `scripts/download.sh`

Pulls FlyWire FAFB v783 from the Codex bucket
(`storage.googleapis.com/flywire-data/codex/data/fafb/783`) into `data/`:
`connections.csv.gz`, `classification.csv.gz`, `coordinates.csv.gz`,
`consolidated_cell_types.csv.gz`. Files already present are skipped; sizes are
printed at the end. ~57 MB total.

```bash
bash scripts/download.sh
```

### `scripts/inspect.py`

Row count, columns, dtypes and 5 sample rows for every `data/*.csv.gz`.

```bash
.venv/Scripts/python scripts/inspect.py
```

### `scripts/extract_motor_groups.py`

Filters `classification.csv.gz` to `super_class == "motor"`, groups by annotated
target and side, writes `data/motor_groups.csv`
(`group_name, side, neuron_count, root_ids`) and prints a summary table.
`group_name` is stable, lowercase and underscore-separated — it is the rig spec
for the Blender model.

```bash
.venv/Scripts/python scripts/extract_motor_groups.py
.venv/Scripts/python scripts/extract_motor_groups.py --selfcheck   # slug() assertions
```

## Simulation

### `src/ingest.py`

Builds `data/connectome_v783.pt`: a signed sparse adjacency in CSR form, stored as
`W[post, pre]` so a step is a plain mat-vec. Thresholds at `syn_count >= 5`,
aggregates the per-neuropil rows into one weight per pair, and signs edges by
Dale's law (per-neuron transmitter majority; ACh +1, GABA/Glu -1, modulators 0).

```bash
.venv/Scripts/python src/ingest.py --min-syn 5 --nt-mode per_neuron
```

### `src/lif.py`

Leaky integrate-and-fire network on CUDA, Shiu et al. 2024 parameters. The
validation bench is the `__main__` block: 20 labellar sugar GRNs at 150 Hz for
300 ms, reading out MN9 (proboscis extension).

```bash
.venv/Scripts/python src/lif.py --controls
.venv/Scripts/python src/lif.py --selfcheck   # analytic integrator test, no data needed
```

### `src/server.py`

Streams the sim to the browser on `ws://localhost:8765`. The step loop runs in
chunks on a worker thread; one host transfer and one broadcast per chunk, never
per `dt`. Firing rates are smoothed on the GPU by an EMA and normalised against a
saturation frequency to give 0..1 drives.

```bash
.venv/Scripts/python src/server.py
```

Then start the web client and click a stimulus.

**Stimuli.** `sugar` (feeding), `bitter` (specificity control, does nothing),
`odor` (2281 olfactory ORNs), `dust` (1113 eye bristles), plus `walk` and `groom`
which are **bypasses**: they inject DNp09 and DNg11 directly because no sensory
path in this base model reaches them. Measured at 150 Hz for 500 ms:

| stimulus | measured DN response |
|---|---|
| odor (ORNs) | `dna_l` 25.7 Hz — real steering, `dnp09` 0.0 Hz |
| dust (eye bristles) | `dnp09` 4.7 Hz, `dng11` 0.0 Hz |
| sugar | `mn9` 37.1 Hz |

**Satiety.** MN9 spikes raise it, it decays with a 3 s time constant, and it
scales the sugar drive by `(1 - satiety)`. Continuous scaling alone only finds a
set point around 0.6 with the tongue flickering, so feeding is also gated with
hysteresis (stop at 0.5, resume at 0.15) — a modelling choice, not a connectome
result. Hold Sugar on and the fly eats, fills up, retracts its proboscis for
~4 s, then eats again.

Then start the web client and click **Sugar**. Readout channels: MN9 (CB0701) ->
`tongue_out`, DNp09 -> `dnp09`, MDN -> `mdn`, DNa01/DNa02 by side -> `dna_l`/`dna_r`,
DNg11 -> the `groom_face` clip. **Bitter** is the specificity control and should do
nothing. With the server down the client retries quietly and the debug sliders
stay in charge.

### Executive control layer (staged)

A secondary executive control layer handles head orientation and voluntary groom arbitration,
augmenting the fly's native neck motor pools (see NOTES.md).

**Status: Private Hardware Staging.** The multi-electrode telemetry gateway and live bridge
driver (`src/cortical_api.py`, `src/mea_stream.py`) are maintained in a private staging branch
during closed-loop timing calibration and electrode array validation. 

In this public build, `src/server.py` runs with the gateway decoupled: the server falls back
directly to the connectome's biological descending motor pools, and telemetry reporting defaults
to standby. The complete driver suite and telemetry pipeline will be published in Phase N+1 upon
conclusion of hardware integration.

### Circuit surgery

Stimuli can run simultaneously and the connectome arbitrates them itself: sugar
plus bitter suppresses MN9 by ~95% with no arbitration logic on our side.

Neurons can be ablated in the running network over the socket, with no restart
and no matrix rebuild:

```json
{"action": "lesion", "target": "gaba_inhibitory", "fraction": 0.5}
{"action": "lesion", "target": "CB0701", "fraction": 1.0}
{"action": "restore"}
```

Targets are readout groups (`dnp09`, `mn9`, `dng11`, ...), transmitter classes
(`gaba_inhibitory`, `cholinergic`, `glutamatergic`), or any of the 8,772 cell
types by name. Ablating 50% of the GABAergic population breaks the bitter
suppression and drives runaway firing; severing DNp09 paralyses the gait while
the walk command is still on. See NOTES.md for the numbers.

### Presentation and behaviour

- **Camera**: keys `1` follow orbit (default), `2` head macro, `3` free orbit. Follow
  carries the camera with the fly so a custom orbit angle survives walking.
- **Sound**: click *sound off* in the panel header to start. Clicks track how many
  neurons fired, pops track MN9, and a drone rises in pitch as E/I climbs.
- **Visual loom / threat**: the button, or an accelerating mouse swipe at the fly,
  drives the LC4/LPLC2 loom detectors -> giant fiber (real) -> backward scramble
  (bypass).
- **Autonomous foraging**: spontaneous sensory noise plus a wander / rest / groom
  state machine; the manual drive sliders lock while it runs.

### Brain scan

The corner window renders all 139,255 neurons at their real FAFB positions and
lights them as they fire: green excitatory, magenta inhibitory, amber modulatory,
dim red ablated. *Toggle brain scan* in the Camera section hides it and stops its
render loop. `src/ingest.py` writes the geometry to `web/public/models/`; the
server streams which neurons fired as a compact binary frame after each JSON
broadcast.

### Environment and executive override

Drag the green cube (sugar) or red spike (bitter) to the mouth, or the dark plane
(threat) over the body. A nearby threat keeps looming and triggers an executive
override (when the upstream gateway is linked), prioritizing threat over food.
Above 0.5 the server drives DNp01 and the GABA pool directly, a labelled bypass that
silences feeding. **Flush voltages** clears runaway activity without undoing lesions.

### Chemotaxis

With **Autonomous foraging** on, the fly navigates to the green sugar cube: the
client sends per-side antennal ORN drive (the real olfactory pathway) plus a
computed forward/turn command. The turn is a labelled bypass (steer_l/steer_r),
because the measured connectome will not steer toward the driven antenna. Drag the
cube anywhere and the fly arcs to it and feeds. Steering, walk, groom and escape
are all bypasses; the olfactory, gustatory, loom and inhibitory pathways are real.

### Motor arbitration

An escape overrides foraging outright rather than being summed with it: backward
drive above `PARAMS.ESCAPE_OVERRIDE` zeroes the forward and steering commands, so
the fly scrambles instead of stalling. Walking speed is `PARAMS.MAX_SPEED`; because
translation and the step cycle share one `dPhase`, changing it keeps the feet
planted. See NOTES.md for the measured foot-slip figures.

### Roles

Connections authenticate on their first frame. Admin needs `ADMIN_TOKEN` from
`.env`, passed as `?admin=true&token=…` (the server prints the URL at startup);
everything else is public. Public clients may drive the senses and the environment
(`sugar`, `bitter`, `threat`, `loom`, `navigate`); `lesion`, `restore`, `flush`,
`autonomous` and the `walk`/`groom` bypasses are admin-only and close the
connection with 1008. Without a token, admin is granted to loopback only.

Public visitors get a bottom overlay: **deploy sugar cube**, **deploy quinine
spike**, **trigger visual threat**, each on a 2 s cooldown, which teleport a target
into proximity range and let the connectome react.

### Public vs admin

The debug panel renders only on localhost or with `?admin=true`; `?admin=false`
previews the public view locally. The public build shows the scene, the Cortex
Executive Feed and the brain scan. **This is presentation, not security** -- the
WebSocket API has no authentication. See NOTES.md before exposing it.

The server restricts origins to localhost plus `ALLOWED_ORIGIN` from `.env`, caps
inbound messages at 1 KB, and drops connections above 10 messages/second.

## Reference repos

`reference/` holds shallow read-only clones of buzzback-brain, desktop-fly and
flywire-network-analysis. They are gitignored and no code is copied from them.
`NOTES.md` records what is reusable in their approach to LIF parameters,
neurotransmitter signing and motor-neuron grouping — plus the finding that FAFB
v783 has no leg motor neurons, which needs a decision before Phase 1.

## Data license

FlyWire FAFB v783 data is **CC BY-NC 4.0 — non-commercial use only**
(<https://creativecommons.org/licenses/by-nc/4.0/>). Attribute the FlyWire
Consortium; see <https://codex.flywire.ai/about_flywire>. Anything derived in
`data/` inherits that license. Note that the MaleCNS / MANC nerve-cord data
referenced in `NOTES.md` is CC BY 4.0 — a *different*, more permissive license.
Keep the two straight if both end up in the repo.

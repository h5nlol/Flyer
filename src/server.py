#!/usr/bin/env python3
"""WebSocket bridge between the LIF network and the browser.

The simulation runs in chunks on a worker thread; the event loop broadcasts one
JSON payload per chunk and stays responsive to inbound stimulus messages in
between. Nothing is read back from the GPU inside the step loop -- one transfer
per chunk, not per dt.

    ->  {"fly_drives": {...}, "cortex_drives": {...}, "hardware_telemetry": {...},
         "morphs": {...}, "clips": {...}, "sim": {...}}
    <-  {"stimulus": "sugar", "state": true}

Run:  python src/server.py            then open the web client
"""
from __future__ import annotations

import argparse
import asyncio
import http
import json
import math
import os
import pathlib
import random
import secrets
import time
import urllib.parse
import zlib
from typing import Any

import numpy as np
import torch
import websockets

from cortical_api import CorticalLink, _load_env as read_env
from lif import RateFilter, load
from mea_stream import MEAStream

# Stimulus name -> (bundle key, is_bypass).
#
# A BYPASS does not stimulate sensory cells: it injects current straight into a
# descending neuron, standing in for a pathway this base model does not carry.
# Measured at 150 Hz for 500 ms, the honest sensory results are:
#   odor  (2281 olfactory ORNs) -> dna_l 25.7 Hz, dnp09 0.0 Hz
#   dust  (1113 eye bristles)   -> dnp09  4.7 Hz, dng11 0.0 Hz
# So odor really does steer, but nothing reaches the walk or groom commands, and
# walk/groom below drive DNp09 and DNg11 directly. They are labelled as such in
# the payload so the browser can never present them as a connectome result.
STIMULI: dict[str, tuple[str, bool]] = {
    "sugar": ("sugar_grn", False),
    "bitter": ("bitter_grn", False),
    "odor": ("odor_orn", False),
    "dust": ("dust_bristle", False),
    "walk": ("_dn_dnp09", True),
    "groom": ("_dn_dng11", True),
    # Loom is REAL: LC4 + LPLC2 -> DNp01 measured at 238 Hz. Fired as a timed
    # burst, never toggled on.
    "loom": ("loom_lc", False),
    # Internal, never toggled from the browser. Escape and steering are BYPASSES:
    # DNp01 -> MDN measured at 0.0 Hz (the giant fiber's real targets are jump
    # motor neurons in the nerve cord, outside this brain-only volume), and no
    # sensory pool reaches DNa01/02 on demand from both sides.
    "escape": ("_dn_mdn", True),
    "steer_l": ("_dn_dna_l", True),
    "steer_r": ("_dn_dna_r", True),
    # Chemotaxis: the antennal drives are REAL ORN input, but they do not steer
    # (measured: the DNa readout is side-agnostic here), so the actual turn rides
    # the steer_l/steer_r bypass above. See NOTES.md.
    "chemo_l": ("odor_orn_l", False),
    "chemo_r": ("odor_orn_r", False),
    # Gradient sensing. Gustatory receptors are contact sensors, so a distant food
    # object arrives as smell (the olfactory receptor pool) and a distant threat as
    # a growing shadow on the loom detectors. Both scale with proximity; the contact
    # reflexes (feeding, full escape) still need the object inside reflex range.
    "sense_odor": ("odor_orn", False),
    "sense_loom": ("loom_lc", False),
}
# Executive override from the second control layer. Both are BYPASSES injected by
# the cortex, not connectome pathways. Measured with sugar on and repeated looms:
#   looms alone              MN9 30.7 Hz, DNp01 143 Hz  (the escape is already real)
#   + GABA pool 10 Hz        MN9  0.0 Hz                (this is what aborts feeding)
#   DNp01 drive alone        MN9 77.0 Hz                (no effect on feeding)
STIMULI["exec_gf"] = ("_dn_dnp01", True)
STIMULI["exec_gaba"] = ("_gaba_pool", True)
INTERNAL = {"loom", "escape", "steer_l", "steer_r", "exec_gf", "exec_gaba",
            "chemo_l", "chemo_r", "sense_odor", "sense_loom"}
SENSE_TTL_MS = 400.0  # a sense report lapses if the client stops sending them
# Measured ceilings, 3 s per rate, peak drive (escape fires above 0.5 DNp01):
#   loom detectors 1.5 Hz -> DNp01 0.00, 2.0 Hz -> 0.25, 3.0 Hz -> 0.40
#   olfactory receptors 30-90 Hz -> MN9 0.00, DNp01 0.00
# A distant threat therefore registers on the loom detectors without ever firing
# the giant fiber; only reflex range does that.
SENSE_ODOR_HZ = 90.0  # olfactory drive at intensity 1
SENSE_LOOM_HZ = 2.0  # loom-detector drive at intensity 1
NAV_TTL_MS = 400.0  # a chemotaxis drive lapses unless refreshed

# ---- shared world -----------------------------------------------------------
# The server owns where everything is: the fly's body pose and the three props.
# Every viewer renders the same world, and proximity, reflexes and chemotaxis are
# computed here once instead of by each browser (which used to give every visitor
# a different fly, each sending its own stimuli).
#
# Body kinematics mirror web/src/gait.ts exactly, so the legs a browser animates
# from the same drives stay under the body the server moves. The gait constants are
# in rig units (flyer_web.glb, scale 1.0; measured: full drive 2.39 rig u/s, full
# one-sided steer 80.7 deg/s). The fly is shown at FLY_SCALE inside the chamber, so
# every fly-relative length below is multiplied by it. web/src/chamber.ts uses the
# same constant.
FLY_SCALE = 0.075
GAIT_MAX_SPEED = 2.17
GAIT_STRIDE_FREQ = 2.2
GAIT_STRIDE = 0.30
GAIT_DUTY = 0.6
GAIT_STEER_K = 0.85
GAIT_REVERSE_STRIDE = 0.75
GAIT_ESCAPE_OVERRIDE = 0.15
GAIT_TRACK = 0.72  # lateral half-spread of the coxae, rig units
CORTEX_DEADBAND = 0.08  # same deadband the client applies to cortical locomotion
FLY_REST = (0.0, -1.2 * FLY_SCALE)  # root bone x, z at rest; facing +z, yaw 0
HEAD_AHEAD = 3.45 * FLY_SCALE  # head bone sits this far in front of the root
GAIT_HEADING = -0.042  # the gait walks along its coxa-derived forward axis, 2.4 deg off the head line

# The glass test chamber (web/public/models/chamber_bounds.json, shared with the
# client). The fly's root and every prop stay inside `walkable`.
_BOUNDS_FILE = pathlib.Path(__file__).resolve().parents[1] / "web" / "public" / "models" / "chamber_bounds.json"
WALKABLE = {"minX": -1.7269, "maxX": 1.5707, "minZ": -1.62, "maxZ": 1.6776, "floorY": 0.0518}
CEILING_Y = 4.1228
try:
    _bounds = json.loads(_BOUNDS_FILE.read_text(encoding="utf8"))
    WALKABLE.update({k: float(_bounds["walkable"][k]) for k in WALKABLE})
    CEILING_Y = float(_bounds["cameraBox"]["maxY"])
except (OSError, KeyError, TypeError, ValueError) as err:
    print(f"chamber_bounds.json not read ({err}); using built-in bounds")
FLOOR_Y = WALKABLE["floorY"]
# Props are Blender GLBs with their base at y = 0 (donut, rock, tweezers; see
# web/src/Props.tsx), so food sits AT the floor and the tweezers hang above it.
PROP_ELEVATION = {"sugar": 0.0, "bitter": 0.0, "threat": 0.45}
PROP_DEFAULTS = {
    "sugar": (7.0 * FLY_SCALE, FLOOR_Y + PROP_ELEVATION["sugar"], 5.0 * FLY_SCALE),
    "bitter": (-7.0 * FLY_SCALE, FLOOR_Y + PROP_ELEVATION["bitter"], 5.0 * FLY_SCALE),
    "threat": (0.0, FLOOR_Y + PROP_ELEVATION["threat"], 10.0 * FLY_SCALE),
}
PROP_INSET = 0.2  # props are placed at least this far inside the walkable floor

# Wall avoidance. Inside this margin the fly gets an inward turn on its DNa steering
# channels (the steer_l / steer_r bypass, same as chemotaxis) and curves away on its
# own gait. The coordinate clamp in step_world is only the failsafe.
WALL_MARGIN = 0.35
WALL_ALIGNED = 0.5  # rad: already heading this close to inward, no correction needed
WALL_FOOD_EXEMPT = 0.6  # food this close to the head: let chemotaxis finish the approach

SENSE_RADIUS = 5.0 * FLY_SCALE  # sensing starts here, intensity 1 - d / SENSE_RADIUS
REFLEX = 1.5 * FLY_SCALE  # contact reflexes fire inside this
REFLEX_EXIT = 1.15  # hysteresis on leaving reflex range
NAV_ANTENNAL_HZ = 120.0  # peak per-side ORN drive while navigating
NAV_STOP = 0.8 * REFLEX  # stop walking once the mouth is this close to the cube

# ---- food: finite sugar, feeding brake, respawn -------------------------------
# The cube is a finite resource. Consumption and respawn run on WALL time, like the
# body kinematics, so what a viewer watches (the cube shrinking, the fly standing
# still) matches the clock they watch it on. Satiety decays in sim time.
NUTRITION_MAX = 100.0
NUTRITION_PER_S = 15.0  # consumed per wall second while feeding: a full cube lasts ~6.7 s
# Satiety per unit eaten. A full cube is worth 0.6, above the 0.5 fed threshold, so
# a hungry fly usually stops before finishing, wanders off, and comes back for the
# rest once hungry again; a partly eaten cube can be finished outright.
SATIETY_PER_UNIT = 0.006
FEED_MN9 = 0.3  # MN9 drive that counts as the proboscis actually feeding
# Motor-layer brake while feeding: walk and both steering commands are dropped, so
# neither the wander state nor chemotaxis can drive the fly round the cube.
BRAKED_STIMULI = ("walk", "steer_l", "steer_r")
# ---- environmental perturbations (autonomous mode only) ---------------------------
# Every 45-90 s of WALL time a non-prop stimulus arrives on its own. Wall time, like
# the rest of the shared world: at ~0.1x realtime these would otherwise be minutes
# of sim apart and hours of viewing apart.
#   dust_influx        the real `dust` pool (1,113 eye-bristle mechanoreceptors). Measured
#                      at 150 Hz, dust reaches DNg11 at 0.0 Hz: the connectome does NOT
#                      groom from it. The grooming is the `groom` BYPASS on DNg11, and is
#                      reported as a bypass like every other.
#   ambient_odor_waft  the real `odor` pool (2,281 ORNs), which does drive the DNa
#                      steering neurons (25.7 Hz measured). No bypass.
# FLYER_EVENT_EVERY="min,max" overrides the interval (testing, demos).
EVENT_EVERY_S = tuple(float(v) for v in os.environ.get("FLYER_EVENT_EVERY", "45,90").split(",")[:2])
ENV_EVENTS: dict[str, dict[str, Any]] = {
    "dust_influx": {"label": "Particulate Deposition (Eye Bristles Stimulated)", "duration_s": 4.0,
                    "stimuli": ("dust", "groom")},
    "ambient_odor_waft": {"label": "Ambient Odor Waft (Olfactory Receptors Stimulated)", "duration_s": 3.0,
                          "stimuli": ("odor",)},
}

RESPAWN_S = 3.0
RESPAWN_MIN_FLY_DIST = 0.8  # about three body lengths at FLY_SCALE, so it has to walk

# ---- production limits ----------------------------------------------------
# Inbound frames are tiny (the largest is a navigate command, well under 200 B).
# 1 KB is generous; anything larger is closed by the library with 1009.
MAX_MESSAGE_BYTES = 1024
# Token bucket per connection. The browser sends ~4/s while navigating plus the
# odd toggle, so 10/s sustained with a small burst allowance is ample.
RATE_PER_SEC = 10.0
RATE_BURST = 15.0
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}

# ---- roles ----------------------------------------------------------------
# Every connection must identify itself before it is served. Admin gets every
# command; public connections are spectators and may send nothing after auth.
AUTH_TIMEOUT_S = 5.0


def origin_allowed(origin: str, extra: str | None) -> bool:
    """Any localhost port, plus one configured origin. Exact host match, no suffixes.

    Checking `endswith("localhost")` would accept `evil-localhost`, and matching a
    bare substring would accept `https://example.com.attacker.net`.
    """
    if extra and origin == extra:
        return True
    try:
        host = urllib.parse.urlsplit(origin).hostname
    except ValueError:
        return False
    return host in LOCAL_HOSTS

EXEC_THRESHOLD = 0.5  # override below this does nothing
EXEC_GABA_HZ = 10.0  # at override 1.0; the lowest measured rate that fully silences MN9
THREAT_LOOM_EVERY_MS = 600.0  # a nearby threat keeps looming, not just once

LOOM_MS = 300.0  # sim-time length of one looming burst
ESCAPE_MS = 450.0  # backward scramble triggered by a giant fiber volley
ESCAPE_REFRACT_MS = 1500.0
ESCAPE_THRESHOLD = 0.5  # DNp01 drive (fraction of saturation) that counts as a volley
NOISE_HZ = 3.0  # spontaneous activity on every sensory cell in autonomous mode

# Binary brain-scan frames, sent after each JSON broadcast:
#   u8 type   (1 = neurons that fired this chunk, 2 = alive mask)
#   u8 enc    (0 = uint32 little-endian indices, 1 = little-endian bitmask, 1 bit/neuron)
#   u16 reserved, u32 count, then the payload
# Indices cost 4 bytes per spiking neuron; the bitmask is a flat n/8 bytes. The
# frame uses whichever is smaller, so a quiet chunk is a few KB and a runaway
# seizure after GABA ablation is capped at ~17 KB instead of ~0.5 MB.
FRAME_SPIKES = 1
FRAME_ALIVE = 2
ENC_INDICES = 0
ENC_BITMASK = 1


def _frame(kind: int, enc: int, count: int, payload: bytes) -> bytes:
    return bytes((kind, enc, 0, 0)) + int(count).to_bytes(4, "little") + payload


# Autonomous behaviour: durations in sim ms, and who follows whom. Pure modelling
# choice -- a small stochastic state machine standing in for everything that
# decides what a real fly does next.
BEHAVIOUR_MS = {"wander": (800.0, 2000.0), "rest": (500.0, 1500.0), "groom": (600.0, 1200.0)}
BEHAVIOUR_NEXT = {
    "wander": (("rest", 0.6), ("groom", 0.4)),
    "rest": (("wander", 0.65), ("groom", 0.35)),
    "groom": (("wander", 0.7), ("rest", 0.3)),
}


class SimRunner:
    """Owns the network, the rate filter and the stimulus state."""

    def __init__(self, device: str, chunk: int, tau_ms: float, saturation_hz: float,
                 rate_hz: float, sat_gain: float = 0.005, sat_tau_ms: float = 3000.0,
                 sat_full: float = 0.5, sat_hungry: float = 0.15):
        self.net, self.bundle = load(device)
        self.chunk = chunk
        self.rate_hz = rate_hz

        groups = dict(self.bundle["readouts"])
        # Two extra rows on the rate filter give a live excitatory/inhibitory spike
        # split for free: it rides the mat-vec that was already happening, instead
        # of adding per-step reductions to the loop.
        sign = self.bundle["nt_sign"]
        groups["_exc"] = torch.nonzero(sign > 0).flatten()
        groups["_inh"] = torch.nonzero(sign < 0).flatten()
        self.rates = RateFilter(groups, self.net.n, self.net.p.dt, tau_ms, saturation_hz, device)

        # The bypass targets are readout groups, reachable under a private key so
        # STIMULI stays one flat table.
        readouts = self.bundle["readouts"]
        self.bundle["_dn_dnp09"] = readouts["dnp09"]
        self.bundle["_dn_dng11"] = readouts["dng11"]
        self.bundle["_dn_mdn"] = readouts["mdn"]
        self.bundle["_dn_dna_l"] = readouts["dna_l"]
        self.bundle["_dn_dna_r"] = readouts["dna_r"]
        self.bundle["_dn_dnp01"] = readouts["dnp01"]
        self.bundle["_gaba_pool"] = torch.nonzero(self.bundle["nt_code"] == 2).flatten()

        self.stim_idx: dict[str, torch.Tensor] = {}
        self.bypass: set[str] = set()
        for name, (key, is_bypass) in STIMULI.items():
            if key in self.bundle:
                # GPU copies once, so rebuilding the stimulus never re-uploads.
                self.stim_idx[name] = self.bundle[key].to(self.net.device)
                if is_bypass:
                    self.bypass.add(name)
        self.active: set[str] = set()  # manual, from the admin panel
        self.contact: set[str] = set()  # gustatory contact from a prop in reflex range
        self.net.set_stimulus(torch.empty(0, dtype=torch.long))
        # Background noise pool for autonomous mode. The giant fiber and its loom
        # detectors are excluded explicitly: they are not sensory-class neurons, so
        # the sets are disjoint today and this changes nothing -- but the guarantee
        # that noise can never drive an escape should not rest on a classification
        # accident. (Measured: noise on all 17,550 sensory cells gives DNp01 0.00.)
        sensory = self.bundle["sensory_all"].to(self.net.device)
        protected = torch.cat([self.bundle["loom_lc"], self.bundle["readouts"]["dnp01"]]).to(self.net.device)
        self.sensory = sensory[~torch.isin(sensory, protected)]

        # Timed bursts (loom, escape): name -> sim time they expire.
        self.timed: dict[str, float] = {}
        self.escape_seq = 0
        self.escape_ready_ms = 0.0
        self.dnp01_row = self.rates.names.index("dnp01") if "dnp01" in self.rates.names else None

        # Autonomous mode: its own stimulus set, so switching it off never
        # disturbs what the user turned on by hand.
        self.autonomous = False
        self.behaviour = "off"
        self.behaviour_until = 0.0
        self.auto_rates: dict[str, float] = {}
        self.rng = random.Random(11)

        # Environment and executive control.
        self.nav: dict[str, float] = {}  # transient chemotaxis drives, name -> Hz
        # target -> (intensity 0..1, bearing -1 left .. +1 right), from the browser
        self.senses: dict[str, tuple[float, float]] = {}
        self.senses_until = 0.0

        # Shared world. fly = [x, z, yaw]; yaw 0 faces +z, positive turns right.
        self.fly = [*FLY_REST, 0.0]
        self.fly_vel = [0.0, 0.0, 0.0]  # per wall second, for client extrapolation
        self.props = {k: list(v) for k, v in PROP_DEFAULTS.items()}
        self.in_range = {k: False for k in PROP_DEFAULTS}
        self.cortex_motor = (0.0, 0.0)  # forward, lateral after the array's conditioning
        self.nutrition = NUTRITION_MAX
        self.sugar_present = True
        self.respawn_at = 0.0  # wall time a depleted cube comes back
        self.feeding_brake = False
        self.wall_steer: tuple[str, float] | None = None  # (steer_l|steer_r, Hz) near a wall
        self.env_event: str | None = None
        self.env_event_until = 0.0  # wall time
        self.next_env_event_at = time.time() + self.rng.uniform(*EVENT_EVERY_S)
        self._last_world = time.time()
        self.nav_until = 0.0
        self.threat = False  # a threat object is inside proximity range
        self.threat_next_loom = 0.0
        self.executive = 0.0  # last override the cortex commanded, 0..1

        # --- satiety -------------------------------------------------------
        # Eating fills the fly up: MN9 spikes raise it, it decays on its own, and
        # it attenuates the sugar drive. That makes feeding self-limiting rather
        # than a fixed reflex -- hold sugar on and the tongue retracts anyway.
        # Continuous (1 - satiety) scaling alone does not produce fullness: it is a
        # negative feedback loop that finds a set point around 0.6 and sits there,
        # with the tongue flickering. Measured, not assumed. So feeding is also
        # gated with hysteresis -- stop when full, stay stopped until properly
        # hungry again. The two thresholds are a modelling choice; nothing in the
        # connectome says where they sit.
        # --- lesioning -----------------------------------------------------
        # Lesions are declarative: the set of active specs is the truth, and the
        # mask is recomputed from it. Toggling one off cannot leave another's
        # neurons dead, which incremental restore would get wrong.
        self.lesions: dict[str, float] = {}
        self.n_alive = self.net.n

        # Suppression tracking: baseline is MN9 under sugar with no aversive
        # input, measured live rather than hardcoded.
        self.mn9_baseline = 0.0
        self.suppression: float | None = None

        self.satiety = 0.0
        self.fed = False  # gate: True = full, not feeding
        self.sat_full = sat_full
        self.sat_hungry = sat_hungry
        self.sat_gain = sat_gain
        self.sat_decay = float(torch.exp(torch.tensor(-chunk * self.net.p.dt / sat_tau_ms)))
        self.mn9_row = self.rates.names.index("mn9") if "mn9" in self.rates.names else None

        self.sim_ms = 0.0
        self.wall_s = 0.0
        self.steps = 0

        # Brain scan: every neuron that fired at least once this chunk. max(), in
        # place, against the float spike vector the step already produces.
        self.fired = torch.zeros(self.net.n, device=self.net.device)
        self.spike_frame = b""
        self.alive_frame = b""
        self.alive_dirty = True

        # Second biological layer. The array bridge is sampled every broadcast;
        # the culture itself is polled on a much slower interval by a separate
        # task, because it is upstream of the bridge, not inside the fast loop.
        self.cortex = CorticalLink()
        self.mea = MEAStream()
        self._last_sample = time.time()
        # Free will by default: the fly lives (wanders, rests, grooms, forages) from
        # the moment the server starts. An admin can still switch it off.
        self.set_autonomous(True)

    def set_stimulus(self, name: str, on: bool) -> None:
        if name not in self.stim_idx or name in INTERNAL:
            return
        self.active.add(name) if on else self.active.discard(name)
        self.apply_stimuli()

    def stimuli_now(self) -> dict[str, float]:
        """Everything driven this chunk, name -> Hz."""
        out: dict[str, float] = dict(self.auto_rates)
        if self.sim_ms < self.nav_until:
            out.update(self.nav)
        for name in self.active | self.contact:
            out[name] = self.rate_hz
        for name in self.timed:
            out[name] = self.rate_hz
        if self.sim_ms < self.senses_until:
            food = max(self.senses.get("sugar", (0.0, 0.0))[0], self.senses.get("bitter", (0.0, 0.0))[0])
            if food > 0.0:
                out["sense_odor"] = SENSE_ODOR_HZ * food
            shadow = self.senses.get("threat", (0.0, 0.0))[0]
            if shadow > 0.0:
                out["sense_loom"] = SENSE_LOOM_HZ * shadow
        # The cortex may REQUEST an override from far-field sensing, but the hijack
        # of the giant fiber only engages with a threat actually in reflex range.
        # Enforced here rather than in the profile: a distant threat is now reported
        # to the cortex, and a model free to answer 1.0 would otherwise escape from
        # across the room -- measured, before this gate.
        if self.executive_engaged():
            out["exec_gf"] = self.rate_hz * self.executive
            out["exec_gaba"] = EXEC_GABA_HZ * self.executive
        if "sugar" in out:
            out["sugar"] *= 0.0 if self.fed else (1.0 - self.satiety)
        if self.env_event:
            for name in ENV_EVENTS[self.env_event]["stimuli"]:
                out[name] = max(out.get(name, 0.0), self.rate_hz)
        if self.wall_steer:
            # Walls outrank chemotaxis and the wander state's random turns.
            out.pop("steer_l", None)
            out.pop("steer_r", None)
            name, hz = self.wall_steer
            out[name] = hz
        if self.feeding_brake:
            for name in BRAKED_STIMULI:
                out.pop(name, None)
        return out

    def apply_stimuli(self) -> None:
        """Rebuild the stimulus vector from its layers. Once per chunk or change.

        In place on buffers that already exist: clear, then index_fill each layer.
        Background noise goes down first so a real stimulus on the same cells
        overrides it.
        """
        self.net.clear_stimulus()
        if self.autonomous:
            self.net.add_stimulus(self.sensory, NOISE_HZ)
        for name, hz in sorted(self.stimuli_now().items()):
            if hz > 0:
                self.net.add_stimulus(self.stim_idx[name], hz)

    # ---- loom / escape / autonomy ------------------------------------------

    def navigate(self, forward: float, turn: float, ant_l: float, ant_r: float) -> None:
        """Closed-loop chemotaxis drive from the client, refreshed each poll.

        forward and turn are 0..1 / -1..1 commands; the antennal rates are the real
        ORN input. Steering is a bypass because the connectome will not turn toward
        the driven antenna (measured). Only active while autonomous.
        """
        nav: dict[str, float] = {}
        f = max(0.0, min(1.0, forward))
        if f > 0:
            nav["walk"] = self.rate_hz * f
        t = max(-1.0, min(1.0, turn))
        if t > 0.05:
            nav["steer_r"] = self.rate_hz * t
        elif t < -0.05:
            nav["steer_l"] = self.rate_hz * -t
        if ant_l > 0:
            nav["chemo_l"] = ant_l
        if ant_r > 0:
            nav["chemo_r"] = ant_r
        self.nav = nav
        self.nav_until = self.sim_ms + NAV_TTL_MS
        self.apply_stimuli()

    def set_threat(self, on: bool) -> None:
        self.threat = on
        self.threat_next_loom = self.sim_ms

    def executive_engaged(self) -> bool:
        return self.executive > EXEC_THRESHOLD and self.threat

    def set_senses(self, senses: dict[str, tuple[float, float]]) -> None:
        self.senses = senses
        self.senses_until = self.sim_ms + SENSE_TTL_MS
        self.apply_stimuli()

    def senses_now(self) -> dict[str, tuple[float, float]]:
        return dict(self.senses) if self.sim_ms < self.senses_until else {}

    def cortex_state(self) -> list[str]:
        """What the cortex is told is going on: manual stimuli plus environment."""
        return sorted(self.active | self.contact | ({"threat"} if self.threat else set()))

    def flush(self) -> None:
        """Clear membrane, synaptic, refractory and in-flight spike state.

        Lesions, stimuli and satiety are untouched: this ends reverberation that
        has outlived its input (Phase I) without undoing any surgery.
        """
        self.net.reset()
        self.rates.reset()
        self.fired.zero_()
        self.timed.pop("escape", None)

    def fire_loom(self) -> None:
        self.timed["loom"] = self.sim_ms + LOOM_MS
        self.apply_stimuli()

    def set_autonomous(self, on: bool) -> None:
        self.autonomous = on
        self.auto_rates.clear()
        self.behaviour = "rest" if on else "off"
        self.behaviour_until = self.sim_ms
        self.apply_stimuli()

    def step_behaviour(self) -> None:
        if not self.autonomous:
            return
        rng = self.rng
        if self.sim_ms >= self.behaviour_until:
            roll, acc, nxt = rng.random(), 0.0, "rest"
            for candidate, pr in BEHAVIOUR_NEXT.get(self.behaviour, (("rest", 1.0),)):
                acc += pr
                nxt = candidate
                if roll <= acc:
                    break
            self.behaviour = nxt
            lo, hi = BEHAVIOUR_MS[nxt]
            self.behaviour_until = self.sim_ms + rng.uniform(lo, hi)
            self.auto_rates = {}
            if nxt == "wander":
                self.auto_rates["walk"] = rng.uniform(90.0, 150.0)
            elif nxt == "groom":
                self.auto_rates["groom"] = self.rate_hz

        if self.behaviour == "wander" and rng.random() < 0.08:
            # Sporadic steering: occasionally start, switch or stop a turn.
            self.auto_rates.pop("steer_l", None)
            self.auto_rates.pop("steer_r", None)
            pick = rng.choice(("none", "steer_l", "steer_r"))
            if pick != "none":
                self.auto_rates[pick] = 120.0

    # ---- lesioning --------------------------------------------------------

    def resolve_target(self, target: str) -> torch.Tensor | None:
        """Map a lesion target name to neuron indices. Returns None if unknown."""
        if target in self.bundle["readouts"]:
            return self.bundle["readouts"][target]
        nt = {"cholinergic": 1, "gaba_inhibitory": 2, "glutamatergic": 3}.get(target)
        if nt is not None:
            return torch.nonzero(self.bundle["nt_code"] == nt).flatten()
        names = self.bundle.get("type_names", [])
        if target in names:
            code = names.index(target)
            return torch.nonzero(self.bundle["type_code"] == code).flatten()
        return None

    def set_lesion(self, target: str, fraction: float) -> bool:
        idx = self.resolve_target(target)
        if idx is None:
            return False
        fraction = max(0.0, min(1.0, fraction))
        if fraction <= 0.0:
            self.lesions.pop(target, None)
        else:
            self.lesions[target] = fraction
        self.rebuild_mask()
        return True

    def rebuild_mask(self) -> None:
        self.net.restore_all()
        for target, fraction in sorted(self.lesions.items()):
            idx = self.resolve_target(target)
            if idx is None or not idx.numel():
                continue
            if fraction < 1.0:
                # Deterministic per target, so a toggle is reproducible.
                # crc32, not hash(): Python salts str hashes per process, which
                # made "the same 50% of GABA" a different 50% on every restart.
                g = torch.Generator().manual_seed(zlib.crc32(target.encode()))
                keep = int(idx.numel() * fraction)
                idx = idx[torch.randperm(idx.numel(), generator=g)[:keep]]
            self.net.lesion(idx)
        self.n_alive = self.net.n_alive
        self.alive_dirty = True

    def restore_connectome(self) -> None:
        self.lesions.clear()
        self.n_alive = self.net.restore_all()
        self.alive_dirty = True

    def build_frames(self) -> None:
        """Pack this chunk's firing and, if it changed, the alive mask.

        Runs on the worker thread with the chunk, so the event loop only ships
        bytes. One nonzero() and one host copy per chunk; nothing per step.
        """
        n = self.net.n
        idx = torch.nonzero(self.fired).flatten()
        k = int(idx.numel())
        if k * 4 <= (n + 7) // 8:
            payload = idx.to(torch.int32).cpu().numpy().astype("<u4").tobytes()
            self.spike_frame = _frame(FRAME_SPIKES, ENC_INDICES, k, payload)
        else:
            bits = np.packbits(self.fired.cpu().numpy() > 0, bitorder="little")
            self.spike_frame = _frame(FRAME_SPIKES, ENC_BITMASK, k, bits.tobytes())
        if self.alive_dirty:
            bits = np.packbits(self.net.alive.cpu().numpy(), bitorder="little")
            self.alive_frame = _frame(FRAME_ALIVE, ENC_BITMASK, self.n_alive, bits.tobytes())

    def run_chunk(self) -> None:
        """Blocking: advance `chunk` steps. Called on a worker thread."""
        t0 = time.time()
        self.rates.total.zero_()
        self.fired.zero_()
        for _ in range(self.chunk):
            self.net()
            self.rates.update(self.net.spikes_f)
            torch.maximum(self.fired, self.net.spikes_f, out=self.fired)
        if self.net.device.type == "cuda":
            torch.cuda.synchronize()
        self.build_frames()
        self.wall_s = time.time() - t0
        self.steps += self.chunk
        self.sim_ms += self.chunk * self.net.p.dt

        # Suppression: how much of the pure-sugar MN9 drive survives when an
        # aversive stimulus is on at the same time. Baseline only tracks while
        # sugar is running unopposed and nothing is lesioned.
        mn9_now = float(self.rates.drive[self.mn9_row]) if self.mn9_row is not None else 0.0
        present = self.active | self.contact
        sugar_on = "sugar" in present
        aversive = bool(present & {"bitter"})
        if sugar_on and not aversive and not self.lesions:
            self.mn9_baseline = max(self.mn9_baseline * 0.98, mn9_now)
        if sugar_on and aversive and self.mn9_baseline > 0.05:
            self.suppression = max(0.0, min(1.0, 1.0 - mn9_now / self.mn9_baseline))
        elif not sugar_on:
            self.suppression = None

        # Satiety integrates once per chunk, off the single host transfer that
        # was happening anyway. Decay first, then this chunk's eating.
        if self.mn9_row is not None:
            mn9_spikes = float(self.rates.total[self.mn9_row])
            # MN9 spikes fill the fly only for the manual admin stimulus. Feeding at
            # the cube is paid for in units actually eaten (see step_world).
            spike_gain = mn9_spikes * self.sat_gain if "sugar" in self.active else 0.0
            self.satiety = min(1.0, self.satiety * self.sat_decay + spike_gain)
            if self.fed:
                if self.satiety <= self.sat_hungry:
                    self.fed = False
            elif self.satiety >= self.sat_full:
                self.fed = True

        # Timed bursts expire in sim time.
        for name in [n for n, until in self.timed.items() if until <= self.sim_ms]:
            del self.timed[name]

        # Escape: a giant fiber volley launches a backward scramble. DNp01 firing
        # is the connectome's doing; the scramble it triggers is the labelled bypass.
        if self.dnp01_row is not None and self.sim_ms >= self.escape_ready_ms:
            if float(self.rates.drive[self.dnp01_row]) > ESCAPE_THRESHOLD:
                self.escape_seq += 1
                self.timed["escape"] = self.sim_ms + ESCAPE_MS
                self.escape_ready_ms = self.sim_ms + ESCAPE_REFRACT_MS
                print(f"  escape #{self.escape_seq} at {self.sim_ms / 1000:.2f}s (giant fiber volley)")

        if self.threat and self.sim_ms >= self.threat_next_loom:
            self.timed["loom"] = self.sim_ms + LOOM_MS
            self.threat_next_loom = self.sim_ms + THREAT_LOOM_EVERY_MS

        self.step_behaviour()
        self.apply_stimuli()

    def sample_array(self) -> tuple[dict[str, Any], dict[str, float]]:
        now = time.time()
        dt = min(now - self._last_sample, 1.0)
        self._last_sample = now
        drives, telemetry = self.mea.sample(dt)
        if self.mea.online:
            def band(v: float) -> float:
                if abs(v) <= CORTEX_DEADBAND:
                    return 0.0
                return math.copysign((abs(v) - CORTEX_DEADBAND) / (1 - CORTEX_DEADBAND), v)
            self.cortex_motor = (band(float(drives.get("forward_drive", 0.0))),
                                 band(float(drives.get("lateral_steer", 0.0))))
        else:
            self.cortex_motor = (0.0, 0.0)
        return drives, telemetry

    # ---- shared world -----------------------------------------------------

    def world(self) -> dict[str, Any]:
        def r(v: float) -> float:
            return round(v, 4)
        return {
            "fly": {"x": r(self.fly[0]), "z": r(self.fly[1]), "yaw": r(self.fly[2]),
                    "vx": r(self.fly_vel[0]), "vz": r(self.fly_vel[1]), "vyaw": r(self.fly_vel[2])},
            "props": {k: [r(c) for c in v] for k, v in self.props.items()},
            "in_range": dict(self.in_range),
            "sugar_health_pct": r(self.nutrition / NUTRITION_MAX),
            "sugar_present": self.sugar_present,
            "environmental_event": self.env_event_payload(),
        }

    def env_event_payload(self) -> dict[str, Any] | None:
        if not self.env_event:
            return None
        spec = ENV_EVENTS[self.env_event]
        return {"type": self.env_event, "label": spec["label"], "duration_s": spec["duration_s"],
                "remaining_s": round(max(0.0, self.env_event_until - time.time()), 2)}

    def step_env_events(self, now: float) -> None:
        """Stochastic perturbations: one at a time, only while the fly is autonomous."""
        if not self.autonomous:
            if self.env_event:
                print(f"  environmental event {self.env_event} cancelled (autonomy off)")
            self.env_event = None
            self.next_env_event_at = now + self.rng.uniform(*EVENT_EVERY_S)
            return
        if self.env_event and now >= self.env_event_until:
            print(f"  environmental event {self.env_event} ended")
            self.env_event = None
            self.next_env_event_at = now + self.rng.uniform(*EVENT_EVERY_S)
        if not self.env_event and now >= self.next_env_event_at:
            self.env_event = self.rng.choice(sorted(ENV_EVENTS))
            self.env_event_until = now + ENV_EVENTS[self.env_event]["duration_s"]
            print(f"  environmental event {self.env_event}: {ENV_EVENTS[self.env_event]['label']}")

    def reset_fly(self) -> None:
        self.fly = [*FLY_REST, 0.0]
        self.fly_vel = [0.0, 0.0, 0.0]

    def set_prop(self, name: str, x: float, y: float, z: float) -> bool:
        if name not in self.props or not all(math.isfinite(v) for v in (x, y, z)):
            return False
        w = WALKABLE
        self.props[name] = [max(w["minX"], min(w["maxX"], x)), max(FLOOR_Y, min(CEILING_Y, y)),
                            max(w["minZ"], min(w["maxZ"], z))]
        return True

    def deploy(self, name: str) -> bool:
        """Put a prop in reflex range of the fly: threat over the body, food at the mouth."""
        x, z, yaw = self.fly
        if name == "threat":
            return self.set_prop(name, x, FLOOR_Y + PROP_ELEVATION["threat"], z)
        fx, fz = math.sin(yaw), math.cos(yaw)
        hx, hz = x + fx * HEAD_AHEAD, z + fz * HEAD_AHEAD
        side = (0.6 if name == "sugar" else -0.6) * FLY_SCALE  # sideways, so both can be in range
        if name == "sugar":
            self.refill_sugar()
        return self.set_prop(name, hx - fz * side, FLOOR_Y + PROP_ELEVATION.get(name, 0.0), hz + fx * side)

    def refill_sugar(self) -> None:
        self.nutrition = NUTRITION_MAX
        self.sugar_present = True
        self.respawn_at = 0.0

    def respawn_sugar(self) -> None:
        """A fresh cube somewhere in the arena, not on top of the fly."""
        x, z, _ = self.fly
        for _ in range(64):
            nx = self.rng.uniform(WALKABLE["minX"] + PROP_INSET, WALKABLE["maxX"] - PROP_INSET)
            nz = self.rng.uniform(WALKABLE["minZ"] + PROP_INSET, WALKABLE["maxZ"] - PROP_INSET)
            if math.hypot(nx - x, nz - z) >= RESPAWN_MIN_FLY_DIST:
                break
        else:  # no spot far enough away (cannot happen on this floor, but never loop forever)
            nx, nz = -x, -z
        self.refill_sugar()
        self.set_prop("sugar", nx, FLOOR_Y + PROP_ELEVATION["sugar"], nz)
        print(f"  sugar respawned at ({nx:.2f}, {nz:.2f})")

    def step_world(self) -> None:
        """Advance the body from this chunk's motor drives, then sense the props.

        Integrated in WALL time, like the browser gait, so the body moves at the
        speed its legs are seen to walk.
        """
        def clamp(v: float, lo: float, hi: float) -> float:
            return max(lo, min(hi, v))

        now = time.time()
        dt = min(now - self._last_world, 0.5)
        self._last_world = now
        self.step_env_events(now)
        d = {k: float(v) for k, v in zip(self.rates.names, self.rates.drive.tolist())}

        # Motor arbitration, same as gait.ts: an escape suppresses every forward and
        # steering command, including the cortex's.
        mdn = d.get("mdn", 0.0)
        escaping = mdn > GAIT_ESCAPE_OVERRIDE
        now_wall = now
        mn9 = d.get("mn9", 0.0)

        # --- feeding brake: engage on real feeding at the cube, hold until the food
        # is gone, out of reach, or the fly is full. Held with hysteresis rather than
        # re-tested on MN9 every chunk, which flickers around the threshold.
        if self.feeding_brake:
            if not (self.sugar_present and self.in_range["sugar"] and not self.fed and self.nutrition > 0):
                self.feeding_brake = False
                print(f"  feeding brake released (nutrition {self.nutrition:.0f}, satiety {self.satiety:.2f})")
        elif self.sugar_present and self.in_range["sugar"] and mn9 > FEED_MN9 and not self.fed:
            self.feeding_brake = True
            print("  feeding brake engaged")
        cf, cl = (0.0, 0.0) if escaping else self.cortex_motor
        fwd = 0.0 if escaping else clamp(d.get("dnp09", 0.0) + cf, -1.0, 1.0)
        turn_l = 0.0 if escaping else clamp(d.get("dna_l", 0.0) + max(0.0, -cl), 0.0, 1.0)
        turn_r = 0.0 if escaping else clamp(d.get("dna_r", 0.0) + max(0.0, cl), 0.0, 1.0)
        speed = (fwd - mdn) * GAIT_MAX_SPEED
        stride_scale = GAIT_REVERSE_STRIDE if speed < 0 else 1.0
        travel = speed * dt * GAIT_STRIDE_FREQ / stride_scale / GAIT_DUTY
        base = GAIT_STRIDE * stride_scale
        stride_l = base * (1 - turn_l * GAIT_STEER_K)
        stride_r = base * (1 - turn_r * GAIT_STEER_K)
        x, z, yaw = self.fly
        step = 0.5 * (stride_l + stride_r) * travel * FLY_SCALE  # rig units -> world
        # shorter left stride pivots left, which is negative yaw
        dyaw = (stride_l - stride_r) / (2 * GAIT_TRACK) * travel
        if self.feeding_brake and not escaping:
            step = dyaw = 0.0  # stationary while feeding; an escape still takes the body
        # Failsafe only: wall steering below should keep the fly off the glass. Both the
        # root and the head are held inside `walkable` -- clamping the root alone let the
        # head poke through the glass while the body circled food in a corner (measured).
        nx = clamp(x + math.sin(yaw + GAIT_HEADING) * step, WALKABLE["minX"], WALKABLE["maxX"])
        nz = clamp(z + math.cos(yaw + GAIT_HEADING) * step, WALKABLE["minZ"], WALKABLE["maxZ"])
        new_yaw = yaw + dyaw
        hx0, hz0 = nx + math.sin(new_yaw) * HEAD_AHEAD, nz + math.cos(new_yaw) * HEAD_AHEAD
        nx += clamp(hx0, WALKABLE["minX"], WALKABLE["maxX"]) - hx0
        nz += clamp(hz0, WALKABLE["minZ"], WALKABLE["maxZ"]) - hz0
        self.fly = [nx, nz, yaw + dyaw]
        self.fly_vel = [(nx - x) / dt, (nz - z) / dt, dyaw / dt] if dt > 0 else [0.0, 0.0, 0.0]

        # --- food pool ---
        if self.feeding_brake and mn9 > FEED_MN9:
            eaten = min(self.nutrition, NUTRITION_PER_S * dt)
            self.nutrition -= eaten
            self.satiety = min(1.0, self.satiety + eaten * SATIETY_PER_UNIT)
            if self.satiety >= self.sat_full:
                self.fed = True
            if self.nutrition <= 0.0:
                self.nutrition = 0.0
                self.sugar_present = False
                self.feeding_brake = False
                self.respawn_at = now_wall + RESPAWN_S
                print(f"  sugar depleted (satiety {self.satiety:.2f}); respawn in {RESPAWN_S:.0f} s")
        if not self.sugar_present and self.respawn_at and now_wall >= self.respawn_at:
            self.respawn_sugar()

        # --- proximity: graded far-field sensing, and contact reflexes in range ---
        x, z, yaw = self.fly
        fx, fz = math.sin(yaw), math.cos(yaw)
        hx, hz = x + fx * HEAD_AHEAD, z + fz * HEAD_AHEAD
        senses: dict[str, tuple[float, float]] = {}
        dist_of: dict[str, float] = {}
        for name, (px, _py, pz) in self.props.items():
            if name == "sugar" and not self.sugar_present:
                # Eaten: no smell, no contact, no gradient to follow.
                senses[name] = (0.0, 0.0)
                dist_of[name] = math.inf
                if self.in_range[name]:
                    self.in_range[name] = False
                    self.contact.discard(name)
                continue
            ox, oz = (x, z) if name == "threat" else (hx, hz)
            dist = math.hypot(px - ox, pz - oz)
            tx, tz = px - x, pz - z
            n = math.hypot(tx, tz)
            # cross > 0 means the object is on the fly's left
            cross = (fx * tz - fz * tx) / n if n > 1e-6 else 0.0
            dot = (fx * tx + fz * tz) / n if n > 1e-6 else 1.0
            bearing = clamp(math.atan2(-cross, dot) / (math.pi / 2), -1.0, 1.0)
            senses[name] = (clamp(1 - dist / SENSE_RADIUS, 0.0, 1.0), bearing)
            dist_of[name] = dist

            was = self.in_range[name]
            now_in = dist < REFLEX * REFLEX_EXIT if was else dist < REFLEX
            if now_in != was:
                self.in_range[name] = now_in
                if name == "threat":
                    self.set_threat(now_in)
                elif now_in:
                    self.contact.add(name)
                else:
                    self.contact.discard(name)
                print(f"  {name} {'in' if now_in else 'out of'} reflex range ({dist:.2f} u)")
        self.senses = senses
        self.senses_until = self.sim_ms + SENSE_TTL_MS

        # --- wall avoidance: turn inward before the head reaches the glass ---
        # Measured from the head, which is what meets a wall when walking into it.
        w = WALKABLE
        push_x = push_z = 0.0
        for gap, sign, axis in ((hx - w["minX"], 1.0, "x"), (w["maxX"] - hx, -1.0, "x"),
                                (hz - w["minZ"], 1.0, "z"), (w["maxZ"] - hz, -1.0, "z")):
            if gap < WALL_MARGIN:
                depth = 1.0 - max(gap, 0.0) / WALL_MARGIN
                if axis == "x":
                    push_x += sign * depth
                else:
                    push_z += sign * depth
        depth = min(1.0, max(abs(push_x), abs(push_z)))
        head_gap = min(hx - w["minX"], w["maxX"] - hx, hz - w["minZ"], w["maxZ"] - hz)
        # Food parked near a wall is allowed to pull the fly in, but only while the food
        # is closer to the head than the glass is; past that it is steering, not feeding.
        food = dist_of.get("sugar", math.inf) if self.sugar_present else math.inf
        near_food = food < WALL_FOOD_EXEMPT and food < head_gap
        steer = None
        if depth > 0.0 and not self.feeding_brake and not near_food:
            heading = yaw + GAIT_HEADING
            inward = math.atan2(push_x, push_z)
            err = math.atan2(math.sin(inward - heading), math.cos(inward - heading))
            if abs(err) > WALL_ALIGNED:
                # positive yaw turns right
                steer = ("steer_r" if err > 0 else "steer_l", self.rate_hz * (0.5 + 0.5 * depth))
        if (steer is None) != (self.wall_steer is None):
            print(f"  wall steering {'-> ' + steer[0] if steer else 'off'} at ({x:.2f}, {z:.2f})")
        self.wall_steer = steer

        # --- chemotaxis: steer toward the sugar cube while foraging ---
        if self.autonomous and self.sugar_present:
            sx, _sy, sz = self.props["sugar"]
            tx, tz = sx - x, sz - z
            n = math.hypot(tx, tz)
            if n > 1e-4:
                cross = (fx * tz - fz * tx) / n
                facing = (fx * tx + fz * tz) / n
                turn = clamp(-cross * 3.0, -1.0, 1.0)
                stop = self.in_range["sugar"] or dist_of["sugar"] < NAV_STOP
                forward = 0.0 if stop else (0.35 if facing < -0.3 else 0.85)
                if self.in_range["sugar"]:
                    turn = 0.0  # mouth is at the food: turning toward its centre only orbits it
                bias = clamp(cross * 2 + 0.5, 0.0, 1.0)
                self.navigate(forward, turn, NAV_ANTENNAL_HZ * bias, NAV_ANTENNAL_HZ * (1 - bias))
        self.apply_stimuli()

    def payload(self) -> dict[str, Any]:
        # The one host transfer per chunk. Rounded on the way out: the EMA leaves
        # denormals like 2.3e-43 in silent groups, which are noise in the JSON and
        # slow on any consumer without flush-to-zero.
        d = {k: round(v, 5) for k, v in zip(self.rates.names, self.rates.drive.tolist())}
        sim_ms = self.chunk * self.net.p.dt
        cortex_drives, telemetry = self.sample_array()
        exc = float(self.rates.total[self.rates.names.index("_exc")])
        inh = float(self.rates.total[self.rates.names.index("_inh")])
        ei = exc / inh if inh > 0 else (float("inf") if exc > 0 else 0.0)
        if ei == float("inf"):
            ei = 999.0
        return {
            "fly_drives": {
                "dnp09": d.get("dnp09", 0.0),
                "mdn": d.get("mdn", 0.0),
                "dna_l": d.get("dna_l", 0.0),
                "dna_r": d.get("dna_r", 0.0),
                "dnp01": d.get("dnp01", 0.0),
                "dng11": d.get("dng11", 0.0),
            },
            "cortex_drives": {**cortex_drives, "executive_override": round(self.executive, 3),
                              "executive_engaged": self.executive_engaged()},
            "hardware_telemetry": telemetry,
            "circuit": {
                "alive": self.n_alive,
                "total": self.net.n,
                "lesions": dict(sorted(self.lesions.items())),
                "ei_ratio": round(ei, 4),
                "exc_spikes": int(exc),
                "inh_spikes": int(inh),
                "suppression": None if self.suppression is None else round(self.suppression, 4),
                "mn9_baseline": round(self.mn9_baseline, 4),
                "active_count": int(exc + inh),
            },
            "world": self.world(),
            "morphs": {"tongue_out": d.get("mn9", 0.0)},
            "clips": {"groom_face": d.get("dng11", 0.0) > 0.5},
            "sim": {
                "t_ms": round(self.sim_ms, 1),
                "stimulus": sorted(self.active | self.contact),
                "realtime": round(sim_ms / 1000.0 / max(self.wall_s, 1e-6), 3),
                "neck": [d.get("neck_l", 0.0), d.get("neck_r", 0.0)],
                "array_online": self.mea.online,
                "satiety": round(self.satiety, 4),
                "fed": self.fed,
                "bypass": sorted(set(self.stimuli_now()) & self.bypass),
                "autonomous": self.autonomous,
                "behaviour": self.behaviour,
                "escape_seq": self.escape_seq,
                "loom": "loom" in self.timed,
                "threat": self.threat,
                "navigating": self.sim_ms < self.nav_until and bool(self.nav),
                "senses": {k: [round(i, 3), round(br, 3)] for k, (i, br) in self.senses_now().items()},
                "feeding_brake": self.feeding_brake,
                "wall_steer": self.wall_steer[0] if self.wall_steer else None,
            },
        }


async def serve(args) -> None:
    sim = SimRunner(args.device, args.chunk, args.tau, args.saturation, args.rate,
                    args.sat_gain, args.sat_tau, args.sat_full, args.sat_hungry)
    clients: set[Any] = set()
    print(f"neurons {sim.net.n:,}  synapses {sim.bundle['val'].numel():,}")
    print(f"readouts: {', '.join(f'{n}({int(s)})' for n, s in zip(sim.rates.names, sim.rates.sizes.tolist()))}")
    print(f"stimuli: {sorted(sim.stim_idx)}   (BYPASS, not a connectome path: {sorted(sim.bypass)})")
    print(f"satiety: +{args.sat_gain}/MN9 spike, decay tau {args.sat_tau:.0f} ms, "
          f"feed gate {args.sat_hungry}..{args.sat_full}")
    print(f"cortical array: {'configured' if sim.cortex.configured else 'NOT configured'}, "
          f"poll every {args.cortex_interval}s")

    async def authenticate(ws, peer) -> bool | None:
        """First message must be an auth frame. Returns is_admin, or None to reject.

        A wrong token is treated as an attack, not as a public visitor: it closes
        the connection instead of quietly downgrading. When no ADMIN_TOKEN is
        configured, admin is granted to loopback peers only -- local development
        keeps working, and a remote client can never become admin without a token.
        """
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=AUTH_TIMEOUT_S)
        except (TimeoutError, asyncio.TimeoutError, websockets.ConnectionClosed):
            return None
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(msg, dict) or msg.get("type") != "auth":
            return None

        token = msg.get("token")
        if isinstance(token, str) and token:
            if admin_token and secrets.compare_digest(token, admin_token):
                return True
            print(f"  auth: bad token from {peer}, rejecting")
            return None
        if not admin_token and peer in LOCAL_HOSTS:
            return True  # no token configured: trust loopback only
        return False

    async def handler(ws):
        peer = getattr(ws, "remote_address", ("?",))[0]
        role = await authenticate(ws, peer)
        if role is None:
            await ws.close(1008, "authentication required")
            return
        is_admin = role
        ws.is_admin = is_admin  # visible on the connection for introspection
        # The world snapshot rides on the handshake, so a reload renders the shared
        # world immediately instead of hardcoded defaults.
        # The real sensing radii ride along too, so the admin field overlay draws the
        # thresholds this server applies rather than a copy that could drift.
        await ws.send(json.dumps({"type": "auth_ok", "role": "admin" if is_admin else "public",
                                  "world": sim.world(),
                                  "fields": {"sense": SENSE_RADIUS, "reflex": REFLEX,
                                             "reflex_exit": REFLEX * REFLEX_EXIT, "head_ahead": HEAD_AHEAD}}))

        clients.add(ws)
        sim.alive_dirty = True  # a new client has never seen the alive mask
        print(f"client connected ({len(clients)} total) from {peer} as "
              f"{'ADMIN' if is_admin else 'public'}")
        # Token bucket held in locals rather than a dict keyed by connection:
        # one less lookup per message, and it cannot leak when a client goes away.
        tokens = RATE_BURST
        last_refill = time.monotonic()
        try:
            async for raw in ws:
                now = time.monotonic()
                tokens = min(RATE_BURST, tokens + (now - last_refill) * RATE_PER_SEC)
                last_refill = now
                if tokens < 1.0:
                    print(f"  rate limit exceeded by {peer}, closing")
                    await ws.close(1008, "rate limit exceeded")
                    break
                tokens -= 1.0

                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue

                # Spectators only: a public connection that sends anything after
                # auth is closed. Nothing a visitor sends is ever acted on.
                if not is_admin:
                    print(f"  public client {peer} sent a command, closing (spectator only)")
                    await ws.close(1008, "spectator connection")
                    break

                # Inbound is untrusted text from a browser: only ever used to look
                # up a known stimulus name, never to index or evaluate anything.
                name = msg.get("stimulus")
                if isinstance(name, str) and name in sim.stim_idx:
                    sim.set_stimulus(name, bool(msg.get("state")))
                    print(f"  stimulus {name} -> {bool(msg.get('state'))}  active={sorted(sim.active)}")
                    continue

                action = msg.get("action")
                if action == "lesion":
                    target = msg.get("target")
                    try:
                        fraction = float(msg.get("fraction", 1.0))
                    except (TypeError, ValueError):
                        fraction = 0.0
                    if isinstance(target, str) and sim.set_lesion(target, fraction):
                        print(f"  lesion {target} @ {fraction:.2f} -> "
                              f"{sim.n_alive:,}/{sim.net.n:,} alive  active={sim.lesions}")
                    else:
                        print(f"  lesion target rejected: {target!r}")
                elif action == "prop":
                    name = msg.get("name")
                    try:
                        ok = isinstance(name, str) and sim.set_prop(
                            name, float(msg.get("x")), float(msg.get("y")), float(msg.get("z")))
                    except (TypeError, ValueError):
                        ok = False
                    if ok:
                        print(f"  prop {name} -> {sim.props[name]}")
                elif action == "deploy":
                    name = msg.get("name")
                    if isinstance(name, str) and sim.deploy(name):
                        print(f"  deployed {name} -> {sim.props[name]}")
                elif action == "reset_fly":
                    sim.reset_fly()
                    print("  fly recentred")
                elif action == "threat":
                    sim.set_threat(bool(msg.get("state")))
                    print(f"  threat in range -> {sim.threat}")
                elif action == "flush":
                    sim.flush()
                    print("  voltages flushed (lesions and stimuli kept)")
                elif action == "loom":
                    sim.fire_loom()
                    print(f"  loom burst ({LOOM_MS:.0f} ms)")
                elif action == "autonomous":
                    sim.set_autonomous(bool(msg.get("state")))
                    print(f"  autonomous -> {sim.autonomous}")
                elif action == "restore":
                    sim.restore_connectome()
                    print(f"  connectome restored -> {sim.n_alive:,} alive")
        except websockets.ConnectionClosed:
            pass
        finally:
            clients.discard(ws)
            print(f"client gone ({len(clients)} left)")

    async def cortex_loop():
        """Poll the culture on its own slow cadence, independent of the sim loop."""
        if not sim.cortex.configured:
            print("cortical array: no credentials, array offline (head stays on the fly)")
            return
        while True:
            out = await sim.cortex.poll(sim.cortex_state(), sim.satiety, sim.fed, sim.senses_now())
            sim.mea.set_target(
                out.get("neck_yaw", 0.0),
                out.get("neck_pitch", 0.0),
                out.get("human_hands_active", False),
                online=sim.cortex.online,
                forward=out.get("forward_drive", 0.0),
                lateral=out.get("lateral_steer", 0.0),
            )
            previous, sim.executive = sim.executive, float(out.get("executive_override", 0.0))
            if (previous > EXEC_THRESHOLD) != (sim.executive > EXEC_THRESHOLD):
                label = ("ENGAGED" if sim.executive_engaged() else "requested, no threat in range") \
                    if sim.executive > EXEC_THRESHOLD else "released"
                print(f"  executive override {sim.executive:.2f} ({label}) "
                      f"state={sim.cortex_state()}")
            await asyncio.sleep(args.cortex_interval)

    async def pump():
        while True:
            # to_thread keeps the GPU chunk off the event loop, so inbound
            # stimulus messages are handled between chunks instead of queueing
            # behind a blocking run.
            await asyncio.to_thread(sim.run_chunk)
            sim.step_world()
            if clients:
                msg = json.dumps(sim.payload())
                frames = [msg, sim.spike_frame]
                if sim.alive_dirty and sim.alive_frame:
                    frames.append(sim.alive_frame)
                    sim.alive_dirty = False
                for frame in frames:
                    await asyncio.gather(*(c.send(frame) for c in list(clients)), return_exceptions=True)
            else:
                await asyncio.sleep(0.05)  # idle: do not spin the GPU for nobody

    allowed_origin = read_env("ALLOWED_ORIGIN")
    admin_token = read_env("ADMIN_TOKEN")
    if not admin_token:
        print("WARNING: no ADMIN_TOKEN set -- admin role is granted to loopback "
              "clients only; remote clients are public")

    def check_origin(connection, request):
        origin = request.headers.get("Origin")
        if origin is None:
            # No Origin header means a non-browser client (our probes, CLI tools).
            # Browsers always send one, so this cannot be a cross-site request.
            return None
        if origin_allowed(origin, allowed_origin):
            return None
        print(f"  rejected connection from origin {origin!r}")
        return connection.respond(http.HTTPStatus.FORBIDDEN, "origin not allowed\n")

    if admin_token:
        print(f"admin URL: http://localhost:5173/?admin=true&token={admin_token}")
    print(f"auth: {'token required for admin' if admin_token else 'loopback = admin'}"
          f"   public: spectator (any command closes the connection)")
    print(f"origins: localhost (any port)"
          f"{', ' + allowed_origin if allowed_origin else ''}"
          f"   max message {MAX_MESSAGE_BYTES} B   rate {RATE_PER_SEC:.0f}/s (burst {RATE_BURST:.0f})")

    async with websockets.serve(
        handler,
        args.host,
        args.port,
        process_request=check_origin,
        max_size=MAX_MESSAGE_BYTES,
    ):
        print(f"listening on ws://{args.host}:{args.port}  "
              f"(chunk {args.chunk} steps = {args.chunk * sim.net.p.dt:.0f} ms sim)")
        cortex = asyncio.create_task(cortex_loop())
        try:
            await pump()
        finally:
            cortex.cancel()


def main() -> int:
    ap = argparse.ArgumentParser(description="LIF -> browser WebSocket bridge")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--chunk", type=int, default=250, help="sim steps between broadcasts")
    ap.add_argument("--tau", type=float, default=35.0, help="rate EMA time constant, ms")
    ap.add_argument("--saturation", type=float, default=80.0, help="Hz mapped to a drive of 1.0")
    ap.add_argument("--rate", type=float, default=150.0, help="Poisson drive of stimulated cells, Hz")
    ap.add_argument("--sat-gain", type=float, default=0.005, help="satiety added per MN9 spike")
    ap.add_argument("--sat-tau", type=float, default=3000.0, help="satiety decay time constant, ms")
    ap.add_argument("--sat-full", type=float, default=0.5, help="satiety at which feeding stops")
    ap.add_argument("--sat-hungry", type=float, default=0.15, help="satiety at which feeding resumes")
    ap.add_argument("--cortex-interval", type=float, default=2.5,
                    help="seconds between cortical culture polls")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

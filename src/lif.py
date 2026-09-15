#!/usr/bin/env python3
"""Sparse leaky integrate-and-fire network over the FlyWire FAFB v783 connectome.

Parameters follow Shiu et al. 2024 (Nature). Per-step state update, with tau_m
the membrane and tau_s the synaptic time constant:

    g <- g * exp(-dt/tau_s)                       synaptic current decays
    v <- v + (v_rst - v + g) * (1 - exp(-dt/tau_m))
    spike where v > v_th and not refractory
    g <- g + w_syn * (W @ spikes_delayed)         arrival, 1.8 ms late

Both integrators are exponential-Euler rather than forward Euler: exact for the
decay term and unconditionally stable, for the cost of two precomputed scalars.

Run the validation bench:  python src/lif.py
"""
from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "connectome_v783.pt"


@dataclass(frozen=True)
class Params:
    """Shiu et al. 2024. Voltages in mV, times in ms."""

    dt: float = 0.1
    v_rst: float = -52.0  # rest and reset potential
    v_th: float = -45.0  # spike threshold
    tau_m: float = 20.0  # membrane time constant
    tau_s: float = 5.0  # synaptic time constant
    t_refrac: float = 2.2
    t_delay: float = 1.8
    w_syn: float = 0.275  # mV per synapse
    # Poisson drive of stimulated neurons: each event injects w_syn * f_poi mV.
    # 68.75 mV against a 7 mV threshold gap means an event always fires the cell,
    # which is the point -- it is a stand-in for the sensory periphery, not a synapse.
    f_poi: float = 250.0

    @property
    def refrac_steps(self) -> int:
        return int(round(self.t_refrac / self.dt))

    @property
    def delay_steps(self) -> int:
        return max(1, int(round(self.t_delay / self.dt)))


class LIFNetwork(nn.Module):
    """One `dt` step per forward() call. All state lives on the GPU as buffers.

    Every update is in-place (`add_`, `mul_`, `masked_fill_`) so the step allocates
    only the spike vector and the mat-vec result; VRAM stays flat across a run.
    """

    def __init__(self, crow, col, val, n: int, p: Params = Params(), device="cuda"):
        super().__init__()
        self.p = p
        self.n = n
        self.device = torch.device(device)

        # W[post, pre] -- rows are postsynaptic, so a step is a plain mat-vec.
        self.W = torch.sparse_csr_tensor(
            crow.to(self.device),
            col.to(self.device),
            val.to(self.device),
            size=(n, n),
        )

        def z(dtype=torch.float32):
            return torch.zeros(n, dtype=dtype, device=self.device)

        self.register_buffer("v", torch.full((n,), p.v_rst, device=self.device))
        self.register_buffer("g", z())
        self.register_buffer("refrac", z(torch.int32))
        # Ring buffer of spikes in flight; a spike lands delay_steps later.
        self.register_buffer("delay_buf", torch.zeros(p.delay_steps, n, device=self.device))
        self.register_buffer("stim_mask", z(torch.bool))
        # Per-neuron Poisson rate in Hz. A vector rather than one scalar so a
        # single step can carry several stimuli at different strengths -- which is
        # what lets satiety attenuate sugar without touching anything else.
        self.register_buffer("stim_hz", z())
        # Scratch, allocated once and reused, so the step loop does not churn VRAM.
        self.register_buffer("_dv", z())
        self.register_buffer("_free", z(torch.bool))
        self.register_buffer("_rand", z())
        self.register_buffer("spikes_f", z())
        # Ablation. `alive` gates spike output; `dead` is its complement, kept as a
        # buffer so the step never allocates one. Lesioning only rewrites these two
        # vectors -- the sparse matrix is never touched or rebuilt.
        self.register_buffer("alive", torch.ones(n, dtype=torch.bool, device=self.device))
        self.register_buffer("dead", z(torch.bool))
        self.n_alive = n

        self.decay_s = float(torch.exp(torch.tensor(-p.dt / p.tau_s)))
        self.alpha_m = float(1.0 - torch.exp(torch.tensor(-p.dt / p.tau_m)))
        self.step_i = 0

    def lesion(self, idx: torch.Tensor, kill: bool = True) -> int:
        """Ablate or restore neurons in place. Returns the surviving count."""
        if idx.numel():
            self.alive.index_fill_(0, idx.to(self.device), not kill)
        torch.logical_not(self.alive, out=self.dead)
        self.n_alive = int(self.alive.sum())
        return self.n_alive

    def restore_all(self) -> int:
        self.alive.fill_(True)
        self.dead.fill_(False)
        self.n_alive = self.n
        return self.n_alive

    def reset(self) -> None:
        self.v.fill_(self.p.v_rst)
        self.g.zero_()
        self.refrac.zero_()
        self.delay_buf.zero_()
        self.step_i = 0

    def clear_stimulus(self) -> None:
        self.stim_mask.zero_()
        self.stim_hz.zero_()

    def add_stimulus(self, idx: torch.Tensor, hz: float) -> None:
        """Layer a population onto the current stimulus without clearing others.

        Shiu disables the refractory period on stimulated cells so the drive is not
        rate-limited by the very neuron it is meant to be clamping. Where layers
        overlap the later call wins, which is how a strong stimulus overrides the
        low-rate background noise on the same cells.
        """
        if idx.numel():
            idx = idx.to(self.device)
            self.stim_mask.index_fill_(0, idx, True)
            self.stim_hz.index_fill_(0, idx, hz)

    def set_stimulus(self, idx: torch.Tensor, hz: float = 0.0) -> None:
        """Replace the whole stimulus: `idx` driven at `hz`, everything else off."""
        self.clear_stimulus()
        self.add_stimulus(idx, hz)

    def scale_stimulus(self, idx: torch.Tensor, hz: float) -> None:
        """Retune one population's drive in place, leaving the others alone."""
        if idx.numel():
            self.stim_hz.index_fill_(0, idx.to(self.device), hz)

    @torch.no_grad()
    def forward(self, gain: float = 1.0) -> torch.Tensor:
        p = self.p

        # --- synaptic input arriving now (emitted delay_steps ago) -------------
        # No `.any()` guard: that reads a GPU value and stalls the pipeline every
        # step, which costs far more than the mat-vec it would occasionally skip.
        slot = self.step_i % p.delay_steps
        self.g.add_(torch.mv(self.W, self.delay_buf[slot]), alpha=p.w_syn)

        # --- decay, then integrate --------------------------------------------
        self.g.mul_(self.decay_s)

        torch.le(self.refrac, 0, out=self._free)
        # dv = (v_rst - v + g) * (1 - exp(-dt/tau_m)), frozen while refractory
        torch.sub(self.g, self.v, out=self._dv)
        self._dv.add_(p.v_rst).mul_(self.alpha_m).mul_(self._free)
        self.v.add_(self._dv)

        # --- external drive ----------------------------------------------------
        # stim_hz is zero everywhere outside the stimulus, so the comparison is a
        # no-op for the rest of the network and needs no mask of its own.
        torch.rand(self.n, device=self.device, out=self._rand)
        events = self._rand < self.stim_hz * (gain * p.dt * 1e-3)
        self.v.add_(events, alpha=p.w_syn * p.f_poi)

        # --- threshold ---------------------------------------------------------
        # An ablated neuron emits nothing: it is cut out of the network's output
        # while its own state keeps integrating harmlessly. Held at rest below so
        # a silenced cell cannot drift.
        spikes = (self.v > p.v_th) & (self._free | self.stim_mask) & self.alive
        self.v.masked_fill_(spikes, p.v_rst)
        self.g.masked_fill_(spikes, 0.0)
        self.refrac.masked_fill_(spikes & ~self.stim_mask, p.refrac_steps)

        self.v.masked_fill_(self.dead, p.v_rst)
        self.refrac.sub_(1).clamp_(min=0)
        self.spikes_f.copy_(spikes)
        self.delay_buf[slot] = self.spikes_f
        self.step_i += 1
        return spikes


class RateFilter:
    """Exponential moving average of population firing rate, entirely on the GPU.

        r <- r * exp(-dt/tau) + spikes_in_group / tau

    Group membership is a dense (groups x n) matrix -- a handful of rows over
    139k columns is ~4 MB and one trivial mat-vec, and it keeps the whole update
    to three fused kernels with no indexing or host round-trip.

    `drive` is the normalised 0..1 output: mean per-neuron rate over a biological
    saturation frequency. Every tensor is preallocated; update() allocates nothing.
    """

    def __init__(self, groups: dict[str, torch.Tensor], n: int, dt: float,
                 tau_ms: float = 35.0, saturation_hz: float = 60.0, device="cuda"):
        self.names = list(groups)
        self.tau = tau_ms
        self.device = torch.device(device)
        k = len(self.names)

        self.G = torch.zeros(k, n, device=self.device)
        sizes = torch.zeros(k, device=self.device)
        for i, name in enumerate(self.names):
            idx = groups[name].to(self.device)
            self.G[i, idx] = 1.0
            sizes[i] = max(1, idx.numel())

        self.decay = float(torch.exp(torch.tensor(-dt / tau_ms)))
        # r is spikes/ms summed over the group; this turns it into a 0..1 drive
        self.scale = (1000.0 / (sizes * saturation_hz)).to(self.device)

        self.counts = torch.zeros(k, device=self.device)
        # Running spike total per group, for integrators that need counts rather
        # than a rate (satiety). Reset by whoever consumes it.
        self.total = torch.zeros(k, device=self.device)
        self.rate = torch.zeros(k, device=self.device)
        self.drive = torch.zeros(k, device=self.device)
        self.sizes = sizes

    def reset(self) -> None:
        self.rate.zero_()
        self.drive.zero_()
        self.total.zero_()

    @torch.no_grad()
    def update(self, spikes_f: torch.Tensor) -> None:
        torch.mv(self.G, spikes_f, out=self.counts)
        self.total.add_(self.counts)
        self.rate.mul_(self.decay).add_(self.counts, alpha=1.0 / self.tau)
        torch.mul(self.rate, self.scale, out=self.drive)
        self.drive.clamp_(0.0, 1.0)

    def hz(self) -> torch.Tensor:
        """Mean per-neuron rate in Hz (allocates -- diagnostics only)."""
        return self.rate * 1000.0 / self.sizes


# ---------------------------------------------------------------------------


def load(device: str = "cuda") -> tuple[LIFNetwork, dict]:
    if not CACHE.exists():
        sys.exit(f"missing {CACHE} -- run: python src/ingest.py")
    b = torch.load(CACHE, weights_only=False)
    net = LIFNetwork(b["crow"], b["col"], b["val"], b["n"], device=device)
    return net, b


def run_bench(net: LIFNetwork, b: dict, ms: float, n_grn: int, rate: float, seed: int) -> dict:
    torch.manual_seed(seed)
    p = net.p
    steps = int(round(ms / p.dt))

    grn = b["sugar_grn"][:n_grn]
    mn9 = b["mn9"].to(net.device)

    net.reset()
    net.set_stimulus(grn, rate)

    # Counters stay on the GPU and come back once at the end. Reading them inside
    # the loop would sync every step and dominate the runtime.
    ever = torch.zeros(net.n, dtype=torch.bool, device=net.device)
    per_step_total = torch.zeros(steps, dtype=torch.int32, device=net.device)
    per_step_mn9 = torch.zeros(steps, len(mn9), dtype=torch.int32, device=net.device)

    if net.device.type == "cuda":
        torch.cuda.synchronize()
    t0 = time.time()
    for i in range(steps):
        s = net()
        ever |= s
        per_step_total[i] = s.sum()
        per_step_mn9[i] = s[mn9]
    if net.device.type == "cuda":
        torch.cuda.synchronize()
    wall = time.time() - t0

    mn9_counts = per_step_mn9.cpu()
    mn9_spikes = int(mn9_counts.sum())
    per_cell = mn9_counts.sum(0).tolist()
    mn9_times = [(i + 1) * p.dt for i in torch.nonzero(mn9_counts.sum(1)).flatten().tolist()]
    total = int(per_step_total.sum())

    active = ever.clone()
    active[grn.to(net.device)] = False  # the driven cells are inputs, not a result
    return {
        "steps": steps,
        "wall_s": wall,
        "mn9_spikes": mn9_spikes,
        "mn9_per_cell": per_cell,
        "mn9_times": mn9_times,
        "active_excl_stim": int(active.sum()),
        "active_incl_stim": int(ever.sum()),
        "total_spikes": total,
    }


def selfcheck() -> int:
    """Analytic check of the membrane integrator on a network with no synapses.

    Catches sign and in-place-aliasing errors in the v update, which a whole-brain
    run hides completely -- it just looks like a quiet network.
    """
    import math

    p = Params()
    n = 4
    empty = torch.zeros(n + 1, dtype=torch.int64)
    net = LIFNetwork(empty, torch.zeros(0, dtype=torch.int64), torch.zeros(0), n,
                     p, device="cpu")

    # 1. no input -> sits at rest forever
    for _ in range(500):
        net()
    assert torch.allclose(net.v, torch.full((n,), p.v_rst), atol=1e-4), net.v
    assert net.v.isfinite().all()

    # 2. constant g -> v relaxes to v_rst + g with time constant tau_m
    net.reset()
    g0 = 5.0
    ms = 10.0
    for _ in range(int(ms / p.dt)):
        net.g.fill_(g0 / net.decay_s)  # cancel the decay applied inside the step
        net()
    want = p.v_rst + g0 * (1 - math.exp(-ms / p.tau_m))
    assert abs(float(net.v[0]) - want) < 0.05, f"v={float(net.v[0]):.3f} want {want:.3f}"

    # 3. drive past threshold -> spikes, then holds for the refractory period
    # g is held (it decays inside every step), so the drive stays suprathreshold
    net.reset()
    fired = []
    for _ in range(120):
        net.g.fill_(50.0 / net.decay_s)
        fired.append(int(net()[0]))
    assert sum(fired) >= 1, "suprathreshold drive produced no spike"
    first = fired.index(1)
    gap = p.refrac_steps
    assert not any(fired[first + 1 : first + gap]), "spiked inside the refractory period"

    print("selfcheck ok: rest, relaxation to v_rst+g, threshold and refractory")
    return 0


def run_controls(net: LIFNetwork, b: dict, args) -> None:
    """A PASS on the sugar bench only means something if other stimuli do nothing.

    MN9 drives proboscis extension, which sugar triggers and bitter does not. If a
    random population fired it just as well, the result would be a property of the
    drive strength rather than of the circuit.
    """
    import numpy as np
    import pandas as pd

    cls = pd.read_csv(ROOT / "data" / "classification.csv.gz")
    root = b["root_ids"].numpy()
    known = set(root.tolist())
    index_of = pd.Series(np.arange(len(root)), index=root)

    def to_idx(ids):
        ids = [int(i) for i in ids if int(i) in known][: args.grns]
        return torch.from_numpy(index_of.loc[ids].to_numpy(np.int64).copy())

    bitter = cls.loc[cls.sub_class == "bitter", "root_id"].to_numpy()
    rng = np.random.default_rng(args.seed)
    rand = rng.choice(cls.loc[cls.super_class == "central", "root_id"].to_numpy(), args.grns, replace=False)

    print("\ncontrols (same drive, same duration):")
    for name, ids in (("sugar GRNs", b["sugar_grn_root_ids"].tolist()),
                      ("bitter GRNs", bitter),
                      ("random central", rand)):
        probe = dict(b)
        probe["sugar_grn"] = to_idx(ids)
        c = run_bench(net, probe, args.ms, args.grns, args.rate, args.seed)
        print(f"  {name:<16} MN9 per cell {str(c['mn9_per_cell']):<10} "
              f"active {c['active_excl_stim']:>5}   total {c['total_spikes']:>6}")


def main() -> int:
    ap = argparse.ArgumentParser(description="MN9 proboscis-extension validation bench")
    ap.add_argument("--selfcheck", action="store_true", help="analytic integrator test, no data needed")
    ap.add_argument("--controls", action="store_true", help="also run bitter and random-population controls")
    ap.add_argument("--ms", type=float, default=300.0)
    ap.add_argument("--grns", type=int, default=20)
    ap.add_argument("--rate", type=float, default=150.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()
    if args.selfcheck:
        return selfcheck()

    print(f"device: {args.device}", end="")
    if args.device == "cuda":
        print(f"  ({torch.cuda.get_device_name(0)})")
    else:
        print("  (CUDA unavailable)")

    net, b = load(args.device)
    p = net.p
    print(f"neurons {net.n:,}   synapses {b['val'].numel():,}   "
          f"min_syn {b['min_syn']}   signing {b['nt_mode']}")
    print(f"params  dt {p.dt} ms  v_rst {p.v_rst}  v_th {p.v_th}  tau_m {p.tau_m}  "
          f"tau_s {p.tau_s}  refrac {p.t_refrac}  delay {p.t_delay} ({p.delay_steps} steps)  "
          f"w_syn {p.w_syn}")
    print(f"stimulus: {args.grns} labellar sugar GRNs @ {args.rate} Hz for {args.ms} ms")
    print(f"readout:  MN9 = {b['mn9_root_ids'].tolist()}\n")

    r = run_bench(net, b, args.ms, args.grns, args.rate, args.seed)

    print(f"ran {r['steps']:,} steps in {r['wall_s']:.2f} s "
          f"({r['steps'] / r['wall_s']:,.0f} steps/s, "
          f"{r['wall_s'] / (args.ms * 1e-3):.1f}x slower than real time)")
    per_cell = ", ".join(
        f"{rid}: {c}" for rid, c in zip(b["mn9_root_ids"].tolist(), r["mn9_per_cell"])
    )
    print(f"  MN9 spikes          {r['mn9_spikes']:>8}      ({per_cell})")
    print(f"                                       expected ~20 per cell; Shiu read out")
    print(f"                                       a single MN9, its partner is lost in v783")
    print(f"  neurons active      {r['active_excl_stim']:>8}      (expected ~350, stimulus excluded)")
    print(f"  total spikes        {r['total_spikes']:>8}")
    if r["mn9_times"]:
        print(f"  first MN9 spike at  {r['mn9_times'][0]:>8.1f} ms")
    if torch.cuda.is_available() and args.device == "cuda":
        print(f"  peak VRAM           {torch.cuda.max_memory_allocated() / 2**20:>8.0f} MiB")

    ok_mn9 = all(5 <= c <= 60 for c in r["mn9_per_cell"])
    ok_act = 100 <= r["active_excl_stim"] <= 1200
    print(f"\nverdict: MN9 {'PASS' if ok_mn9 else 'FAIL'}, "
          f"activity {'PASS' if ok_act else 'FAIL'}")

    if args.controls:
        run_controls(net, b, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())

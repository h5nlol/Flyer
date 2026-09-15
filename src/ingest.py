#!/usr/bin/env python3
"""Build a signed sparse connectome matrix from the FlyWire FAFB v783 CSVs.

Output cache (data/connectome_v783.pt) holds the adjacency in CSR form plus the
index maps the simulation and the bench need.

Orientation matters: the matrix is stored as W[post, pre], so one simulation step
is a plain sparse mat-vec  I = W @ spikes  with no transpose. Storing it the other
way round would force a CSR transpose every step.

Two facts about the raw file that are easy to get wrong:
  * connections.csv.gz is NOT pre-filtered by synapse count -- it starts at 1.
    Shiu et al. threshold at 5, so --min-syn defaults to 5.
  * Rows are per (pre, post, neuropil), so one connected pair can appear up to 18
    times. They must be aggregated or most of the pair's weight is thrown away.

Usage:  python src/ingest.py [--min-syn 5] [--nt-mode per_neuron|per_edge]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# Strict biological signing. Modulators carry no fast current in this model, but
# their edges are counted and reported rather than silently dropped.
NT_SIGN = {"ACH": 1.0, "GABA": -1.0, "GLUT": -1.0, "DA": 0.0, "SER": 0.0, "OCT": 0.0}


def load_csvs(min_syn: int) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    for name in ("connections.csv.gz", "classification.csv.gz", "consolidated_cell_types.csv.gz"):
        if not (DATA / name).exists():
            sys.exit(f"missing {DATA / name} -- run scripts/download.sh first")

    con = pd.read_csv(
        DATA / "connections.csv.gz",
        usecols=["pre_root_id", "post_root_id", "syn_count", "nt_type"],
        dtype={"pre_root_id": np.int64, "post_root_id": np.int64, "syn_count": np.int32},
    )
    cls = pd.read_csv(DATA / "classification.csv.gz")
    typ = pd.read_csv(DATA / "consolidated_cell_types.csv.gz")

    raw_rows = len(con)
    con = con[con.syn_count >= min_syn]
    print(f"edges: {raw_rows:,} rows -> {len(con):,} at syn_count >= {min_syn}")
    return con, cls, typ


NT_CODE = {"ACH": 1, "GABA": 2, "GLUT": 3, "DA": 4, "SER": 5, "OCT": 6}


def neuron_transmitter(con: pd.DataFrame) -> pd.Series:
    """Winning transmitter per presynaptic neuron, by synapse-weighted majority."""
    votes = con.groupby(["pre_root_id", "nt_type"]).syn_count.sum().unstack(fill_value=0)
    return votes.idxmax(axis=1)


def neuron_signs(con: pd.DataFrame) -> pd.Series:
    """Dale's law: one transmitter per neuron, by synapse-weighted majority vote.

    FlyWire predicts transmitter per synapse, so a single neuron's edges disagree
    with each other. Letting each edge carry its own sign lets one cell be both
    excitatory and inhibitory, which no neuron is.
    """
    return neuron_transmitter(con).map(NT_SIGN).astype(np.float32)


def build(min_syn: int = 5, nt_mode: str = "per_neuron") -> dict:
    con, cls, typ = load_csvs(min_syn)

    # ---- signing -----------------------------------------------------------
    if nt_mode == "per_neuron":
        sign_of = neuron_signs(con)
        signs = con.pre_root_id.map(sign_of).to_numpy(np.float32)
        nt_named = sign_of.value_counts().to_dict()
        print(f"signing: Dale majority vote per neuron  {nt_named}")
    else:
        signs = con.nt_type.map(NT_SIGN).fillna(0.0).to_numpy(np.float32)
        print("signing: per edge (a neuron may be mixed -- not biological)")

    modulatory = int((signs == 0).sum())
    print(f"  modulatory/unknown edges zeroed: {modulatory:,} ({modulatory / len(con):.1%})")

    con = con.assign(w=signs * con.syn_count.to_numpy(np.float32))
    con = con[con.w != 0.0]

    # ---- aggregate the per-neuropil rows into one weight per pair ----------
    pairs = con.groupby(["pre_root_id", "post_root_id"], sort=False).w.sum().reset_index()
    pairs = pairs[pairs.w != 0.0]
    print(f"pairs: {len(pairs):,} signed connections after aggregation")

    # ---- contiguous indices ------------------------------------------------
    # Canonical neuron set is the classification table, plus anything that only
    # shows up in the edge list, so no edge is silently dropped.
    root_ids = np.union1d(
        cls.root_id.to_numpy(np.int64),
        np.union1d(pairs.pre_root_id.to_numpy(np.int64), pairs.post_root_id.to_numpy(np.int64)),
    )
    n = len(root_ids)
    index_of = pd.Series(np.arange(n, dtype=np.int64), index=root_ids)
    pre = index_of.loc[pairs.pre_root_id].to_numpy(np.int64)
    post = index_of.loc[pairs.post_root_id].to_numpy(np.int64)
    w = pairs.w.to_numpy(np.float32)
    print(f"neurons: {n:,}  ({len(cls):,} classified)")

    autapses = int((pre == post).sum())
    if autapses:
        keep = pre != post
        pre, post, w = pre[keep], post[keep], w[keep]
        print(f"  dropped {autapses:,} autapses")

    # ---- CSR, rows = postsynaptic ------------------------------------------
    # lexsort so column indices are ascending within each row: the canonical CSR
    # form. cuSPARSE happens to give the right answer without it, but plenty of
    # sparse code assumes it and silently misbehaves when it does not hold.
    order = np.lexsort((pre, post))
    post, pre, w = post[order], pre[order], w[order]
    crow = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(np.bincount(post, minlength=n), out=crow[1:])

    excit = float(w[w > 0].sum())
    inhib = float(-w[w < 0].sum())
    print(f"weights: {len(w):,} nnz   +{excit:,.0f} / -{inhib:,.0f} synapses (E:I = {excit / inhib:.2f})")

    return {
        "crow": torch.from_numpy(crow),
        "col": torch.from_numpy(pre),
        "val": torch.from_numpy(w),
        "n": n,
        "root_ids": torch.from_numpy(root_ids),
        "min_syn": min_syn,
        "nt_mode": nt_mode,
        "classification": cls,
        "cell_types": typ,
    }


# ---------------------------------------------------------------------------
# Population lookups the bench needs.
#
# MN9 is not labelled "MN9" anywhere in v783. Shiu's published MN9 root ids were
# assigned on v630; of the pair, 720575940660219265 survives into v783 and
# 720575940645521262 does not (lost to proofreading). The survivor is annotated
# ingestion_motor_neuron / cell type CB0701, which pins MN9 to CB0701 and
# recovers its contralateral partner as the other CB0701 cell.
# ---------------------------------------------------------------------------
MN9_ANCHOR = 720575940660219265
MN9_TYPE = "CB0701"


def mn9_ids(cls: pd.DataFrame, typ: pd.DataFrame) -> np.ndarray:
    motor = cls[cls.sub_class == "ingestion_motor_neuron"].merge(typ, on="root_id", how="left")
    ids = motor.loc[motor.primary_type == MN9_TYPE, "root_id"].to_numpy(np.int64)
    if MN9_ANCHOR not in set(ids):
        print(f"  WARNING: anchor {MN9_ANCHOR} is not typed {MN9_TYPE} in this build")
    return np.sort(ids)


# Labellar sugar GRNs stimulated in Shiu et al. 2024 (their figures notebook).
# These are published neuron ids, not a derived selection -- the annotation alone
# cannot tell a sugar cell from a water cell, and v783 lumps both under the
# sub_class "sugar/water". 20 of the 21 survive into v783.
#
# Note the hemisphere: the paper calls these the right-hemisphere GRNs, but every
# one of them carries side == "left" in the v783 classification table. Selecting
# by side == "right" gives a disjoint set that is measurably too weak to fire MN9.
SHIU_SUGAR_GRN = [
    720575940624963786, 720575940630233916, 720575940637568838,
    720575940638202345, 720575940617000768, 720575940630797113,
    720575940632889389, 720575940621754367, 720575940621502051,
    720575940640649691, 720575940639332736, 720575940616885538,
    720575940639198653, 720575940620900446, 720575940617937543,
    720575940632425919, 720575940633143833, 720575940612670570,
    720575940628853239, 720575940629176663, 720575940611875570,
]


def sugar_grn_ids(cls: pd.DataFrame, side: str | None = "left", limit: int | None = None) -> np.ndarray:
    """Labellar sugar/water GRNs by annotation. All 129 enter via MxLbN."""
    grn = cls[(cls.super_class == "sensory") & (cls.sub_class == "sugar/water") & (cls.nerve == "MxLbN")]
    if side:
        grn = grn[grn.side == side]
    ids = np.sort(grn.root_id.to_numpy(np.int64))
    return ids[:limit] if limit else ids


# ---------------------------------------------------------------------------
# Readout groups: the populations whose firing rate drives the browser.
#
# Steering is split by side because DNa01/DNa02 turn the fly toward the side they
# sit on, so the left and right cells are genuinely different output channels.
# ---------------------------------------------------------------------------
READOUT_TYPES: dict[str, tuple[str, ...]] = {
    "dnp09": ("DNp09",),  # forward walking command
    "mdn": ("MDN",),  # moonwalker, backward walking
    "dna_l": ("DNa01", "DNa02"),  # steering, left cells only
    "dna_r": ("DNa01", "DNa02"),  # steering, right cells only
    "dng11": ("DNg11",),  # grooming command
    "dnp01": ("DNp01",),  # giant fiber, escape command
}
READOUT_SIDE = {"dna_l": "left", "dna_r": "right"}


def readout_groups(cls: pd.DataFrame, typ: pd.DataFrame) -> dict[str, np.ndarray]:
    m = typ.merge(cls, on="root_id", how="left")
    groups: dict[str, np.ndarray] = {}
    for name, types in READOUT_TYPES.items():
        sel = m[m.primary_type.isin(types)]
        side = READOUT_SIDE.get(name)
        if side:
            sel = sel[sel.side == side]
        groups[name] = np.sort(sel.root_id.to_numpy(np.int64))

    groups["mn9"] = mn9_ids(cls, typ)
    neck = cls[cls.sub_class == "neck_motor_neuron"]
    groups["neck_l"] = np.sort(neck.loc[neck.side == "left", "root_id"].to_numpy(np.int64))
    groups["neck_r"] = np.sort(neck.loc[neck.side == "right", "root_id"].to_numpy(np.int64))
    return groups


# ---------------------------------------------------------------------------
# Brain scan export: static geometry for the browser's point-cloud view.
# ---------------------------------------------------------------------------
WEB_MODELS = ROOT / "web" / "public" / "models"

# Per-neuron class for colouring, one byte each. Kept static so the live spike
# frames only ever carry *which* neurons fired, never what kind they are.
BRAIN_CLASS = {0: 0, 1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3}  # nt_code -> unknown/exc/inh/mod


def export_brain(root_ids: np.ndarray, nt_code: np.ndarray) -> None:
    """Write brain_coords.bin (float32 xyz) and brain_class.bin (uint8), index-aligned.

    Coordinates are nm in FAFB. A neuron spans several supervoxel rows a few um
    apart, so each gets its mean position. The cloud is centred on its bounding
    box and scaled so the longest axis spans 2 units. FAFB's y axis points down
    the image stack, so it is flipped to put the dorsal brain on top.
    """
    coords = pd.read_csv(DATA / "coordinates.csv.gz", usecols=["root_id", "position"])
    xyz = coords.position.str.strip("[]").str.split(expand=True).astype(np.float64)
    xyz["root_id"] = coords.root_id.to_numpy()
    mean = xyz.groupby("root_id")[[0, 1, 2]].mean().reindex(root_ids)

    missing = int(mean[0].isna().sum())
    pos = mean.to_numpy(np.float64)
    have = ~np.isnan(pos[:, 0])
    lo, hi = pos[have].min(axis=0), pos[have].max(axis=0)
    centre = (lo + hi) / 2.0
    scale = 2.0 / float((hi - lo).max())
    pos = (pos - centre) * scale
    pos[:, 1] *= -1.0
    pos[~have] = 0.0

    cls = np.vectorize(BRAIN_CLASS.get)(nt_code.astype(np.int64)).astype(np.uint8)
    cls[~have] = 255  # no geometry: the shader hides these

    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    (WEB_MODELS / "brain_coords.bin").write_bytes(pos.astype("<f4").tobytes())
    (WEB_MODELS / "brain_class.bin").write_bytes(cls.tobytes())
    ext = (hi - lo) * scale
    print(f"brain scan: {len(root_ids):,} neurons, {missing} without coordinates, "
          f"extent {ext[0]:.2f} x {ext[1]:.2f} x {ext[2]:.2f} units "
          f"-> brain_coords.bin {pos.astype('<f4').nbytes / 1e6:.2f} MB, brain_class.bin")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-syn", type=int, default=5)
    ap.add_argument("--nt-mode", choices=["per_neuron", "per_edge"], default="per_neuron")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    bundle = build(args.min_syn, args.nt_mode)
    cls, typ = bundle.pop("classification"), bundle.pop("cell_types")

    root_ids = bundle["root_ids"].numpy()
    index_of = pd.Series(np.arange(len(root_ids)), index=root_ids)
    mn9 = mn9_ids(cls, typ)
    bundle["mn9"] = torch.from_numpy(index_of.loc[mn9].to_numpy(np.int64).copy())
    bundle["mn9_root_ids"] = torch.from_numpy(mn9.copy())

    known = set(root_ids)
    grn = np.array([i for i in SHIU_SUGAR_GRN if i in known], dtype=np.int64)
    bundle["sugar_grn"] = torch.from_numpy(index_of.loc[grn].to_numpy(np.int64).copy())
    bundle["sugar_grn_root_ids"] = torch.from_numpy(grn.copy())

    # Bitter GRNs: the specificity control from the Phase C bench, exposed to the
    # browser so the null result is one click away rather than a claim.
    bitter = np.sort(cls.loc[cls.sub_class == "bitter", "root_id"].to_numpy(np.int64))
    bundle["bitter_grn"] = torch.from_numpy(index_of.loc[bitter].to_numpy(np.int64).copy())
    bundle["bitter_grn_root_ids"] = torch.from_numpy(bitter.copy())

    # Sensory populations for the odor and dust stimuli, plus the two descending
    # neurons the browser needs to exercise. Measured propagation in this base
    # model (500 ms at 150 Hz, see NOTES.md):
    #   olfactory ORNs -> dna_l 25.7 Hz, dnp09 0.0 Hz   (real steering, no walking)
    #   eye bristles   -> dnp09  4.7 Hz, dng11 0.0 Hz   (nothing usable)
    # so dnp09/dng11 are also exposed directly, as a labelled bypass.
    sens = cls[cls.super_class.isin(["sensory", "sensory_ascending"])]
    extra = {
        "odor_orn": np.sort(sens.loc[sens["class"] == "olfactory", "root_id"].to_numpy(np.int64)),
        # Per-side ORNs for chemotaxis. NOTE (measured, see NOTES.md): the DNa
        # steering readout is side-agnostic in this brain-only volume, so driving
        # these does not turn the fly toward the stimulated side. They light up the
        # real pathway; the actual turn is a labelled bypass.
        "odor_orn_l": np.sort(sens.loc[(sens["class"] == "olfactory") & (sens.side == "left"), "root_id"].to_numpy(np.int64)),
        "odor_orn_r": np.sort(sens.loc[(sens["class"] == "olfactory") & (sens.side == "right"), "root_id"].to_numpy(np.int64)),
        "dust_bristle": np.sort(sens.loc[sens.sub_class == "eye_bristle", "root_id"].to_numpy(np.int64)),
        # Looming detectors upstream of the giant fiber. Measured at 150 Hz for
        # 500 ms: DNp01 238 Hz -- a real, strong connectome pathway.
        "loom_lc": np.sort(typ.loc[typ.primary_type.isin(["LC4", "LPLC2"]), "root_id"].to_numpy(np.int64)),
        # All sensory cells, for low-rate spontaneous activity in autonomous mode.
        "sensory_all": np.sort(sens.root_id.to_numpy(np.int64)),
    }
    for key, ids in extra.items():
        bundle[key] = torch.from_numpy(index_of.loc[ids].to_numpy(np.int64).copy())
    print("stimulus groups: " + ", ".join(f"{k}={len(v)}" for k, v in extra.items()))

    # Annotation-derived alternative, kept for comparison. It is not the bench
    # stimulus: sub_class cannot separate sugar cells from water cells.
    ann = sugar_grn_ids(cls)
    bundle["sugar_grn_annotated"] = torch.from_numpy(index_of.loc[ann].to_numpy(np.int64).copy())

    groups = readout_groups(cls, typ)
    bundle["readouts"] = {
        k: torch.from_numpy(index_of.loc[v].to_numpy(np.int64).copy()) for k, v in groups.items() if len(v)
    }
    bundle["readout_root_ids"] = {k: torch.from_numpy(v.copy()) for k, v in groups.items() if len(v)}
    missing = [k for k, v in groups.items() if not len(v)]

    # Per-neuron transmitter identity. Lesioning "the GABAergic population" and
    # reporting a live E/I ratio both need this as a plain vector on the GPU.
    nt_named = neuron_transmitter(pd.read_csv(
        DATA / "connections.csv.gz",
        usecols=["pre_root_id", "nt_type", "syn_count"],
        dtype={"pre_root_id": np.int64, "syn_count": np.int32},
    ).query(f"syn_count >= {bundle['min_syn']}"))
    nt_series = pd.Series(root_ids, index=root_ids).map(nt_named)
    bundle["nt_code"] = torch.from_numpy(
        nt_series.map(NT_CODE).fillna(0).to_numpy(np.int8).copy()
    )
    bundle["nt_sign"] = torch.from_numpy(
        nt_series.map(NT_SIGN).fillna(0.0).to_numpy(np.float32).copy()
    )
    counts = nt_series.value_counts(dropna=False).to_dict()
    print("transmitter per neuron: " + ", ".join(f"{k}={v}" for k, v in counts.items()))

    # Cell type as a code per neuron, so any type can be selected at runtime
    # without shipping 139k strings.
    typ_of = typ.set_index("root_id").primary_type.reindex(root_ids)
    type_names = sorted(typ_of.dropna().unique().tolist())
    code_of = {name: i for i, name in enumerate(type_names)}
    bundle["type_names"] = type_names
    bundle["type_code"] = torch.from_numpy(
        typ_of.map(code_of).fillna(-1).to_numpy(np.int32).copy()
    )
    print(f"cell types: {len(type_names)} distinct, {int((bundle['type_code'] >= 0).sum()):,} neurons typed")

    print(f"MN9 ({MN9_TYPE}): {len(mn9)} cells {mn9.tolist()}")
    print("readout groups: " + ", ".join(f"{k}={len(v)}" for k, v in groups.items()))
    if missing:
        print(f"  WARNING: empty groups {missing}")
    print(f"sugar GRNs: {len(grn)}/{len(SHIU_SUGAR_GRN)} published Shiu cells present in v783")
    print(f"bitter GRNs (control): {len(bitter)}")
    print(f"  (annotation-derived sugar/water, left, labellar: {len(ann)} cells)")

    export_brain(root_ids, bundle["nt_code"].numpy())

    out = Path(args.out) if args.out else DATA / "connectome_v783.pt"
    torch.save(bundle, out)
    print(f"-> {out}  ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Motor-neuron groups from FlyWire FAFB v783 classification.csv.gz.

Groups by annotated target (sub_class) and side. group_name is stable,
lowercase, underscore-separated -- it is the rig spec for the Blender model.

NOTE: FAFB v783 is a *brain* volume. Its 110 motor neurons drive head, neck,
proboscis and viscera. Leg motor neurons live in the ventral nerve cord and are
NOT in this dataset (see NOTES.md).

Usage: python scripts/extract_motor_groups.py
"""
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "classification.csv.gz"
OUT = ROOT / "data" / "motor_groups.csv"


def slug(value: str) -> str:
    """'Antennal motor neuron ' -> 'antennal'. Stable across runs."""
    s = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")
    return re.sub(r"_?motor_neurons?$", "", s) or "unclassified"


def main() -> int:
    if not SRC.exists():
        sys.exit(f"missing {SRC} -- run scripts/download.sh first")

    df = pd.read_csv(SRC, usecols=["root_id", "super_class", "sub_class", "side", "nerve"])
    motor = df[df.super_class == "motor"].copy()

    # ponytail: sub_class is the only muscle/target annotation FAFB carries; fall
    # back to the nerve so unclassified efferents still land in a named group.
    target = motor.sub_class.fillna(motor.nerve.map(lambda n: f"{n}_nerve"))
    motor["group_name"] = target.map(slug)
    motor["side"] = motor.side.fillna("unknown")

    groups = (
        motor.groupby(["group_name", "side"])
        .root_id.agg(neuron_count="size", root_ids=lambda s: " ".join(map(str, sorted(s))))
        .reset_index()
        .sort_values(["group_name", "side"], ignore_index=True)
    )
    groups.to_csv(OUT, index=False)

    width = max(groups.group_name.str.len().max(), len("group_name"))
    print(f"{'group_name':<{width}}  {'side':<7} {'count':>5}")
    print("-" * (width + 15))
    for r in groups.itertuples():
        print(f"{r.group_name:<{width}}  {r.side:<7} {r.neuron_count:>5}")
    print("-" * (width + 15))
    print(f"{'TOTAL':<{width}}  {'':<7} {groups.neuron_count.sum():>5}"
          f"   ({groups.group_name.nunique()} groups, {len(groups)} rows) -> {OUT}")
    return 0


def _selfcheck():
    assert slug("Antennal motor neuron") == "antennal"
    assert slug("neck_motor_neuron") == "neck"
    assert slug("MxLbN_nerve") == "mxlbn_nerve"
    assert slug(float("nan")) == "nan"  # only reachable if both columns are empty
    print("selfcheck ok")


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        _selfcheck()
    else:
        sys.exit(main())

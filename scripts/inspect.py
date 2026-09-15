#!/usr/bin/env python3
"""Print row count, columns, dtypes and 5 sample rows for each downloaded file.

Usage: python scripts/inspect.py
"""
import sys

# ponytail: this file is named inspect.py and would shadow the stdlib module
# that numpy imports. Drop the script dir from sys.path before importing pandas.
sys.path.pop(0)

from pathlib import Path

import pandas as pd

DATA = Path(__file__).resolve().parents[1] / "data"
pd.set_option("display.width", 200, "display.max_columns", 50)

files = sorted(DATA.glob("*.csv.gz"))
if not files:
    sys.exit(f"no *.csv.gz in {DATA} -- run scripts/download.sh first")

for path in files:
    df = pd.read_csv(path)
    print("=" * 100)
    print(f"{path.name}   {path.stat().st_size / 1e6:.1f} MB on disk   {len(df):,} rows x {len(df.columns)} cols")
    print("-" * 100)
    print(df.dtypes.to_string())
    print("-" * 100)
    print(df.head(5).to_string())
    print()

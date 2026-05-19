from __future__ import annotations

from pathlib import Path

import pandas as pd

from .schema import (
    LABEL_REQUIRED,
    LINE_KEY_COLS,
    LINE_OPTIONAL,
    LINE_REQUIRED,
)


def load_lines(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    missing = [c for c in LINE_REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"lines.csv missing required columns: {missing}")
    for c in LINE_OPTIONAL:
        if c not in df.columns:
            df[c] = ""
    df["units"] = pd.to_numeric(df["units"], errors="coerce").fillna(0.0)
    df["charge"] = pd.to_numeric(df["charge"], errors="coerce").fillna(0.0)
    df["dos"] = pd.to_datetime(df["dos"], errors="coerce")
    return df


def load_labels(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    missing = [c for c in LABEL_REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"labels.csv missing required columns: {missing}")
    df["flagged"] = pd.to_numeric(df["flagged"], errors="coerce").fillna(0).astype(int)
    if "reason" not in df.columns:
        df["reason"] = ""
    return df


def join_lines_labels(lines: pd.DataFrame, labels: pd.DataFrame) -> pd.DataFrame:
    merged = lines.merge(
        labels[LINE_KEY_COLS + ["flagged"]], on=LINE_KEY_COLS, how="left"
    )
    merged["flagged"] = merged["flagged"].fillna(0).astype(int)
    return merged

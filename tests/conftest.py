from __future__ import annotations

import random
from pathlib import Path

import pandas as pd
import pytest


def _make_synthetic(n: int = 2000, seed: int = 7) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = random.Random(seed)
    cpts = ["99213", "99214", "99203", "20610", "93000", "36415", "G0444"]
    pos_codes = ["11", "22", "23", "31", "81"]
    modifiers_pool = ["", "25", "59", "25;59", "GA", "76", ""]
    icd_pool = ["E11.9", "I10", "Z00.00", "M54.5", "J06.9", "F32.9", "E11.9;I10"]
    npis = [f"npi_{i:03d}" for i in range(40)]
    base_charge = {
        "99213": 110, "99214": 165, "99203": 140, "20610": 90,
        "93000": 50, "36415": 15, "G0444": 35,
    }

    rows, labels = [], []
    for i in range(n):
        claim_id = f"C{i:06d}"
        line_id = f"L{i:06d}_1"
        cpt = rng.choice(cpts)
        mods = rng.choice(modifiers_pool)
        icd = rng.choice(icd_pool)
        units = rng.choice([1, 1, 1, 2, 3])
        charge = base_charge[cpt] * units * rng.uniform(0.8, 2.5)
        pos = rng.choice(pos_codes)
        npi = rng.choice(npis)

        prob = 0.02
        if "59" in mods and cpt.startswith("992"):
            prob += 0.6
        if charge > base_charge[cpt] * units * 2:
            prob += 0.3
        if npi == "npi_001":
            prob += 0.2
        flagged = 1 if rng.random() < prob else 0

        rows.append({
            "claim_id": claim_id,
            "line_id": line_id,
            "patient_id": f"P{rng.randint(0, 200):04d}",
            "provider_npi": npi,
            "dos": f"2025-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
            "cpt": cpt,
            "modifiers": mods,
            "icd10": icd,
            "units": units,
            "charge": round(charge, 2),
            "place_of_service": pos,
        })
        labels.append({
            "claim_id": claim_id,
            "line_id": line_id,
            "flagged": flagged,
            "reason": "rule_synthetic" if flagged else "",
        })
    return pd.DataFrame(rows), pd.DataFrame(labels)


@pytest.fixture
def synthetic_data(tmp_path: Path):
    lines_df, labels_df = _make_synthetic()
    lines_csv = tmp_path / "lines.csv"
    labels_csv = tmp_path / "labels.csv"
    lines_df.to_csv(lines_csv, index=False)
    labels_df.to_csv(labels_csv, index=False)
    return {
        "lines": lines_csv,
        "labels": labels_csv,
        "dir": tmp_path,
        "lines_df": lines_df,
        "labels_df": labels_df,
    }

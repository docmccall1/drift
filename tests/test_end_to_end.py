from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from beacon_replicator.cli import main


def test_train_then_score(synthetic_data, tmp_path):
    model_dir = tmp_path / "models"
    rc = main([
        "train",
        "--lines", str(synthetic_data["lines"]),
        "--labels", str(synthetic_data["labels"]),
        "--output", str(model_dir),
    ])
    assert rc == 0
    assert (model_dir / "model.txt").exists()
    assert (model_dir / "encoder.json").exists()
    meta = json.loads((model_dir / "metadata.json").read_text())
    assert meta["auc_val"] >= 0.75

    xlsx_path = tmp_path / "flagged.xlsx"
    rc = main([
        "score",
        "--lines", str(synthetic_data["lines"]),
        "--model", str(model_dir),
        "--output", str(xlsx_path),
        "--threshold", "0.5",
    ])
    assert rc == 0
    assert xlsx_path.exists()
    json_path = xlsx_path.with_suffix(".json")
    assert json_path.exists()

    sidecar = json.loads(json_path.read_text())
    assert sidecar["n_total"] == len(synthetic_data["lines_df"])

    flagged = pd.read_excel(xlsx_path, sheet_name="Flagged")
    assert len(flagged) == sidecar["n_flagged"]
    if len(flagged) > 0:
        scores = flagged["score"].tolist()
        assert scores == sorted(scores, reverse=True)
        assert flagged["score"].iloc[0] >= 0.5


def test_score_handles_unseen_provider(synthetic_data, tmp_path):
    model_dir = tmp_path / "models"
    main([
        "train",
        "--lines", str(synthetic_data["lines"]),
        "--labels", str(synthetic_data["labels"]),
        "--output", str(model_dir),
    ])

    new_lines = synthetic_data["lines_df"].head(50).copy()
    new_lines["provider_npi"] = "npi_unseen_999"
    new_path = tmp_path / "new_lines.csv"
    new_lines.to_csv(new_path, index=False)

    xlsx_path = tmp_path / "flagged.xlsx"
    rc = main([
        "score",
        "--lines", str(new_path),
        "--model", str(model_dir),
        "--output", str(xlsx_path),
        "--threshold", "0.9",
    ])
    assert rc == 0
    assert xlsx_path.exists()

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


def _format_reasons(reasons: list[dict]) -> str:
    if not reasons:
        return ""
    return "; ".join(f"{r['feature']} (+{r['contribution']:.3f})" for r in reasons)


def write_outputs(
    scored: pd.DataFrame, xlsx_path: Path, json_path: Path, threshold: float
) -> dict:
    xlsx_path = Path(xlsx_path)
    json_path = Path(json_path)
    xlsx_path.parent.mkdir(parents=True, exist_ok=True)

    flagged = scored[scored["score"] >= threshold].copy()
    flagged = flagged.sort_values("score", ascending=False).reset_index(drop=True)
    flagged["top_reasons"] = flagged["reasons"].apply(_format_reasons)

    excel_cols = [
        "claim_id",
        "line_id",
        "patient_id",
        "provider_npi",
        "dos",
        "cpt",
        "modifiers",
        "units",
        "charge",
        "score",
        "top_reasons",
    ]
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        flagged[excel_cols].to_excel(writer, sheet_name="Flagged", index=False)

    sidecar = {
        "threshold": threshold,
        "n_total": int(len(scored)),
        "n_flagged": int(len(flagged)),
        "rows": scored.to_dict(orient="records"),
    }
    json_path.write_text(json.dumps(sidecar, indent=2, default=str))

    return {"n_total": int(len(scored)), "n_flagged": int(len(flagged))}

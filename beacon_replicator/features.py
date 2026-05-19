from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from .schema import MULTI_VALUE_SEP

# Non-exhaustive list of modifiers frequently scrutinized in audits.
HIGH_RISK_MODIFIERS = ["25", "59", "GA", "GZ", "GY", "76", "77", "91", "XE", "XS", "XP", "XU"]

DEFAULT_TOP_N_CPT = 200
DEFAULT_TOP_N_POS = 20
DEFAULT_TOP_N_MOD = 30


@dataclass
class FeatureEncoder:
    top_cpt: list[str] = field(default_factory=list)
    top_pos: list[str] = field(default_factory=list)
    top_mod: list[str] = field(default_factory=list)
    icd_chapters: list[str] = field(default_factory=list)
    provider_flag_rate: dict[str, float] = field(default_factory=dict)
    cpt_charge_mean: dict[str, float] = field(default_factory=dict)
    cpt_charge_std: dict[str, float] = field(default_factory=dict)
    cpt_units_mean: dict[str, float] = field(default_factory=dict)
    cpt_units_std: dict[str, float] = field(default_factory=dict)
    global_charge_mean: float = 0.0
    global_units_mean: float = 0.0
    global_flag_rate: float = 0.0
    feature_names: list[str] = field(default_factory=list)

    def save(self, path: Path) -> None:
        Path(path).write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls, path: Path) -> "FeatureEncoder":
        return cls(**json.loads(Path(path).read_text()))


def _split_multi(series: pd.Series) -> list[list[str]]:
    return [
        [v.strip().upper() for v in (val or "").split(MULTI_VALUE_SEP) if v.strip()]
        for val in series.fillna("").astype(str)
    ]


def _icd10_chapter(code: str) -> str:
    # First character bucket; not the official chapter mapping but stable across runs.
    return code[0].upper() if code else ""


def feature_names_from(enc: FeatureEncoder) -> list[str]:
    names = ["units", "charge", "charge_per_unit"]
    names += [f"cpt__{c}" for c in enc.top_cpt + ["OTHER"]]
    names += [f"pos__{c}" for c in enc.top_pos + ["OTHER"]]
    names += [f"mod__{m}" for m in enc.top_mod]
    names += ["mod__count", "mod__high_risk_count"]
    names += [f"icd_ch__{ch}" for ch in enc.icd_chapters]
    names += [
        "icd__count",
        "charge_z_in_cpt",
        "units_z_in_cpt",
        "provider_flag_rate",
        "dow",
        "month",
    ]
    return names


def fit_encoder(df: pd.DataFrame, label_col: str = "flagged") -> FeatureEncoder:
    enc = FeatureEncoder()

    enc.top_cpt = df["cpt"].value_counts().head(DEFAULT_TOP_N_CPT).index.tolist()
    enc.top_pos = (
        df["place_of_service"].value_counts().head(DEFAULT_TOP_N_POS).index.tolist()
    )

    mods = _split_multi(df["modifiers"])
    mod_counts: dict[str, int] = {}
    for mlist in mods:
        for m in mlist:
            mod_counts[m] = mod_counts.get(m, 0) + 1
    enc.top_mod = sorted(mod_counts, key=lambda k: mod_counts[k], reverse=True)[
        :DEFAULT_TOP_N_MOD
    ]
    for m in HIGH_RISK_MODIFIERS:
        if m not in enc.top_mod:
            enc.top_mod.append(m)

    icd = _split_multi(df["icd10"])
    chapter_set = set()
    for clist in icd:
        for c in clist:
            ch = _icd10_chapter(c)
            if ch:
                chapter_set.add(ch)
    enc.icd_chapters = sorted(chapter_set)

    enc.global_charge_mean = float(df["charge"].astype(float).mean() or 0.0)
    enc.global_units_mean = float(df["units"].astype(float).mean() or 0.0)

    if label_col in df.columns:
        enc.global_flag_rate = float(df[label_col].mean())
        prov = df.groupby("provider_npi")[label_col].agg(["sum", "count"])
        smooth = 20.0
        prov["rate"] = (prov["sum"] + smooth * enc.global_flag_rate) / (
            prov["count"] + smooth
        )
        enc.provider_flag_rate = prov["rate"].astype(float).to_dict()

    g = df.groupby("cpt")
    enc.cpt_charge_mean = g["charge"].mean().astype(float).to_dict()
    enc.cpt_charge_std = g["charge"].std().fillna(0.0).astype(float).to_dict()
    enc.cpt_units_mean = g["units"].mean().astype(float).to_dict()
    enc.cpt_units_std = g["units"].std().fillna(0.0).astype(float).to_dict()

    enc.feature_names = feature_names_from(enc)
    return enc


def transform(df: pd.DataFrame, enc: FeatureEncoder) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    n = len(df)

    out["units"] = df["units"].astype(float).values
    out["charge"] = df["charge"].astype(float).values
    out["charge_per_unit"] = np.where(
        out["units"].values > 0, out["charge"].values / out["units"].values, 0.0
    )

    cpt_bucket = df["cpt"].where(df["cpt"].isin(enc.top_cpt), other="OTHER")
    for code in enc.top_cpt + ["OTHER"]:
        out[f"cpt__{code}"] = (cpt_bucket.values == code).astype(int)

    pos_bucket = df["place_of_service"].where(
        df["place_of_service"].isin(enc.top_pos), other="OTHER"
    )
    for code in enc.top_pos + ["OTHER"]:
        out[f"pos__{code}"] = (pos_bucket.values == code).astype(int)

    mods = _split_multi(df["modifiers"])
    for m in enc.top_mod:
        out[f"mod__{m}"] = np.fromiter((1 if m in lst else 0 for lst in mods), int, n)
    out["mod__count"] = np.fromiter((len(lst) for lst in mods), int, n)
    out["mod__high_risk_count"] = np.fromiter(
        (sum(1 for x in lst if x in HIGH_RISK_MODIFIERS) for lst in mods), int, n
    )

    icd = _split_multi(df["icd10"])
    for ch in enc.icd_chapters:
        out[f"icd_ch__{ch}"] = np.fromiter(
            (1 if any(_icd10_chapter(c) == ch for c in lst) else 0 for lst in icd),
            int,
            n,
        )
    out["icd__count"] = np.fromiter((len(lst) for lst in icd), int, n)

    cpt = df["cpt"].astype(str)
    charge_mean = cpt.map(enc.cpt_charge_mean).fillna(enc.global_charge_mean)
    charge_std = cpt.map(enc.cpt_charge_std).replace(0, np.nan).fillna(1.0)
    units_mean = cpt.map(enc.cpt_units_mean).fillna(enc.global_units_mean)
    units_std = cpt.map(enc.cpt_units_std).replace(0, np.nan).fillna(1.0)
    out["charge_z_in_cpt"] = (df["charge"].astype(float).values - charge_mean.values) / charge_std.values
    out["units_z_in_cpt"] = (df["units"].astype(float).values - units_mean.values) / units_std.values

    out["provider_flag_rate"] = (
        df["provider_npi"].map(enc.provider_flag_rate).fillna(enc.global_flag_rate).values
    )

    dos = pd.to_datetime(df["dos"], errors="coerce")
    out["dow"] = dos.dt.dayofweek.fillna(-1).astype(int).values
    out["month"] = dos.dt.month.fillna(-1).astype(int).values

    return out

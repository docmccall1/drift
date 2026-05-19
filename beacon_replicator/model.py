from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

from . import __version__
from .features import FeatureEncoder, fit_encoder, transform


@dataclass
class TrainResult:
    auc_train: float
    auc_val: float
    n_train: int
    n_val: int
    n_positive: int
    n_features: int


def train(
    df: pd.DataFrame,
    output_dir: Path,
    val_size: float = 0.2,
    random_state: int = 42,
    num_boost_round: int = 500,
) -> TrainResult:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    enc = fit_encoder(df, label_col="flagged")
    X = transform(df, enc)[enc.feature_names]
    y = df["flagged"].astype(int).values

    if y.sum() == 0:
        raise ValueError("No positive (flagged=1) examples in training data.")

    stratify = y if y.sum() > 1 and (y == 0).sum() > 1 else None
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=val_size, random_state=random_state, stratify=stratify
    )

    pos_weight = float((y_train == 0).sum()) / max(1, int((y_train == 1).sum()))
    params = {
        "objective": "binary",
        "metric": "auc",
        "learning_rate": 0.05,
        "num_leaves": 64,
        "min_data_in_leaf": 20,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.9,
        "bagging_freq": 5,
        "scale_pos_weight": pos_weight,
        "verbose": -1,
    }

    train_set = lgb.Dataset(X_train, y_train, feature_name=list(X_train.columns))
    val_set = lgb.Dataset(X_val, y_val, reference=train_set)

    booster = lgb.train(
        params,
        train_set,
        num_boost_round=num_boost_round,
        valid_sets=[train_set, val_set],
        valid_names=["train", "val"],
        callbacks=[
            lgb.early_stopping(stopping_rounds=30),
            lgb.log_evaluation(period=0),
        ],
    )

    enc.save(output_dir / "encoder.json")
    booster.save_model(str(output_dir / "model.txt"))

    auc_train = float(booster.best_score["train"]["auc"])
    auc_val = float(booster.best_score["val"]["auc"])
    metadata = {
        "package_version": __version__,
        "auc_train": auc_train,
        "auc_val": auc_val,
        "n_train": int(len(X_train)),
        "n_val": int(len(X_val)),
        "n_positive": int(y.sum()),
        "n_features": int(X.shape[1]),
        "feature_names": enc.feature_names,
        "best_iteration": int(booster.best_iteration),
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))

    return TrainResult(
        auc_train=auc_train,
        auc_val=auc_val,
        n_train=int(len(X_train)),
        n_val=int(len(X_val)),
        n_positive=int(y.sum()),
        n_features=int(X.shape[1]),
    )


def load_model(model_dir: Path) -> tuple[lgb.Booster, FeatureEncoder]:
    model_dir = Path(model_dir)
    booster = lgb.Booster(model_file=str(model_dir / "model.txt"))
    enc = FeatureEncoder.load(model_dir / "encoder.json")
    return booster, enc


def score(
    df: pd.DataFrame,
    booster: lgb.Booster,
    enc: FeatureEncoder,
    top_k_reasons: int = 3,
) -> pd.DataFrame:
    X = transform(df, enc)[enc.feature_names]
    proba = booster.predict(X, num_iteration=booster.best_iteration)
    contribs = booster.predict(X, pred_contrib=True, num_iteration=booster.best_iteration)
    feat_contribs = contribs[:, :-1]
    feature_names = enc.feature_names

    reasons: list[list[dict]] = []
    for row in feat_contribs:
        idx = np.argsort(-row)[:top_k_reasons]
        reasons.append(
            [
                {"feature": feature_names[i], "contribution": float(row[i])}
                for i in idx
                if row[i] > 0
            ]
        )

    return pd.DataFrame(
        {
            "claim_id": df["claim_id"].values,
            "line_id": df["line_id"].values,
            "patient_id": df.get("patient_id", pd.Series([""] * len(df))).values,
            "provider_npi": df.get("provider_npi", pd.Series([""] * len(df))).values,
            "dos": df["dos"].astype(str).values,
            "cpt": df["cpt"].values,
            "modifiers": df["modifiers"].values,
            "units": df["units"].values,
            "charge": df["charge"].values,
            "score": proba,
            "reasons": reasons,
        }
    )

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .data import join_lines_labels, load_labels, load_lines
from .model import load_model, score as score_df, train as train_model
from .output import write_outputs


def _train(args: argparse.Namespace) -> int:
    lines = load_lines(args.lines)
    labels = load_labels(args.labels)
    df = join_lines_labels(lines, labels)
    result = train_model(df, Path(args.output))
    print(
        f"Trained on {result.n_train} examples ({result.n_positive} flagged), "
        f"val AUC={result.auc_val:.3f}, features={result.n_features}."
    )
    print(f"Saved model artifacts to {args.output}")
    return 0


def _score(args: argparse.Namespace) -> int:
    booster, enc = load_model(Path(args.model))
    lines = load_lines(args.lines)
    scored = score_df(lines, booster, enc)
    xlsx_path = Path(args.output)
    json_path = xlsx_path.with_suffix(".json")
    summary = write_outputs(scored, xlsx_path, json_path, threshold=args.threshold)
    print(
        f"Scored {summary['n_total']} lines, "
        f"flagged {summary['n_flagged']} at threshold {args.threshold}."
    )
    print(f"Wrote {xlsx_path} and {json_path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="beacon", description="beacon_replicator")
    sub = parser.add_subparsers(dest="command", required=True)

    p_train = sub.add_parser("train", help="Train a model on historical audit data")
    p_train.add_argument("--lines", required=True, help="Path to lines.csv")
    p_train.add_argument("--labels", required=True, help="Path to labels.csv")
    p_train.add_argument(
        "--output", required=True, help="Output directory for model artifacts"
    )
    p_train.set_defaults(func=_train)

    p_score = sub.add_parser("score", help="Score new claim lines")
    p_score.add_argument("--lines", required=True, help="Path to new_lines.csv")
    p_score.add_argument(
        "--model", required=True, help="Directory containing model artifacts"
    )
    p_score.add_argument("--output", required=True, help="Output .xlsx path")
    p_score.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="Score threshold for inclusion in flagged.xlsx (default: 0.5)",
    )
    p_score.set_defaults(func=_score)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

"""Exports Mew v2's dataset.

    uv run python -m mew_api.dataset --out ../ml/data --seed ../frontend/evals/mew.cases.json \
        [--supabase] [--jsonl labels.jsonl ...]

--supabase reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (repo-root .env.local).
"""

import argparse
import sys
from pathlib import Path

from ..config import Settings
from .export import Example, from_jsonl, from_seed_cases, from_supabase, resolve, write_dataset


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mew_api.dataset", description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="output folder")
    parser.add_argument("--seed", type=Path, help="v1 gate eval cases (mew.cases.json)")
    parser.add_argument("--jsonl", type=Path, nargs="*", default=[], help="labelling downloads")
    parser.add_argument("--supabase", action="store_true", help="labelled events (secret key)")
    args = parser.parse_args(argv)

    examples: list[Example] = []
    if args.seed:
        examples += from_seed_cases(args.seed)
    for path in args.jsonl:
        examples += from_jsonl(path)
    if args.supabase:
        settings = Settings()
        if not settings.supabase_url or settings.supabase_secret_key is None:
            print(
                "--supabase needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY", file=sys.stderr
            )
            return 2
        examples += from_supabase(
            settings.supabase_url, settings.supabase_secret_key.get_secret_value()
        )
    if not examples:
        print("No examples: give --seed, --jsonl or --supabase.", file=sys.stderr)
        return 2

    kept, dropped = resolve(examples)
    counts = write_dataset(kept, args.out)
    print(f"{len(kept)} examples ({dropped} dropped: conflicting labels) -> {args.out}")
    for name, by_label in counts.items():
        print(f"  {name:5} {sum(by_label.values()):5}  {dict(sorted(by_label.items()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

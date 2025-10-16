#!/usr/bin/env python3
"""
Utility for generating large plaintext fixtures to manually exercise
Codex auto-compaction behaviour.

The script approximates the token budget using a conservative
4-bytes-per-token heuristic, mirroring the estimation used by the
backend. It writes repeated, numbered paragraphs to the output file so
that you can reference specific sections while debugging.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path


DEFAULT_LINE_BYTES = 256  # keeps each line human readable while hitting the target quickly


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a large plaintext file for manual auto-compaction tests.",
    )
    parser.add_argument(
        "--tokens",
        type=int,
        default=200_000,
        help="Approximate number of tokens to generate (defaults to 200000).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("auto_compaction_fixture.txt"),
        help="Destination file path (defaults to ./auto_compaction_fixture.txt).",
    )
    parser.add_argument(
        "--line-bytes",
        type=int,
        default=DEFAULT_LINE_BYTES,
        help="Approximate number of bytes per line when generating content.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    approx_bytes = args.tokens * 4
    if approx_bytes <= 0:
        raise SystemExit("Token count must be positive.")

    line_bytes = max(16, args.line_bytes)
    total_lines = math.ceil(approx_bytes / line_bytes)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        for idx in range(total_lines):
            prefix = f"{idx:06d}"
            payload = " ".join(
                [
                    "This",
                    "is",
                    "synthetic",
                    "context",
                    f"segment-{idx}",
                    "generated",
                    "for",
                    "auto-compaction",
                    "validation.",
                ]
            )
            handle.write(f"{prefix} {payload}\n")

    actual_bytes = args.output.stat().st_size
    approx_tokens = actual_bytes // 4
    print(
        f"Wrote {actual_bytes} bytes (~{approx_tokens} tokens) to {args.output} "
        f"using {total_lines} lines.",
    )


if __name__ == "__main__":
    main()

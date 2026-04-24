#!/usr/bin/env python3
"""
validate-batch.py — Validate a graded_batch_NN_final.json against the schema.

Usage:
    python3 validate-batch.py graded_batch_09_final.json

Exits 0 if valid, 1 if any check fails. Prints per-check results.
"""

import json
import re
import sys
from pathlib import Path


ALLOWED_RESULTS = {"win", "loss", "unknown"}
ALLOWED_SOURCES = {
    "espn_mlb", "espn_nba", "espn_nhl", "espn_soccer", "espn_tennis",
    "espn_golf", "espn_mma", "espn_ufc",
    "nba_com", "mlb_com", "nhl_com",
    "atp_official", "wta_official",
    "cbssports_nba_pbp", "cbssports_nba", "cbssports_nhl", "cbssports_mlb",
    "pga_tour", "ufc_com",
    "baseball_savant",
    "rotowire", "statmuse", "basketball_reference",
}


def validate(path: Path) -> int:
    data = json.loads(path.read_text())
    errors = []
    warnings = []

    if not isinstance(data, list):
        errors.append("Top-level must be a list, not an object")
        return report(path, errors, warnings)

    if len(data) != 25:
        warnings.append(f"Expected 25 entries, got {len(data)}")

    for i, b in enumerate(data):
        prefix = f"entry {i} ({b.get('bet_id', '?')[:12]})"

        # bet_id
        if not isinstance(b.get("bet_id"), str) or not re.match(r"^[0-9a-f]{32}$", b["bet_id"]):
            errors.append(f"{prefix}: bet_id must be 32 hex chars, got {b.get('bet_id')!r}")

        # result
        if b.get("result") not in ALLOWED_RESULTS:
            errors.append(f"{prefix}: result must be win|loss|unknown, got {b.get('result')!r}")

        # profit_units vs result
        pu = b.get("profit_units")
        r = b.get("result")
        if r == "unknown":
            if pu is not None:
                errors.append(f"{prefix}: unknown must have profit_units=null, got {pu}")
        elif r == "loss":
            if pu is None or pu >= 0:
                errors.append(f"{prefix}: loss must have profit_units < 0, got {pu}")
        elif r == "win":
            if pu is not None and pu <= 0:
                errors.append(f"{prefix}: win must have profit_units > 0 or null, got {pu}")

        # evidence fields
        if r == "unknown":
            for field in ("evidence_url", "evidence_source", "evidence_quote"):
                if b.get(field) is not None:
                    errors.append(f"{prefix}: unknown must have {field}=null, got {b.get(field)!r}")
        else:
            if not b.get("evidence_url"):
                warnings.append(f"{prefix}: {r} with no evidence_url")
            if b.get("evidence_source") and b["evidence_source"] not in ALLOWED_SOURCES:
                warnings.append(f"{prefix}: evidence_source {b['evidence_source']!r} not in whitelist")
            quote = b.get("evidence_quote")
            if quote and len(quote) > 200:
                errors.append(f"{prefix}: evidence_quote too long ({len(quote)} chars)")
            if quote and len(quote) < 5:
                warnings.append(f"{prefix}: evidence_quote suspiciously short")

        # grade_reason
        gr = b.get("grade_reason")
        if not isinstance(gr, str) or len(gr) < 10:
            errors.append(f"{prefix}: grade_reason too short or missing")

    # net sanity check
    total = sum(b["profit_units"] for b in data if isinstance(b.get("profit_units"), (int, float)))
    if abs(total) > 100:
        warnings.append(
            f"Net P&L = {total:+.2f}u is suspiciously large for 25 bets — "
            f"double-check a leg for decimal/unit misread"
        )

    return report(path, errors, warnings, total, data)


def report(path, errors, warnings, total=None, data=None):
    print(f"Validating {path.name}")
    if errors:
        print(f"\n  ERRORS ({len(errors)}):")
        for e in errors:
            print(f"    ✗ {e}")
    if warnings:
        print(f"\n  WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"    ⚠ {w}")
    if total is not None and data is not None:
        from collections import Counter
        c = Counter(b["result"] for b in data)
        print(f"\n  Breakdown: {dict(c)}")
        print(f"  Net P&L: {total:+.4f}u")
    if not errors and not warnings:
        print("\n  ✓ All checks passed")
    print()
    return 1 if errors else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 validate-batch.py <graded_batch_NN_final.json>")
        sys.exit(2)
    sys.exit(validate(Path(sys.argv[1])))

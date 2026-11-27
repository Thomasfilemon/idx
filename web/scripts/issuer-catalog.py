"""Build the dashboard's searchable issuer snapshot from the bundled universe."""

import csv
import json
import re
from pathlib import Path

universe = Path(__file__).resolve().parents[2] / "data" / "universe.csv"
issuers = {}
with universe.open(encoding="utf-8", newline="") as source:
    for row in csv.DictReader(line for line in source if not line.startswith("#")):
        symbol = row["symbol"].strip().upper()
        name = row["name"].strip()
        if re.fullmatch(r"[A-Z0-9][A-Z0-9-]{0,11}", symbol) and name:
            issuers[symbol] = name

if not issuers:
    raise SystemExit("Issuer catalog is empty")
print(json.dumps([{"symbol": symbol, "name": name} for symbol, name in sorted(issuers.items())], ensure_ascii=False))

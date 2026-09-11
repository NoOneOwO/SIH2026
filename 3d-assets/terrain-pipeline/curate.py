"""
Curate the app to 50 dams / 30 clean 3D models.

- 30 x 3D: real OpenTopography DEM + real Esri texture + highest relief
  (flat plains and any user-flagged dam are excluded — they read as "broken").
- 20 x list-only: tallest dams by height_m (globe fallback in the viewer).
- Rewrites frontend/src/data/india-dams.ts (50 entries), rewrites
  frontend/public/terrain/manifest.json (30 entries), deletes all other
  published GLBs/metadata so nothing unreconstructable can load.

Usage: python curate.py
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DAMS_TS = REPO / "frontend" / "src" / "data" / "india-dams.ts"
TERRAIN = REPO / "frontend" / "public" / "terrain"

BANNED = {"d8", "d23", "d37"}  # user-flagged: Rihand, Indira Sagar, Supa
N_3D = 30
N_TOTAL = 50


def is_real(sources: dict) -> bool:
    blob = sources.get("dem", "") + sources.get("texture", "")
    return "FALLBACK" not in blob and "SYNTHETIC" not in blob


def main() -> int:
    # ── Score pipeline outputs ──────────────────────────────────────
    scored = []
    for md_path in (HERE / "output").glob("*/metadata.json"):
        dam = md_path.parent.name
        if not re.fullmatch(r"d\d+", dam) or dam in BANNED:
            continue
        d = json.loads(md_path.read_text(encoding="utf-8"))
        if not is_real(d["sources"]):
            continue
        relief = d["elevation_max_m"] - d["elevation_min_m"]
        scored.append((dam, relief))
    scored.sort(key=lambda r: -r[1])
    top3d = [dam for dam, _ in scored[:N_3D]]
    print(f"3D set ({len(top3d)}, min relief {scored[N_3D-1][1]:.0f} m): {top3d}")

    # ── Parse frontend index ────────────────────────────────────────
    text = DAMS_TS.read_text(encoding="utf-8")
    entries: dict[str, dict] = {}
    order: list[str] = []
    for m in re.finditer(
        r"^(?P<line>\s*\{ id: '(?P<id>d\d+)'.*?height_m: (?P<h>[\d.]+).*?\},?)\s*$",
        text, re.MULTILINE,
    ):
        did = m.group("id")
        entries[did] = {"line": m.group("line"), "h": float(m.group("h")),
                        "name": re.search(r"name: '([^']+)'", m.group("line")).group(1),
                        "state": re.search(r"state: '([^']+)'", m.group("line")).group(1)}
        order.append(did)
    print(f"index entries: {len(entries)}")

    # ── 20 more by height ───────────────────────────────────────────
    rest = [did for did in order if did in entries and did not in top3d and did not in BANNED]
    rest.sort(key=lambda did: -entries[did]["h"])
    extra = rest[: N_TOTAL - N_3D]
    keep = [did for did in order if did in top3d or did in extra]
    assert len(keep) == N_TOTAL, f"kept {len(keep)}, expected {N_TOTAL}"
    print(f"list-only extras: {extra}")

    # ── Rewrite index ───────────────────────────────────────────────
    header = (
        "/**\n"
        " * DamSafe Twin — Indian Dams Dataset (CURATED: 50 dams)\n"
        " *\n"
        " * 30 dams ship a real-DEM local 3D terrain model (see\n"
        " * 3d-assets/terrain-pipeline/curate.py); 20 more are list-only\n"
        " * (globe fallback). Dams that cannot be cleanly 3D-reconstructed\n"
        " * (flat-plains or failed fetches) are excluded from this file.\n"
        " * Coordinates in WGS84 (EPSG:4326).\n"
        " */\n"
    )
    body = "\n".join(entries[did]["line"] for did in keep)
    DAMS_TS.write_text(
        header + "\nexport interface DamPoint {\n"
        "  id: string;\n  name: string;\n  state: string;\n  lon: number;\n  lat: number;\n  height_m: number;\n  type: string;\n  river: string;\n  capacity_mcm: number;\n  year_built: number;\n}\n"
        "\nexport const INDIA_DAMS: DamPoint[] = [\n" + body + "\n];\n",
        encoding="utf-8",
    )

    # ── Rewrite manifest, delete everything else ────────────────────
    manifest = {did: {"file": did, "name": entries[did]["name"]} for did in top3d}
    for f in TERRAIN.glob("*.glb"):
        if f.stem not in top3d:
            f.unlink()
    for f in TERRAIN.glob("*.metadata.json"):
        if f.stem not in top3d:
            f.unlink()
    (TERRAIN / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    remaining = sorted(f.stem for f in TERRAIN.glob("*.glb"))
    print(f"published GLBs now: {len(remaining)}")
    assert set(remaining) == set(top3d), "terrain dir out of sync with manifest"
    print("CURATION OK — 50 dams, 30 with 3D")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

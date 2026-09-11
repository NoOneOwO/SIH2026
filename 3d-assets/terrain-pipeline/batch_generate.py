"""
Batch-generate local 3D terrain models for every dam in the frontend index.

Reads dam id/name/lon/lat from frontend/src/data/india-dams.ts, dedupes by
coordinates, and runs terrain_pipeline.main() once per dam with --lat/--lon.
Outputs are keyed by frontend dam id (d4.glb, d4.metadata.json, ...) so the
frontend can look models up exactly — no fuzzy name matching.

Copies finished assets + manifest.json straight into frontend/public/terrain/.

Usage:
    $env:OPENTOPOGRAPHY_API_KEY='...'   # real DEM (else add --demo for synthetic)
    # Quota rotation (recommended): supply several legitimate keys; the
    # pipeline rotates on quota/rate-limit failures instead of retrying
    # the same exhausted key. Never commit keys — env vars only.
    #   $env:OPENTOPOGRAPHY_API_KEY_1='...'; $env:OPENTOPOGRAPHY_API_KEY_2='...'
    #   # ...or comma-separated: $env:OPENTOPO_KEYS='keyA,keyB,keyC'
    python batch_generate.py --limit 5            # pilot
    python batch_generate.py --only d1,d7         # specific dams
    python batch_generate.py                      # full index (~1.5-2 h, skips existing)

Resume-safe: dams with an existing output/<id>/<id>.glb are skipped unless
--overwrite is passed. Progress is appended to batch_progress.log.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DAMS_TS = REPO / "frontend" / "src" / "data" / "india-dams.ts"
FRONTEND_TERRAIN = REPO / "frontend" / "public" / "terrain"

from terrain_pipeline import main as run_pipeline  # noqa: E402
from terrain_pipeline import collect_opentopo_keys  # noqa: E402


def parse_dams(ts_path: Path) -> list[dict]:
    text = ts_path.read_text(encoding="utf-8")
    dams = []
    for m in re.finditer(
        r"\{\s*id:\s*'(?P<id>[^']+)'\s*,\s*name:\s*'(?P<name>[^']+)'"
        r".*?lon:\s*(?P<lon>-?[\d.]+)\s*,\s*lat:\s*(?P<lat>-?[\d.]+)",
        text, re.DOTALL,
    ):
        dams.append({
            "id": m.group("id"),
            "name": m.group("name"),
            "lon": float(m.group("lon")),
            "lat": float(m.group("lat")),
        })
    return dams


def dedupe(dams: list[dict]) -> list[dict]:
    seen: set[tuple[float, float]] = set()
    unique = []
    for d in dams:
        key = (round(d["lat"], 4), round(d["lon"], 4))
        if key in seen:
            print(f"[batch] skip duplicate coords: {d['id']} {d['name']}")
            continue
        seen.add(key)
        unique.append(d)
    return unique


def publish(dam_id: str, display_name: str, state: str = "") -> None:
    FRONTEND_TERRAIN.mkdir(parents=True, exist_ok=True)
    out_dir = HERE / "output" / dam_id
    for ext, pub_ext in (("glb", "glb"), ("metadata.json", "metadata.json")):
        src = out_dir / (f"{dam_id}.{ext}" if ext == "glb" else "metadata.json")
        if src.exists():
            shutil.copy2(src, FRONTEND_TERRAIN / f"{dam_id}.{pub_ext}")
    # manifest accumulates across runs
    manifest_path = FRONTEND_TERRAIN / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    manifest[dam_id] = {"file": dam_id, "name": display_name, "state": state}
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def dem_source_of(dam_id: str) -> str:
    try:
        meta = json.loads((HERE / "output" / dam_id / "metadata.json").read_text(encoding="utf-8"))
        return meta.get("sources", {}).get("dem", "missing-metadata")
    except Exception:
        return "missing"


def quality_report() -> int:
    """Terrain data-quality report (§13): total / valid / failed / needs-review.

    Never touches assets — read-only. 'valid' = real DEM + verification PASS.
    'needs-review' = real DEM but flat (<60 m relief), missing verification,
    or extreme artifacts (relief > 6000 m or non-finite values).
    """
    import math
    rows = []
    for md_path in sorted((HERE / "output").glob("*/metadata.json")):
        dam_id = md_path.parent.name
        if dam_id == "cache":
            continue
        try:
            d = json.loads(md_path.read_text(encoding="utf-8"))
            dem_src = d.get("sources", {}).get("dem", "?")
            relief = d.get("elevation_max_m", float("nan")) - d.get("elevation_min_m", float("nan"))
            vpath = md_path.parent / "verification.json"
            verified = vpath.exists() and json.loads(vpath.read_text()).get("passes", False)
        except Exception as e:
            rows.append((dam_id, "failed", f"unreadable metadata: {e}"))
            continue
        if "FALLBACK" in dem_src or "SYNTHETIC" in dem_src:
            rows.append((dam_id, "failed", f"synthetic DEM ({dem_src})"))
        elif not verified:
            rows.append((dam_id, "needs-review", "verification missing/failed"))
        elif not math.isfinite(relief) or relief > 6000:
            rows.append((dam_id, "needs-review", f"suspicious relief {relief:.0f} m"))
        elif relief < 60:
            rows.append((dam_id, "needs-review", f"flat terrain ({relief:.0f} m relief)"))
        else:
            rows.append((dam_id, "valid", f"{relief:.0f} m relief, {dem_src}"))
    valid = [r for r in rows if r[1] == "valid"]
    failed = [r for r in rows if r[1] == "failed"]
    review = [r for r in rows if r[1] == "needs-review"]
    print(f"total dams: {len(rows)} | valid 3D: {len(valid)} | "
          f"failed: {len(failed)} | needs manual review: {len(review)}")
    for dam_id, state, why in failed + review:
        print(f"  [{state}] {dam_id}: {why}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Batch-generate dam terrain models")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--only", default=None, help="Comma-separated dam ids")
    p.add_argument("--mesh-size", type=int, default=128)
    p.add_argument("--radius-km", type=float, default=5.0)
    p.add_argument("--exaggeration", type=float, default=1.0)
    p.add_argument("--sleep", type=float, default=3.0, help="Pause between dams (API pacing)")
    p.add_argument("--demo", action="store_true")
    p.add_argument("--overwrite", action="store_true")
    p.add_argument("--retry-fallback", action="store_true",
                   help="Regenerate sites whose DEM is a synthetic FALLBACK (e.g. after quota reset with a new key). Skips sites already real.")
    p.add_argument("--opentopo-keys", default=None,
                   help="Comma/space-separated OpenTopography keys for this run "
                        "(else $OPENTOPOGRAPHY_API_KEY[_N] / $OPENTOPO_KEYS). "
                        "Values are never logged.")
    p.add_argument("--stop-on-quota", action=argparse.BooleanOptionalAction, default=True,
                   help="Abort the batch when every key is exhausted (default: on). "
                        "Prevents churning through dams writing synthetic fallbacks. "
                        "Use --no-stop-on-quota to disable.")
    p.add_argument("--max-quota-failures", type=int, default=3,
                   help="Consecutive quota/rate-limit fallbacks before aborting "
                        "with --stop-on-quota (default 3).")
    p.add_argument("--report", action="store_true",
                   help="Print terrain quality report (total/valid/failed/needs-review) and exit.")
    args = p.parse_args(argv)

    if args.report:
        return quality_report()

    dams = dedupe(parse_dams(DAMS_TS))
    print(f"[batch] {len(dams)} unique dam sites in index")
    if not args.demo:
        n_keys = len(collect_opentopo_keys(args.opentopo_keys))
        print(f"[batch] {n_keys} OpenTopography key(s) configured "
              f"(rotation on quota/rate-limit; values never logged)")
        if n_keys == 0:
            print("[batch] WARNING: no API keys — every site will be a "
                  "synthetic FALLBACK. Set $OPENTOPOGRAPHY_API_KEY[_N], "
                  "$OPENTOPO_KEYS, or --opentopo-keys (or use --demo).")
    if args.only:
        want = set(args.only.split(","))
        dams = [d for d in dams if d["id"] in want]
    if args.limit:
        dams = dams[: args.limit]

    # ── Failure registry: resumable, one site's failure never blocks others.
    # Records per-site status + failure reason (e.g. quota_exceeded) so a
    # rerun can skip good sites and report exactly what needs attention.
    status_path = HERE / "batch_status.json"
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {}

    def record(dam_id: str, state: str, reason: str = "", dem_source: str = ""):
        status[dam_id] = {
            "status": state, "reason": reason, "dem_source": dem_source,
            "updated_utc": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        status_path.write_text(json.dumps(status, indent=2), encoding="utf-8")

    ok, failed, skipped = [], [], []
    quota_misses = 0  # consecutive quota/rate-limit fallbacks (all-keys-exhausted signal)
    with open(HERE / "batch_progress.log", "a", encoding="utf-8") as log:
        for i, d in enumerate(dams, 1):
            glb = HERE / "output" / d["id"] / f"{d['id']}.glb"
            if args.retry_fallback and glb.exists():
                src = dem_source_of(d["id"])
                if "FALLBACK" not in src and "SYNTHETIC" not in src and "missing" not in src:
                    print(f"[batch {i}/{len(dams)}] skip (already real): {d['id']}")
                    skipped.append(d["id"])
                    continue
                print(f"[batch {i}/{len(dams)}] retry fallback ({src}): {d['id']}")
            elif glb.exists() and not args.overwrite:
                print(f"[batch {i}/{len(dams)}] skip (exists): {d['id']} {d['name']}")
                skipped.append(d["id"])
                publish(d["id"], d["name"])
                record(d["id"], "ok", "skipped-exists")
                continue
            print(f"[batch {i}/{len(dams)}] {d['id']} {d['name']} ({d['lat']},{d['lon']})")
            argv_pipe = ["--lat", str(d["lat"]), "--lon", str(d["lon"]),
                         "--name", d["id"], "--mesh-size", str(args.mesh_size),
                         "--radius-km", str(args.radius_km),
                         "--exaggeration", str(args.exaggeration)]
            if args.demo:
                argv_pipe.append("--demo")
            if args.opentopo_keys:
                argv_pipe += ["--opentopo-key", args.opentopo_keys]
            try:
                rc = run_pipeline(argv_pipe)
            except SystemExit as e:
                rc = e.code or 0
            except Exception as e:  # keep the batch alive
                print(f"[batch] ERROR {d['id']}: {e}")
                rc = 1
            line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {d['id']} rc={rc}"
            print("[batch]", line)
            log.write(line + "\n")
            log.flush()
            if rc == 0:
                ok.append(d["id"])
                publish(d["id"], d["name"])
                # Surface the DEM provenance (incl. FALLBACK:<reason>) in the registry.
                dem_source = ""
                try:
                    meta = json.loads((HERE / "output" / d["id"] / "metadata.json").read_text(encoding="utf-8"))
                    dem_source = meta.get("sources", {}).get("dem", "")
                except Exception:
                    pass
                record(d["id"], "ok" if "FALLBACK" not in dem_source else "fallback",
                       dem_source=dem_source)
                if ("FALLBACK:quota_exceeded" in dem_source
                        or "FALLBACK:rate_limited" in dem_source
                        or "FALLBACK:invalid_key" in dem_source):
                    quota_misses += 1
                    if args.stop_on_quota and quota_misses >= args.max_quota_failures:
                        msg = (f"[batch] ABORT: {quota_misses} consecutive key-exhaustion "
                               f"fallbacks ({dem_source}). All OpenTopography keys appear "
                               f"dead — add fresh legitimate keys and rerun with "
                               f"--retry-fallback. No more dams attempted.")
                        print(msg)
                        log.write(time.strftime("%Y-%m-%dT%H:%M:%S") + " " + msg + "\n")
                        break
                else:
                    quota_misses = 0
            else:
                failed.append(d["id"])
                record(d["id"], "failed", reason=f"pipeline-rc-{rc}")
            time.sleep(args.sleep)

    print(f"[batch] done: ok={len(ok)} failed={failed} skipped={len(skipped)}")
    print(f"[batch] registry: {status_path} "
          f"({sum(1 for v in status.values() if v['status'] == 'ok')} ok, "
          f"{sum(1 for v in status.values() if v['status'] == 'fallback')} fallback, "
          f"{sum(1 for v in status.values() if v['status'] == 'failed')} failed)")
    return 0 if not failed else 2


if __name__ == "__main__":
    raise SystemExit(main())

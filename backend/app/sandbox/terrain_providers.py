"""
DamSafe Twin Sandbox — terrain provider abstraction.

Chain (first valid result wins; every attempt is recorded in the trail):

  1. LocalTerrainProvider   — curated output/<dam_id>/dem_raw.tif (never redownloaded)
  2. CopernicusGLO30        — AWS Open Data COGs, NO credentials (same COP-DEM_GLO-30-DGED source)
  3. CopernicusGLO90        — AWS Open Data COGs, NO credentials (full global cover)
  4. CDSESRTM               — Copernicus Data Space S3 (CDSE_S3_* env, 30 m SRTMGL1 .hgt)
  5. OpenTopographyFallback — portal API (OPENTOPOGRAPHY_API_KEY[_N], COP30 then SRTMGL1)

Design rules:
  - Credentials ONLY from environment variables. Never logged, never returned,
    never written to disk. Only key *lengths* and endpoint hostnames appear in logs.
  - Small AOIs only: 1-degree tiles intersecting the dam bbox are fetched,
    mosaicked and cropped. No bulk downloads.
  - Acquired DEMs are written to terrain_dir()/<dam_id>/dem_raw.tif with a
    metadata.json sidecar, so every later run is served by provider 1.
  - Synthetic/fake terrain is NEVER produced here. Failure raises
    TerrainUnavailableError carrying the per-provider trail for honest
    "REAL SIMULATION UNAVAILABLE: <reason>" API errors.
"""

from __future__ import annotations

import math
import os
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

COPERNICUS_AWS_TMPL = (
    "https://copernicus-dem-{res}m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_{code}_{ns}_{es}_DEM/"
    "Copernicus_DSM_COG_{code}_{ns}_{es}_DEM.tif"
)
CDSE_ENDPOINT = "https://eodata.dataspace.copernicus.eu"
CDSE_BUCKET = "eodata"
CDSE_SRTM_PREFIX = "auxdata/SRTMGL1/dem/"
OPENTOPO_URL = "https://portal.opentopography.org/API/globaldem"

BBox = tuple[float, float, float, float]  # west, south, east, north


class ProviderError(RuntimeError):
    """One provider failed; the chain continues with the next provider."""


class TerrainUnavailableError(RuntimeError):
    """All providers failed. `trail` lists per-provider reasons (safe to expose)."""

    def __init__(self, dam_id: str, trail: list[str]):
        self.dam_id = dam_id
        self.trail = trail
        super().__init__(
            f"REAL SIMULATION UNAVAILABLE: no terrain for dam '{dam_id}'. "
            + " | ".join(trail)
        )


def bbox_from_center(lat: float, lon: float, radius_km: float) -> BBox:
    dlat = radius_km / 110.54
    dlon = radius_km / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _tile_sw(value: float, digits: int, neg: str, pos: str) -> str:
    hemi = pos if value >= 0 else neg
    return f"{hemi}{abs(math.floor(value)):0{digits}d}_00"


def copernicus_cog_url(lat_sw: int, lon_sw: int, glo: int) -> str:
    """Public AWS COG URL for the 1-degree tile whose SW corner is (lat_sw, lon_sw)."""
    res = 30 if glo == 30 else 90
    code = 10 if glo == 30 else 30
    ns = _tile_sw(lat_sw, 2, "S", "N")
    es = _tile_sw(lon_sw, 3, "W", "E")
    return COPERNICUS_AWS_TMPL.format(res=res, code=code, ns=ns, es=es)


def tiles_for_bbox(bbox: BBox) -> list[tuple[int, int]]:
    west, south, east, north = bbox
    eps = 1e-9
    return [
        (la, lo)
        for la in range(math.floor(south), math.floor(north - eps) + 1)
        for lo in range(math.floor(west), math.floor(east - eps) + 1)
    ]


def _valid_dem(path: Path) -> bool:
    try:
        import rasterio
        with rasterio.open(path) as src:
            if src.count < 1 or src.width < 16 or src.height < 16:
                return False
            arr = src.read(1, out_shape=(min(64, src.height), min(64, src.width)))
            finite = float((arr == arr).sum()) / arr.size
            return finite > 0.5
    except Exception:
        return False


def _download(url: str, timeout: int = 180) -> Path:
    import requests
    tmp = Path(tempfile.mkdtemp(prefix="damsafe_dem_"))
    out = tmp / "tile.tif"
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(out, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)
    if out.stat().st_size < 10_000:
        raise ProviderError(f"download too small ({out.stat().st_size} B): {url}")
    magic = out.read_bytes()[:4]
    if magic not in (b"II*\x00", b"MM\x00*"):
        raise ProviderError(f"not a TIFF response: {url}")
    return out


def _mosaic_crop(sources: list[Path], bbox: BBox, out_path: Path) -> None:
    import rasterio
    from rasterio.merge import merge
    datasets = [rasterio.open(p) for p in sources]
    try:
        mosaic, transform = merge(datasets, bounds=bbox)
    finally:
        for d in datasets:
            d.close()
    if mosaic.shape[1] < 8 or mosaic.shape[2] < 8:
        raise ProviderError("mosaic crop is degenerately small")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w", driver="GTiff", height=mosaic.shape[1], width=mosaic.shape[2],
        count=1, dtype="float32", crs="EPSG:4326", transform=transform,
        compress="deflate", tiled=True,
    ) as dst:
        dst.write(mosaic[0].astype("float32"), 1)


# --------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------

def _provider_local(dam_id: str, roots: list[Path], bbox: BBox, tmp: Path) -> tuple[str, dict]:
    for root in roots:
        dem = root / dam_id / "dem_raw.tif"
        if dem.exists() and _valid_dem(dem):
            return str(dem), {"source": "local-cache", "dataset": "curated-DEM",
                              "note": "existing terrain asset reused, no download"}
    raise ProviderError("no valid curated dem_raw.tif on disk")


def _provider_copernicus_public(bbox: BBox, tmp: Path, glo: int) -> tuple[str, dict]:
    tiles = tiles_for_bbox(bbox)
    if len(tiles) > 9:
        raise ProviderError(f"AOI spans {len(tiles)} tiles — refusing bulk download")
    local = []
    for la, lo in tiles:
        url = copernicus_cog_url(la, lo, glo)
        try:
            local.append(_download(url))
        except Exception as e:
            raise ProviderError(f"GLO-{glo} tile {la}/{lo} unavailable ({type(e).__name__})")
    out = tmp / f"copernicus_glo{glo}.tif"
    _mosaic_crop(local, bbox, out)
    return str(out), {"source": "Copernicus DEM", "dataset": f"GLO-{glo}",
                      "resolution_m": glo, "tiles": len(tiles), "auth": "none (AWS Open Data)"}


def _cdse_client():
    ak = os.environ.get("CDSE_S3_ACCESS_KEY", "")
    sk = os.environ.get("CDSE_S3_SECRET_KEY", "")
    if not ak or not sk:
        raise ProviderError("CDSE_S3_ACCESS_KEY / CDSE_S3_SECRET_KEY not configured")
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=CDSE_ENDPOINT, aws_access_key_id=ak,
        aws_secret_access_key=sk, region_name="default",
        config=Config(signature_version="s3v4", connect_timeout=20, read_timeout=120),
    )


def _provider_cdse_srtm(bbox: BBox, tmp: Path) -> tuple[str, dict]:
    """Authenticated 30 m SRTMGL1 .hgt tiles from CDSE eodata (proves the user keys work)."""
    s3 = _cdse_client()  # raises ProviderError when unconfigured (chain continues)
    import rasterio
    local = []
    for la, lo in tiles_for_bbox(bbox):
        key = f"{CDSE_SRTM_PREFIX}N{abs(la):02d}E{lo:03d}.SRTMGL1.hgt.zip"
        dest = tmp / f"srtm_{la}_{lo}.zip"
        try:
            s3.download_file(CDSE_BUCKET, key, str(dest))
        except Exception as e:
            raise ProviderError(f"CDSE tile {key} unavailable ({type(e).__name__})")
        if dest.stat().st_size < 100_000:
            raise ProviderError(f"CDSE tile {key} is a void stub ({dest.stat().st_size} B)")
        with zipfile.ZipFile(dest) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".hgt")]
            if not names:
                raise ProviderError(f"CDSE zip has no .hgt: {key}")
            z.extract(names[0], tmp)
            local.append(tmp / names[0])
    # rasterio reads .hgt natively; normalize to a single cropped GeoTIFF
    srcs = [rasterio.open(p) for p in local]
    try:
        from rasterio.merge import merge
        mosaic, transform = merge(srcs, bounds=bbox)
    finally:
        for d in srcs:
            d.close()
    out = tmp / "cdse_srtm.tif"
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", height=mosaic.shape[1],
                       width=mosaic.shape[2], count=1, dtype="float32",
                       crs="EPSG:4326", transform=transform,
                       compress="deflate", tiled=True) as dst:
        dst.write(mosaic[0].astype("float32"), 1)
    return str(out), {"source": "Copernicus Data Space", "dataset": "SRTMGL1-30m",
                      "resolution_m": 30, "auth": "CDSE S3 keys (values never logged)"}


def _ot_keys() -> list[str]:
    keys: list[str] = []

    def split(blob: str | None):
        for p in (blob or "").replace(",", " ").split():
            p = p.strip()
            if p and p.lower() not in {"", "paste_your_key_here", "xxx"} and p not in keys:
                keys.append(p)

    for i in range(1, 10):
        split(os.environ.get(f"OPENTOPOGRAPHY_API_KEY_{i}"))
    split(os.environ.get("OPENTOPO_KEYS"))
    split(os.environ.get("OPENTOPOGRAPHY_API_KEYS"))
    split(os.environ.get("OPENTOPOGRAPHY_API_KEY"))
    return keys


def _provider_opentopo(bbox: BBox, tmp: Path) -> tuple[str, dict]:
    """Last-resort fallback: OpenTopography GlobalDEM with key rotation."""
    import requests
    keys = _ot_keys()
    if not keys:
        raise ProviderError("no OPENTOPOGRAPHY_API_KEY configured")
    west, south, east, north = bbox
    retired = 0
    last = "unknown"
    for idx, key in enumerate(keys):
        for demtype in ("COP30", "SRTMGL1"):
            try:
                r = requests.get(OPENTOPO_URL, params={
                    "demtype": demtype, "south": south, "north": north,
                    "west": west, "east": east, "outputFormat": "GTiff",
                    "API_Key": key}, timeout=180)
            except Exception as e:
                last = f"network ({type(e).__name__})"
                continue
            body = r.content
            if r.status_code == 200 and len(body) > 4 and body[:4] in (b"II*\x00", b"MM\x00*"):
                out = tmp / "opentopo.tif"
                out.write_bytes(body)
                return str(out), {"source": "OpenTopography", "dataset": demtype,
                                  "key_index": idx + 1, "note": "last-resort fallback"}
            text = (r.text or "")[:160].lower()
            last = f"{demtype}:{r.status_code}"
            if ("quota" in text or "exceed" in text or r.status_code in (401, 403)
                    or ("invalid" in text and "key" in text)):
                retired += 1
                break  # rotate to next key
    raise ProviderError(f"all {len(keys)} key(s) unusable ({retired} retired, last={last})")


# --------------------------------------------------------------------------
# Chain entry point
# --------------------------------------------------------------------------

PROVIDER_CHAIN = ("local", "copernicus-glo30", "copernicus-glo90", "cdse-srtm", "opentopo")


def ensure_dem(dam_id: str, lat: float, lon: float, roots: list[Path],
               write_root: Path, radius_km: float = 5.0) -> tuple[Path, dict]:
    """Return (dem_path, provenance). Acquired DEMs are written to write_root
    (writable cache); roots are searched read-only first. Raises
    TerrainUnavailableError."""
    bbox = bbox_from_center(lat, lon, radius_km)
    trail: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix=f"damsafe_{dam_id}_"))

    attempts = [
        ("local", lambda: _provider_local(dam_id, roots, bbox, tmp)),
        ("copernicus-glo30", lambda: _provider_copernicus_public(bbox, tmp, 30)),
        ("copernicus-glo90", lambda: _provider_copernicus_public(bbox, tmp, 90)),
        ("cdse-srtm", lambda: _provider_cdse_srtm(bbox, tmp)),
        ("opentopo", lambda: _provider_opentopo(bbox, tmp)),
    ]
    for name, fn in attempts:
        try:
            src, info = fn()
        except ProviderError as e:
            trail.append(f"{name}: {e}")
            continue
        except Exception as e:  # never let one provider crash the chain
            trail.append(f"{name}: unexpected {type(e).__name__}")
            continue
        if not _valid_dem(Path(src)):
            trail.append(f"{name}: downloaded raster failed validation")
            continue
        # Persist into the writable cache root (the curated tree stays pristine).
        import shutil
        dest_dir = write_root / dam_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / "dem_raw.tif"
        if name != "local":
            shutil.copy2(src, dest)
        else:
            dest = Path(src)
        provenance = {
            "source": info.get("source"), "dataset": info.get("dataset", ""),
            "resolution_m": info.get("resolution_m", 0),
            "fallback_used": name != "copernicus-glo30",
            "fallback_reason": "" if name == "copernicus-glo30"
            else f"served by {name} ({info.get('note', info.get('auth', ''))})",
            "aoi_wsen": list(bbox), "radius_km": radius_km,
            "cached": name == "local",
            "attempt_trail": trail,
            "acquired_utc": datetime.now(timezone.utc).isoformat(),
        }
        (dest_dir / "dem_provenance.json").write_text(
            __import__("json").dumps(provenance, indent=2), encoding="utf-8")
        return dest, provenance
    raise TerrainUnavailableError(dam_id, trail)

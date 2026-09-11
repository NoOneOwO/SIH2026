# Dam-site Terrain → glTF Pipeline

Generates a small georeferenced, satellite-textured 3D terrain model for a dam
site, ready to load into GeoLibre (CesiumJS-based globe).

## Quick start (offline demo)

```bash
pip install -r requirements.txt
python terrain_pipeline.py --dam "Tehri Dam" --demo --mesh-size 128
```

Output: `output/Tehri_Dam/{dem_raw.tif, texture.png, Tehri_Dam.glb, transform.json, metadata.json, verification.json}`

## Real data

```bash
set OPENTOPOGRAPHY_API_KEY=your_key   # Windows (or export on Linux)
python terrain_pipeline.py --dam "Tehri Dam" --mesh-size 256
```

### API-key rotation (quota fallback)

OpenTopography quotas are per-key. For batch runs, pool several legitimate
keys (each teammate creates their own at
https://portal.opentopography.org/ — never commit them, `.env` is ignored):

```bash
set OPENTOPOGRAPHY_API_KEY_1=key_one
set OPENTOPOGRAPHY_API_KEY_2=key_two
# ...or comma-separated: set OPENTOPO_KEYS=key_one,key_two,key_three
python batch_generate.py --retry-fallback
```

Behavior: quota/invalid/rate-limit failures rotate to the next key (exhausted
keys retire for the run, rate-limited keys cool down 60 s); the batch aborts
early with `--stop-on-quota` (default on) instead of writing synthetic
fallbacks for every dam. Permanent errors (bad bbox, no dataset coverage)
still surface as `OTError(dataset_unavailable/unknown)` — never hidden.
`--demo` and single-key usage are unchanged.

- DEM: OpenTopography GlobalDEM — tries `COP30` (Copernicus GLO-30), falls back
  to `SRTMGL1`. Saved as `dem_raw.tif` (EPSG:4326).
- Texture: Esri World Imagery (`export` endpoint, no key), reprojected with
  `rasterio.warp` onto the DEM's exact bbox/rows/cols → `texture.png`.
- If either fetch fails (or no API key), the pipeline falls back to clearly
  labelled synthetic data (`sources` in `metadata.json` gets a `+FALLBACK`
  suffix) so the mesh/GLB stages still run.

## CLI

| Flag | Meaning |
|---|---|
| `--dam "Name"` | Look up site in `dams.json` |
| `--lat/--lon [--name]` | Custom site (skip registry) |
| `--radius-km` | BBox half-size (default from registry, 5 km) |
| `--mesh-size` | Max mesh grid dim (default 256; 128 ≈ 16k verts, fast) |
| `--exaggeration` | Vertical exaggeration, 1.0 = true scale |
| `--demo` | Offline synthetic DEM + texture |
| `--output-dir` | Output root (default `output/`) |

## Key design decisions

1. **Geo-anchoring: local ENU mesh + `transform.json`** (chosen over baked-ECEF
   and CESIUM_RTC). Mesh vertices are small local meters in a Y-up frame
   (`x=east, y=up-relative-to-center, z=south`), and `transform.json` carries
   `lat/lon/center_elevation_m` plus `modelMatrix_columnMajor` (Cesium
   `Matrix4`-compatible) mapping local → ECEF. Baked ECEF (~6e6 m) loses
   precision in float32 glTF accessors (vertex jitter); CESIUM_RTC is
   legacy/deprecated with poor tooling.
2. **Mesh/export: `trimesh`** (chosen over hand-rolling with `pygltflib`).
   `trimesh` builds the triangulated grid, assigns UVs, embeds `texture.png`,
   and exports a single self-contained `.glb`. Verified: the GLB contains 1
   embedded `image/png` bufferView, 0 external URIs, 0 extensions.
3. **No lossy PNG round-trip for geometry**: the DEM `float` array feeds mesh
   generation directly; `texture.png` is color only.

## Loading into GeoLibre / CesiumJS

```js
import * as Cesium from 'cesium';
const t = await fetch('/models/Tehri_Dam/transform.json').then(r => r.json());
const modelMatrix = Cesium.Matrix4.fromArray(t.modelMatrix_columnMajor);
const model = await Cesium.Model.fromGltf({ url: '/models/Tehri_Dam/Tehri_Dam.glb', modelMatrix });
viewer.scene.primitives.add(model);
await viewer.zoomTo(model);
// Equivalent entity form: position = Cartesian3.fromArray(t.center_ecef_m)
```

Open `cesium_test.html` in a browser (serving this folder over HTTP) for a
minimal placement check — the model should sit on the globe surface at the dam
site, not floating or buried.

## Verification (automated)

Every run maps all GLB vertices through `modelMatrix` to ECEF and compares
each vertex's radius against ellipsoid-center + local up-vector. Demo runs:

- Tehri Dam (128): max radial err 18.6 m, mean 7.4 m → PASS (tol 50 m)
- Bhakra Dam (64, lat/lon path): max 18.8 m → PASS
- Hirakud Dam (64, exaggeration 1.5): max 15.4 m → PASS

Residual error is tile-curvature approximation (spherical-vs-ellipsoid over a
10 km tile), not a placement bug — center error ≈ 0. Results are saved to
`verification.json`.

## Extending `dams.json`

Append `{ "name": ..., "lat": ..., "lon": ..., "bbox_radius_km": ... }` to the
`dams` list — no code changes needed.

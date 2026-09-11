"""Stdlib-only verification for multi-key OpenTopography rotation.

Stubs numpy/requests (import-time only; rotation logic needs neither),
then exercises collect_opentopo_keys, OpenTopoKeyPool, and
fetch_dem_opentopo with a mocked _ot_get. No network, no real keys.
"""
import io
import os
import sys
import tempfile
import types
from contextlib import redirect_stderr, redirect_stdout

# ---- Stub third-party imports so terrain_pipeline imports w/o deps ----
sys.modules["numpy"] = types.ModuleType("numpy")
req = types.ModuleType("requests")
req.Timeout = type("Timeout", (Exception,), {})
req.ConnectionError = type("ConnectionError", (Exception,), {})
sys.modules["requests"] = req

sys.path.insert(0, os.environ.get("PIPELINE_SRC", os.path.dirname(os.path.abspath(__file__))))
import terrain_pipeline as tp

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" — {extra}" if extra and not cond else ""))


def clean_env():
    for k in list(os.environ):
        if k.upper().startswith(("OPENTOPOGRAPHY", "OPENTOPO")):
            del os.environ[k]


# ---- 1. collect_opentopo_keys ----
clean_env()
check("no keys -> []", tp.collect_opentopo_keys() == [])

clean_env()
os.environ["OPENTOPOGRAPHY_API_KEY"] = "LEGACY1"
check("legacy single key", tp.collect_opentopo_keys() == ["LEGACY1"])

clean_env()
os.environ["OPENTOPOGRAPHY_API_KEY_2"] = "KEY_TWO"
os.environ["OPENTOPOGRAPHY_API_KEY_1"] = "KEY_ONE"
os.environ["OPENTOPOGRAPHY_API_KEY"] = "LEGACY1"
os.environ["OPENTOPO_KEYS"] = "KEY_A, KEY_B KEY_A"
os.environ["OPENTOPOGRAPHY_API_KEY_3"] = "paste_your_key_here"
got = tp.collect_opentopo_keys("EXTRA1,EXTRA2")
check("priority+numbered+csv+legacy+dedupe",
      got == ["EXTRA1", "EXTRA2", "KEY_ONE", "KEY_TWO", "KEY_A", "KEY_B", "LEGACY1"],
      f"got {got}")

# ---- 2. OpenTopoKeyPool ----
pool = tp.OpenTopoKeyPool(["a", "b", "c"])
order = [pool.next_index() for _ in range(4)]
check("round-robin", order == [0, 1, 2, 0], f"got {order}")
pool.report(1, "quota_exceeded")
rest = sorted(pool.next_index() for _ in range(4))
check("retired key skipped", rest == [0, 0, 2, 2], f"got {rest}")
check("retired_count", pool.retired_count == 1)
pool2 = tp.OpenTopoKeyPool(["only"])
pool2.report(0, "rate_limited")
check("rate-limited cools down", not pool2.has_usable_key())
pool2.report(0, "network_error")  # unknown kinds must not retire/cool
check("network error keeps key usable",
      tp.OpenTopoKeyPool(["x", "y"]).has_usable_key())

# ---- 3. fetch_dem_opentopo rotation (mock _ot_get) ----
class FakeResp:
    def __init__(self, status, body: bytes):
        self.status_code = status
        self.content = body
        try:
            self.text = body.decode("utf-8", "replace")
        except Exception:
            self.text = ""


TIFF = b"II*\x00" + b"\x00" * 100


def run_fetch(script, keys, demtype_ok="COP30"):
    """script: dict key-value -> (status, body). Returns (result, stderr)."""
    calls = []

    def fake_ot_get(params, timeout=120, retries=3):
        calls.append(params["API_Key"])
        status, body = script[params["API_Key"]]
        return FakeResp(status, body)

    tp._ot_get = fake_ot_get
    tmp = tempfile.mkdtemp()
    os.environ["OPENTOPO_CACHE_DIR"] = tmp
    out = os.path.join(tmp, "dem.tif")
    err = io.StringIO()
    with redirect_stderr(err):
        res = tp.fetch_dem_opentopo((78.4, 30.3, 78.5, 30.4), tp.Path(out), keys)
    return res, err.getvalue(), calls, out


clean_env()
# key1 invalid -> rotate to key2 which returns TIFF
res, err, calls, out = run_fetch(
    {"BADKEY": (401, b'{"error": "Invalid API key"}'),
     "GOODKEY": (200, TIFF)},
    ["BADKEY", "GOODKEY"])
check("rotates past invalid key", res == "OpenTopography:COP30" and calls == ["BADKEY", "GOODKEY"],
      f"res={res} calls={calls}")
check("tiff written", os.path.exists(out) and open(out, "rb").read()[:4] == b"II*\x00")
check("key values never logged", "BADKEY" not in err and "GOODKEY" not in err, err[:300])

clean_env()
# both keys quota-exhausted -> OTError naming all-keys-exhausted
err2 = io.StringIO()
calls2 = []

def fake_quota(params, timeout=120, retries=3):
    calls2.append(params["API_Key"])
    return FakeResp(403, b'{"error": "Quota exceeded for this API key"}')

tp._ot_get = fake_quota
tmp2 = tempfile.mkdtemp()
os.environ["OPENTOPO_CACHE_DIR"] = tmp2
try:
    with redirect_stderr(err2):
        tp.fetch_dem_opentopo((78.4, 30.3, 78.5, 30.4), tp.Path(tmp2) / "d.tif",
                              ["K1", "K2"])
    check("all-exhausted raises", False, "no exception")
except tp.OTError as e:
    check("all-exhausted raises quota_exceeded", e.kind == "quota_exceeded", f"kind={e.kind}")
    check("message counts keys, hides values",
          "All 2" in str(e) and "K1" not in str(e) and "K2" not in str(e), str(e)[:200])

clean_env()
# dataset missing on COP30 -> falls through to SRTMGL1 with same keys
def fake_dataset(params, timeout=120, retries=3):
    if params["demtype"] == "COP30":
        return FakeResp(404, b'{"error": "no data for this demtype"}')
    return FakeResp(200, TIFF)

tp._ot_get = fake_dataset
tmp3 = tempfile.mkdtemp()
os.environ["OPENTOPO_CACHE_DIR"] = tmp3
with redirect_stderr(io.StringIO()):
    res3 = tp.fetch_dem_opentopo((78.4, 30.3, 78.5, 30.4), tp.Path(tmp3) / "d.tif", "ONEKEY")
check("dataset fallback preserved", res3 == "OpenTopography:SRTMGL1", f"res={res3}")

# ---- 4. CLI still parses; --help works ----
try:
    with redirect_stdout(io.StringIO()):
        tp.main(["--help"])
    check("--help exit 0", False, "no SystemExit")
except SystemExit as e:
    check("--help exit 0", e.code == 0, f"code={e.code}")

a = tp.parse_args(["--dam", "Tehri Dam", "--opentopo-key", "k1,k2"])
check("--opentopo-key parses", a.opentopo_key == "k1,k2")

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)

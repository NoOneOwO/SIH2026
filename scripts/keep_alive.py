"""DamSafe Twin — keep-alive pinger.

Hits GET <BACKEND_URL>/health to prevent the Render free-tier web service
from sleeping. Stdlib only (no pip install needed on the cron worker).

Env:
  BACKEND_URL  e.g. https://damsafe-api.onrender.com  (or bare hostname —
                 scheme + /health are added automatically)
"""

import os
import sys
import urllib.request


def build_url() -> str:
    raw = os.environ.get("BACKEND_URL", "").strip()
    if not raw:
        print("ERROR: BACKEND_URL env var is not set", file=sys.stderr)
        sys.exit(1)
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    raw = raw.rstrip("/")
    if not raw.endswith("/health"):
        raw += "/health"
    return raw


def main() -> None:
    url = build_url()
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "damsafe-keep-alive/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read(512).decode("utf-8", "replace")
            print(f"OK {resp.status} {url} -> {body}")
    except Exception as exc:  # noqa: BLE001 — cron log is the alert channel
        print(f"FAIL {url}: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

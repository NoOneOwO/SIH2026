"""
DamSafe Twin — API v1 Router entry point.

Re-exports the aggregated router (defined in app.api) for main.py.
"""

from app.api import api_router  # noqa: F401

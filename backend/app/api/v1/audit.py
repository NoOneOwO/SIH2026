"""
DamSafe Twin — Audit Router (v1 wiring).

Re-exports the audit-trail router so the v1 aggregator can mount it.
"""

from app.audit.router import router  # noqa: F401

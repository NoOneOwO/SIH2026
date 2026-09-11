"""
DamSafe Twin — Audit Middleware

Transaction-scoped middleware that writes every mutating request to the audit_log table.
"""

import uuid
import json
from datetime import datetime
from typing import Callable, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class AuditMiddleware(BaseHTTPMiddleware):
    """Logs every mutating HTTP call (POST, PUT, PATCH, DELETE) to the audit_log."""

    SAFE_PATHS = {"/health", "/api/docs", "/api/redoc", "/api/openapi.json", "/docs", "/redoc", "/openapi.json"}
    MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)

        # Only audit mutating requests to data endpoints
        if (
            request.method not in self.MUTATING_METHODS
            or request.url.path in self.SAFE_PATHS
            or not request.url.path.startswith("/api/")
        ):
            return response

        # Extract user from request state (set by auth middleware if present)
        actor_id = None
        if hasattr(request.state, "user") and request.state.user:
            actor_id = getattr(request.state.user, "id", None)

        # Build audit entry
        diff = {
            "method": request.method,
            "path": str(request.url.path),
            "query": str(request.url.query) if request.url.query else None,
            "status_code": response.status_code,
        }

        audit_entry = {
            "actor_id": actor_id,
            "action": f"{request.method} {request.url.path}",
            "entity": self._extract_entity(request.url.path),
            "entity_id": self._extract_entity_id(request.url.path),
            "diff": diff,
            "at": datetime.utcnow().isoformat(),
        }

        # Write asynchronously (fire-and-forget to avoid blocking response)
        try:
            from app.database import async_session_factory
            from sqlalchemy import text

            async with async_session_factory() as session:
                await session.execute(
                    text(
                        "INSERT INTO audit_log (actor_id, action, entity, entity_id, diff, at) "
                        "VALUES (:actor_id, :action, :entity, :entity_id, :diff::jsonb, :at)"
                    ),
                    {
                        "actor_id": uuid.UUID(audit_entry["actor_id"]) if audit_entry["actor_id"] else None,
                        "action": audit_entry["action"],
                        "entity": audit_entry["entity"],
                        "entity_id": uuid.UUID(audit_entry["entity_id"]) if audit_entry["entity_id"] else None,
                        "diff": json.dumps(audit_entry["diff"]),
                        "at": audit_entry["at"],
                    },
                )
                await session.commit()
        except Exception:
            # Audit failures must never break the main request
            pass

        return response

    @staticmethod
    def _extract_entity(path: str) -> str:
        """Extract the entity name from the URL path."""
        parts = [p for p in path.split("/") if p and p != "api" and p != "v1"]
        if parts:
            return parts[0].rstrip("s")  # "scenarios" -> "scenario"
        return "unknown"

    @staticmethod
    def _extract_entity_id(path: str) -> Optional[str]:
        """Try to extract a UUID from the URL path."""
        import re
        uuid_pattern = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        match = re.search(uuid_pattern, path, re.IGNORECASE)
        return match.group() if match else None

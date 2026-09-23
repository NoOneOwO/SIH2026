"""
DamSafe Twin — Auth Module

OIDC token verification (Keycloak) + RBAC decorators.
For MVP dev mode, supports a bypass token for local development.
"""

from functools import wraps
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel

from app.config import get_settings

settings = get_settings()

# Security scheme
security = HTTPBearer(auto_error=False)

# Role hierarchy
ROLE_HIERARCHY = {
    "viewer": 0,
    "operator": 1,
    "official": 2,
    "analyst": 2,
    "approver": 3,
    "admin": 4,
}


class CurrentUser(BaseModel):
    """Authenticated user context extracted from JWT."""
    id: str
    sub: str
    name: str
    role: str
    email: Optional[str] = None
    dam_id: Optional[str] = None
    status: Optional[str] = None


class DevUser(CurrentUser):
    """Development bypass user for local dev without Keycloak."""
    pass


def _get_dev_user() -> DevUser:
    """Return a dev-mode user when running locally without Keycloak."""
    return DevUser(
        id="00000000-0000-0000-0000-000000000001",
        sub="dev-user",
        name="Dev Operator",
        role="admin",
        email="dev@damsafe.local",
    )


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> CurrentUser:
    """
    Extract and verify the current user from the Authorization header.
    In dev mode (no OIDC issuer configured or credentials missing), returns a dev user.
    """
    # Dev mode bypass
    if settings.ENVIRONMENT == "development" and (not credentials or not credentials.credentials):
        return _get_dev_user()

    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header",
        )

    token = credentials.credentials

    # Local official JWTs (govt postings) take precedence when they verify.
    try:
        from app.auth.local import verify_local_token

        local = verify_local_token(token)
        if local is not None:
            if local.status not in (None, "approved"):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Account is {local.status} — awaiting admin verification",
                )
            return local
    except HTTPException:
        raise
    except Exception:
        pass

    try:
        # In production, verify against Keycloak JWKS
        if settings.OIDC_JWKS_URL:
            payload = jwt.decode(
                token,
                settings.OIDC_JWKS_URL,
                algorithms=["RS256"],
                audience=settings.OIDC_CLIENT_ID,
                issuer=settings.OIDC_ISSUER,
            )
        else:
            # Dev mode: decode without verification (key required positionally by python-jose)
            payload = jwt.decode(token, key="", options={"verify_signature": False})

        return CurrentUser(
            id=payload.get("sub", ""),
            sub=payload.get("sub", ""),
            name=payload.get("name", payload.get("preferred_username", "Unknown")),
            role=payload.get("role", payload.get("damsafe_role", "viewer")),
            email=payload.get("email"),
        )
    except JWTError as e:
        # Local dev without Keycloak: any undecodable token (e.g. the
        # frontend's 'dev-token') maps to the dev user. Production still 401s.
        if settings.ENVIRONMENT == "development":
            return _get_dev_user()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {str(e)}",
        )


def require_role(minimum_role: str):
    """
    Dependency factory that enforces a minimum RBAC role.

    Usage:
        @router.get("/protected", dependencies=[Depends(require_role("analyst"))])
        async def my_endpoint(user: CurrentUser = Depends(get_current_user)): ...
    """
    min_level = ROLE_HIERARCHY.get(minimum_role, 0)

    async def _check(
        request: Request,
        user: CurrentUser = Depends(get_current_user),
    ):
        user_level = ROLE_HIERARCHY.get(user.role, 0)
        if user_level < min_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role}' insufficient; requires '{minimum_role}' or higher",
            )
        # Publish the verified identity for downstream consumers (audit log).
        # Additive only — authorization decisions above are unchanged.
        request.state.user = user
        return user

    return _check


async def get_approver(user: CurrentUser = Depends(require_role("approver"))):
    """Shortcut: ensures the user is at least an Approving Engineer."""
    return user

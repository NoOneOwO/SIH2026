"""DamSafe Twin — local official auth (government dam-posting verification).

Self-contained alternative to Keycloak for this deployment:
- Officials register with posting details + posting dam + an identity/address
  document (PDF/JPG/PNG ≤ 10 MB). Status starts `pending`.
- An admin verifies documents and approves → role `official`, dam-scoped.
- Login issues a short-lived HS256 JWT carrying {role, dam_id, status}.
- Simulation RUN endpoints enforce dam scope (admins exempt).

A seed admin (`admin@damsafe.local` / `ChangeMe123!`, approved) is created on
first use — change its password immediately via /auth/change-password.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

import bcrypt
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from jose import JWTError, jwt
from pydantic import BaseModel

from app.auth.service import CurrentUser, get_current_user, require_role
from app.sandbox.dam_registry import get_dam

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
USERS_PATH = DATA_DIR / "users.json"
DOCS_DIR = DATA_DIR / "documents"
SECRET = os.environ.get("DAMSAFE_AUTH_SECRET", "damsafe-dev-secret-CHANGE-ME")
ALGO = "HS256"
TOKEN_HOURS = 12
ALLOWED_DOCS = {".pdf", ".jpg", ".jpeg", ".png"}
MAX_DOC_BYTES = 10 * 1024 * 1024


def _load() -> list[dict]:
    if not USERS_PATH.exists():
        return []
    try:
        return json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(users: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    USERS_PATH.write_text(json.dumps(users, indent=2), encoding="utf-8")


def _ensure_seed_admin() -> None:
    users = _load()
    if any(u.get("email") == "admin@damsafe.local" for u in users):
        return
    users.append({
        "id": uuid.uuid4().hex[:12],
        "name": "DamSafe Administrator",
        "email": "admin@damsafe.local",
        "password_hash": bcrypt.hashpw(b"ChangeMe123!", bcrypt.gensalt()).decode(),
        "phone": "",
        "designation": "System Administrator",
        "dam_id": None,
        "document": None,
        "role": "admin",
        "status": "approved",
        "created_at": time.time(),
    })
    _save(users)


def _public(u: dict) -> dict:
    return {k: u.get(k) for k in ("id", "name", "email", "phone", "designation", "dam_id", "document", "role", "status", "created_at")}


def _token(u: dict) -> str:
    now = int(time.time())
    return jwt.encode({
        "sub": u["id"], "name": u["name"], "email": u["email"],
        "role": u["role"], "dam_id": u.get("dam_id"), "status": u.get("status"),
        "iss": "damsafe-local", "iat": now, "exp": now + TOKEN_HOURS * 3600,
    }, SECRET, algorithm=ALGO)


def verify_local_token(token: str) -> CurrentUser | None:
    """Validate a locally-issued JWT → CurrentUser (None if not ours)."""
    try:
        payload = jwt.decode(token, SECRET, algorithms=[ALGO], issuer="damsafe-local")
    except JWTError:
        return None
    return CurrentUser(
        id=payload.get("sub", ""), sub=payload.get("sub", ""),
        name=payload.get("name", "Official"), role=payload.get("role", "official"),
        email=payload.get("email"), dam_id=payload.get("dam_id"),
        status=payload.get("status", "pending"),
    )


class LoginBody(BaseModel):
    email: str
    password: str


class ApproveBody(BaseModel):
    role: str = "official"


class PasswordBody(BaseModel):
    old_password: str
    new_password: str


@router.post("/register")
async def register(
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    phone: str = Form(""),
    designation: str = Form(...),
    dam_id: str = Form(...),
    document: UploadFile = File(...),
):
    """Official self-registration with posting dam + verification document."""
    _ensure_seed_admin()
    email = email.strip().lower()
    if "@" not in email or len(password) < 8:
        raise HTTPException(400, "Valid email and a password of 8+ characters are required")
    if not name.strip() or not designation.strip():
        raise HTTPException(400, "Name and posting/designation are required")
    if get_dam(dam_id) is None:
        raise HTTPException(400, f"Unknown dam '{dam_id}'")
    users = _load()
    if any(u.get("email") == email for u in users):
        raise HTTPException(409, "An account with this email already exists")
    ext = Path(document.filename or "").suffix.lower()
    if ext not in ALLOWED_DOCS:
        raise HTTPException(400, f"Document must be one of {sorted(ALLOWED_DOCS)}")
    blob = await document.read()
    if len(blob) > MAX_DOC_BYTES:
        raise HTTPException(400, "Document exceeds 10 MB")
    uid = uuid.uuid4().hex[:12]
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    safe = f"{uid}{ext}"
    (DOCS_DIR / safe).write_bytes(blob)
    user = {
        "id": uid, "name": name.strip(), "email": email,
        "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        "phone": phone.strip(), "designation": designation.strip(),
        "dam_id": dam_id, "document": safe,
        "role": "official", "status": "pending", "created_at": time.time(),
    }
    users.append(user)
    _save(users)
    return {"status": "pending", "message": "Registration received. An admin will verify your document.", "user": _public(user)}


@router.post("/login")
def login(body: LoginBody):
    _ensure_seed_admin()
    users = _load()
    u = next((x for x in users if x.get("email") == body.email.strip().lower()), None)
    if u is None or not bcrypt.checkpw(body.password.encode(), u["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    if u.get("status") != "approved":
        raise HTTPException(403, f"Account is {u.get('status', 'pending')} — awaiting admin verification")
    return {"access_token": _token(u), "token_type": "bearer", "user": _public(u)}


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)):
    return {"id": user.id, "name": user.name, "email": user.email,
            "role": user.role, "dam_id": user.dam_id, "status": user.status}


@router.post("/change-password")
def change_password(body: PasswordBody, user: CurrentUser = Depends(get_current_user)):
    if len(body.new_password) < 8:
        raise HTTPException(400, "New password must be 8+ characters")
    users = _load()
    u = next((x for x in users if x.get("id") == user.id), None)
    if u is None or not bcrypt.checkpw(body.old_password.encode(), u["password_hash"].encode()):
        raise HTTPException(401, "Current password incorrect")
    u["password_hash"] = bcrypt.hashpw(body.new_password.encode(), bcrypt.gensalt()).decode()
    _save(users)
    return {"status": "ok"}


@router.get("/users")
def list_users(_admin: CurrentUser = Depends(require_role("admin"))):
    return {"total": len(_load()), "users": [_public(u) for u in _load()]}


@router.post("/users/{uid}/approve")
def approve_user(uid: str, body: ApproveBody, _admin: CurrentUser = Depends(require_role("admin"))):
    users = _load()
    u = next((x for x in users if x.get("id") == uid), None)
    if u is None:
        raise HTTPException(404, "Unknown user")
    if body.role not in ("official", "analyst", "approver", "admin", "viewer"):
        raise HTTPException(400, "Invalid role")
    u["status"] = "approved"
    u["role"] = body.role
    _save(users)
    return {"status": "approved", "user": _public(u)}


@router.post("/users/{uid}/reject")
def reject_user(uid: str, _admin: CurrentUser = Depends(require_role("admin"))):
    users = _load()
    u = next((x for x in users if x.get("id") == uid), None)
    if u is None:
        raise HTTPException(404, "Unknown user")
    u["status"] = "rejected"
    _save(users)
    return {"status": "rejected", "user": _public(u)}


@router.get("/documents/{filename}")
def get_document(filename: str, user: CurrentUser = Depends(get_current_user)):
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "Invalid filename")
    if user.role != "admin":
        mine = next((x for x in _load() if x.get("id") == user.id), None)
        if not mine or mine.get("document") != filename:
            raise HTTPException(403, "Not your document")
    path = DOCS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Document not found")
    return FileResponse(path)


@router.get("/sims")
def list_sims(_admin: CurrentUser = Depends(require_role("admin"))):
    """Every LISFLOOD-FP job on this host (dam access + simulation review)."""
    sims_root = Path(__file__).resolve().parent.parent.parent / "sims"
    out = []
    if sims_root.exists():
        for jobdir in sorted(sims_root.iterdir(), reverse=True):
            if not jobdir.is_dir():
                continue
            try:
                status = json.loads((jobdir / "status.json").read_text(encoding="utf-8")) if (jobdir / "status.json").exists() else {}
            except Exception:
                status = {}
            dam_id = status.get("dam_id", "?")
            dam_name = dam_id
            try:
                from app.sandbox.dam_registry import get_dam

                rec = get_dam(dam_id)
                if rec:
                    dam_name = rec.get("name", dam_id)
            except Exception:
                pass
            out.append({
                "job_id": jobdir.name,
                "dam_id": dam_id,
                "dam_name": dam_name,
                "status": status.get("status", "unknown"),
                "stats": status.get("stats"),
                "elapsed_s": status.get("elapsed_s"),
                "error": status.get("error"),
            })
    return {"total": len(out), "sims": out}


def require_dam_scope(dam_id: str):
    """Dependency factory: officials may only RUN simulations on their own dam."""
    async def _check(user: CurrentUser = Depends(get_current_user)):
        if user.role == "admin" or not getattr(user, "dam_id", None):
            return user
        if user.dam_id != dam_id:
            raise HTTPException(
                status_code=403,
                detail=f"Your posting is {user.dam_id}; simulations are limited to your dam. "
                       f"Use the AI assistant to ask about {dam_id}.",
            )
        return user
    return _check

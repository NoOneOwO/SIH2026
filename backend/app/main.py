"""
DamSafe Twin — FastAPI Application Entry Point

Modular monolith: single entrypoint with internally separated router modules.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import engine
from app.api.v1.router import api_router
from app.audit.middleware import AuditMiddleware

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    # Startup: ensure S3 bucket exists
    from app.s3_client import ensure_bucket
    try:
        ensure_bucket()
    except Exception as e:
        print(f"Warning: Could not ensure S3 bucket: {e}")

    # Startup: create DB tables + seed demo data when a database is
    # configured and reachable. The container deploy never ran init_db, so
    # a fresh database meant every DB-backed endpoint 500'd silently.
    # Skipped automatically (with a warning) when no DB is reachable.
    try:
        from init_db import create_tables, seed_data
        await create_tables()
        await seed_data()
    except Exception as e:
        print(f"Warning: database init skipped ({e})")

    # Ephemeral hosts (Render free tier wipes the disk on every deploy) boot
    # with empty run-ledger / alert stores, which makes the live demo look
    # broken. Re-apply the embedded snapshot of REAL session records — only
    # into empty stores, so anything created live is never overwritten.
    try:
        from app.demo_seed import seed_demo_stores
        print(f"Demo store seed: {seed_demo_stores()}")
    except Exception as e:
        print(f"Warning: demo store seed skipped ({e})")

    yield

    # Shutdown
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description=(
        "DamSafe Twin — Operational Emergency Action Plan and "
        "real-time decision-support platform for dam-break preparedness."
    ),
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# CORS
# CORS — local dev origins plus any deployed frontend(s) via CORS_ORIGINS
# (comma-separated, e.g. "https://damsafe.vercel.app").
_cors_extra = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", *_cors_extra],
    # Vercel issues a distinct subdomain per deployment (project-git-branch-
    # team.vercel.app previews included), which exact-match CORS keeps missing.
    # Accept any https *.vercel.app origin — demo-phase convenience; tighten
    # to exact origins before real-world handling.
    allow_origin_regex=r"^https://[a-z0-9-]+\.vercel\.app$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Audit middleware (writes every mutating call to audit_log)
app.add_middleware(AuditMiddleware)

# Mount all API routes under /api/v1
app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health_check():
    return {"status": "healthy", "version": settings.APP_VERSION, "environment": settings.ENVIRONMENT}


@app.get("/")
async def root():
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "docs": "/api/docs",
        "health": "/health",
    }

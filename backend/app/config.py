"""
DamSafe Twin — Application Configuration

All configuration is loaded from environment variables with sensible defaults for local development.
"""

from functools import lru_cache

try:
    from dotenv import load_dotenv

    load_dotenv()  # backend/.env (gitignored) for local secrets like GROQ_API_KEY
except ImportError:
    pass

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # App
    APP_NAME: str = "DamSafe Twin"
    APP_VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"  # development | staging | production
    CORS_ORIGINS: str = ""  # comma-separated extra frontend origins (e.g. Vercel URL)
    DEBUG: bool = True

    # Database
    DATABASE_URL: str = "postgresql://damsafe:changeme@localhost:5432/damsafe"
    DATABASE_ECHO: bool = False

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # S3 / MinIO
    S3_ENDPOINT: str = "http://localhost:9000"
    S3_ACCESS_KEY: str = "minioadmin"
    S3_SECRET_KEY: str = "minioadmin"
    S3_BUCKET: str = "damsafe"
    S3_REGION: str = "us-east-1"

    # OIDC / Keycloak
    OIDC_ISSUER: str = "http://localhost:8080/realms/damsafe"
    OIDC_CLIENT_ID: str = "damsafe-api"
    OIDC_CLIENT_SECRET: str = ""
    OIDC_JWKS_URL: str = ""  # auto-derived from issuer if empty

    # Solver
    SOLVER_TIMEOUT_SECONDS: int = 3600  # 1 hour max per job
    SOLVER_MAX_CONCURRENCY: int = 2

    # Simulation sandbox (env-overridable; no secrets here)
    SANDBOX_TERRAIN_DIR: str = ""  # default: repo 3d-assets/terrain-pipeline/output
    SANDBOX_GRID_DEFAULT: int = 96

    # Hazard thresholds (configurable policy parameters)
    HAZARD_GREEN_MAX: float = 0.3
    HAZARD_YELLOW_MAX: float = 1.0
    HAZARD_ORANGE_MAX: float = 2.5
    ROAD_RESTRICTED_DEPTH_M: float = 0.3
    ROAD_IMPASSABLE_DEPTH_M: float = 0.6
    ROAD_IMPASSABLE_VELOCITY_MS: float = 1.5

    # Mass balance tolerance (percent; single source of truth)
    MASS_BALANCE_TOLERANCE_PCT: float = 1.0

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # third-party keys (GROQ_API_KEY, CDSE_*, …) must not break Settings

    @property
    def async_database_url(self) -> str:
        return self.DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://")

    @property
    def sync_database_url(self) -> str:
        return self.DATABASE_URL.replace("postgresql://", "postgresql+psycopg2://")


@lru_cache()
def get_settings() -> Settings:
    return Settings()

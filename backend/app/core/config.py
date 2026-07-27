from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings, populated from environment variables or backend/.env."""

    app_name: str = "StillWithYou API"
    environment: str = "development"

    # Held as a plain string because pydantic-settings JSON-decodes list-typed
    # fields before validation runs, which makes a comma-separated .env value
    # fail to parse. Read the parsed list via the `cors_origins` property.
    cors_origins_raw: str = Field(
        default="http://localhost:5173",
        validation_alias="CORS_ORIGINS",
    )

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/stillwithyou"

    gemini_api_key: str | None = None
    # gemini-2.0-flash / 2.0-flash-lite / 2.5-pro all report quota "limit: 0" on
    # the current key; gemini-3.5-flash-lite is the fastest model that answers.
    gemini_model: str = "gemini-3.5-flash-lite"
    # The SLO in docs/phase2-slo.md budgets 2s end-to-end for an analysis result;
    # 3s is the hard ceiling past which a call counts as a timeout failure.
    gemini_timeout_seconds: float = 3.0

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        """Browser origins allowed to call the API."""
        return [origin.strip() for origin in self.cors_origins_raw.split(",") if origin.strip()]


settings = Settings()

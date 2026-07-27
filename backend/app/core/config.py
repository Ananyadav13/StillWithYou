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
    redis_url: str = "redis://localhost:6379/0"

    gemini_api_key: str | None = None
    # Comma-separated pool. Same string-then-split treatment as CORS_ORIGINS, and
    # for the same pydantic-settings reason. Read via the `gemini_api_keys` property.
    gemini_api_keys_raw: str = Field(default="", validation_alias="GEMINI_API_KEYS")
    # gemini-2.0-flash / 2.0-flash-lite / 2.5-pro all report quota "limit: 0" on
    # the current key; gemini-3.5-flash-lite is the fastest model that answers.
    gemini_model: str = "gemini-3.5-flash-lite"
    # The SLO in docs/phase2-slo.md budgets 2s end-to-end for an analysis result;
    # 3s is the hard ceiling past which a call counts as a timeout failure.
    gemini_timeout_seconds: float = 3.0

    # Gemini primary path blocked as of 2026-07-27, see docs/progress.md —
    # multilingual_local serving as primary until resolved.
    #
    # This is the config flip. Gemini remains fully wired as the nominal primary
    # behind the circuit breaker; setting GEMINI_ENABLED=true restores it as the
    # first-choice analyzer with no code change. It is off because all three keys
    # are unusable at project level (two hang past 25s, one returns 403
    # PERMISSION_DENIED), so every call would burn the 3s timeout before falling
    # through to the analyzer that was always going to answer.
    gemini_enabled: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def gemini_api_keys(self) -> list[str]:
        """Every configured key, de-duplicated, order preserved.

        Falls back to the single GEMINI_API_KEY when no pool is configured, so a
        one-key setup needs no extra configuration.
        """
        keys = [k.strip() for k in self.gemini_api_keys_raw.split(",") if k.strip()]
        if self.gemini_api_key and self.gemini_api_key not in keys:
            keys.insert(0, self.gemini_api_key)
        return list(dict.fromkeys(keys))

    @property
    def cors_origins(self) -> list[str]:
        """Browser origins allowed to call the API."""
        return [origin.strip() for origin in self.cors_origins_raw.split(",") if origin.strip()]


settings = Settings()

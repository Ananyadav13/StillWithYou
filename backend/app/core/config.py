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

    gemini_api_key: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        """Browser origins allowed to call the API."""
        return [origin.strip() for origin in self.cors_origins_raw.split(",") if origin.strip()]


settings = Settings()

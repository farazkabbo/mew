"""Typed, validated service configuration (environment variables and the repo-root .env.local)."""

from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, SecretStr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# backend/src/mew_api/config.py -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]

CsvTuple = Annotated[tuple[str, ...], NoDecode]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(_REPO_ROOT / ".env.local", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    app_env: Literal["development", "test", "production"] = "development"
    internal_api_secret: SecretStr = Field(min_length=32)
    # Clerk Frontend API URL, e.g. https://your-app.clerk.accounts.dev (the expected `iss` claim).
    clerk_issuer: str | None = None
    # Origins allowed in the token's `azp` claim, e.g. http://localhost:3000.
    clerk_authorized_parties: CsvTuple = ()
    allowed_hosts: CsvTuple = ("localhost", "127.0.0.1")
    # Set by Render to the service's onrender.com host (also used by its health checks).
    render_external_hostname: str | None = None

    # Gemini (course ingestion, lessons). Without a key, ingestion still works with local
    # fallbacks (heading-based concepts, lexical embeddings).
    gemini_api_key: SecretStr | None = None
    gemini_tutor_model: str = "gemini-3.8-flash"
    gemini_gate_model: str = "gemini-3.5-flash-lite"
    gemini_embed_model: str = "gemini-embedding-2"
    # Concept extraction and lessons; defaults to the tutor model.
    gemini_course_model: str | None = None

    # Supabase (courses). The URL and publishable key are public; the secret key bypasses RLS and
    # is used only by ingestion jobs, for a course whose owner was verified first.
    supabase_url: str | None = Field(default=None, validation_alias="NEXT_PUBLIC_SUPABASE_URL")
    supabase_publishable_key: str | None = Field(
        default=None, validation_alias="NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    )
    supabase_secret_key: SecretStr | None = None

    # Notebook PDFs (K4, §5.2): the largest file and the most pages an import may have.
    pdf_max_mb: int = Field(default=100, ge=1, le=100)
    pdf_max_pages: int = Field(default=400, ge=1, le=1000)

    @property
    def pdf_max_bytes(self) -> int:
        return self.pdf_max_mb * 1024 * 1024

    @field_validator("gemini_api_key", "supabase_secret_key", mode="before")
    @classmethod
    def _blank_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator(
        "gemini_tutor_model",
        "gemini_gate_model",
        "gemini_embed_model",
        "gemini_course_model",
        mode="before",
    )
    @classmethod
    def _blank_model_is_default(cls, value: object, info: ValidationInfo) -> object:
        if value == "" or value is None:
            field = cls.model_fields[info.field_name or ""]
            return field.default
        return value

    @property
    def course_model(self) -> str:
        return self.gemini_course_model or self.gemini_tutor_model

    @field_validator("clerk_authorized_parties", "allowed_hosts", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(part.strip() for part in value.split(",") if part.strip())
        return value

    @field_validator("clerk_issuer")
    @classmethod
    def _normalize_issuer(cls, value: str | None) -> str | None:
        if not value:
            return None
        if not value.startswith(("https://", "http://")):
            raise ValueError("must be an absolute URL")
        return value.rstrip("/")

    @model_validator(mode="after")
    def _production_requirements(self) -> Self:
        if self.app_env != "production":
            return self
        if not self.clerk_issuer or not self.clerk_issuer.startswith("https://"):
            raise ValueError("CLERK_ISSUER must be an https URL in production")
        if not self.clerk_authorized_parties:
            raise ValueError("CLERK_AUTHORIZED_PARTIES is required in production")
        if "*" in self.allowed_hosts:
            raise ValueError("ALLOWED_HOSTS must not contain a wildcard in production")
        return self

    @property
    def is_development(self) -> bool:
        return self.app_env == "development"

    @property
    def trusted_hosts(self) -> tuple[str, ...]:
        if self.render_external_hostname:
            return (*self.allowed_hosts, self.render_external_hostname)
        return self.allowed_hosts

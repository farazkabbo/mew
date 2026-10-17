import pytest
from pydantic import ValidationError

from mew_api.config import Settings

SECRET = "y" * 32


def test_csv_lists_and_issuer_are_normalized() -> None:
    settings = Settings(
        _env_file=None,
        internal_api_secret=SECRET,
        clerk_issuer="https://x.clerk.accounts.dev/",
        clerk_authorized_parties="http://localhost:3000, https://mew.app",
    )

    assert settings.clerk_issuer == "https://x.clerk.accounts.dev"
    assert settings.clerk_authorized_parties == ("http://localhost:3000", "https://mew.app")


def test_short_internal_secret_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, internal_api_secret="short")


def test_render_hostname_is_trusted_when_present() -> None:
    settings = Settings(
        _env_file=None,
        internal_api_secret=SECRET,
        allowed_hosts=("localhost",),
        render_external_hostname="mew-api.onrender.com",
    )

    assert settings.trusted_hosts == ("localhost", "mew-api.onrender.com")


def test_secret_is_not_exposed_in_repr() -> None:
    settings = Settings(_env_file=None, internal_api_secret=SECRET)

    assert SECRET not in repr(settings)


@pytest.mark.parametrize(
    "overrides",
    [
        {"clerk_issuer": None, "clerk_authorized_parties": ("https://mew.app",)},
        {"clerk_issuer": "http://x.clerk.accounts.dev", "clerk_authorized_parties": ("https://a",)},
        {"clerk_issuer": "https://x.clerk.accounts.dev", "clerk_authorized_parties": ()},
        {
            "clerk_issuer": "https://x.clerk.accounts.dev",
            "clerk_authorized_parties": ("https://a",),
            "allowed_hosts": ("*",),
        },
    ],
    ids=["no-issuer", "http-issuer", "no-parties", "wildcard-host"],
)
def test_production_refuses_unsafe_config(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate(
            {"app_env": "production", "internal_api_secret": SECRET, **overrides}
        )

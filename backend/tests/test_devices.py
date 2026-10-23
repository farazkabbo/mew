import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.devices.store import (
    ActiveDevice,
    SupabaseDeviceRegistry,
    SupabaseOwnerDevices,
)
from mew_api.devices.tokens import (
    LINK_CODE_TTL_S,
    MAX_PENDING_CODES_PER_USER,
    TOKEN_PATTERN,
    LinkCodes,
    LinkGrant,
    challenge_for,
    hash_token,
    new_device_token,
    verifier_matches,
)
from mew_api.main import create_app

from .conftest import INTERNAL_SECRET, internal_headers

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}
# RFC 7636 appendix B: the reference verifier and its S256 challenge.
RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
GRANT = LinkGrant(user_id="user_1", local=False)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


# ─── Tokens and link codes ───────────────────────────────────────────────────────────────────


def test_challenge_follows_rfc_7636() -> None:
    assert challenge_for(RFC_VERIFIER) == RFC_CHALLENGE
    assert verifier_matches(RFC_VERIFIER, RFC_CHALLENGE)
    assert not verifier_matches(RFC_VERIFIER[:-1] + "A", RFC_CHALLENGE)


def test_tokens_are_random_prefixed_and_stored_as_hashes() -> None:
    first, second = new_device_token(), new_device_token()
    assert first != second
    assert TOKEN_PATTERN.match(first)
    assert len(hash_token(first)) == 64 and hash_token(first) == hash_token(first)
    assert first not in hash_token(first)


def test_a_link_code_works_once_with_the_right_verifier() -> None:
    codes = LinkCodes()
    code = codes.issue(GRANT, RFC_CHALLENGE)
    assert codes.redeem(code, RFC_VERIFIER) == GRANT
    assert codes.redeem(code, RFC_VERIFIER) is None, "single use"


def test_a_wrong_verifier_burns_the_code() -> None:
    codes = LinkCodes()
    code = codes.issue(GRANT, RFC_CHALLENGE)
    assert codes.redeem(code, "x" * 43) is None
    assert codes.redeem(code, RFC_VERIFIER) is None, "no second guess"


def test_link_codes_expire_after_a_minute() -> None:
    clock = Clock()
    codes = LinkCodes(clock)
    code = codes.issue(GRANT, RFC_CHALLENGE)
    clock.now += LINK_CODE_TTL_S
    assert codes.redeem(code, RFC_VERIFIER) is None


def test_a_user_holds_only_a_few_pending_codes() -> None:
    codes = LinkCodes()
    issued = [codes.issue(GRANT, RFC_CHALLENGE) for _ in range(MAX_PENDING_CODES_PER_USER + 3)]
    assert codes.redeem(issued[0], RFC_VERIFIER) is None, "oldest dropped"
    assert codes.redeem(issued[-1], RFC_VERIFIER) == GRANT


def test_last_used_is_refreshed_at_most_hourly() -> None:
    now = datetime.now(UTC)
    device = ActiveDevice(uuid.uuid4(), "user_1", ("screen",), now - timedelta(minutes=30))
    assert not device.needs_touch(now)
    assert device.needs_touch(now + timedelta(minutes=31))


# ─── The API, in local mode ──────────────────────────────────────────────────────────────────


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def link_device(client: TestClient) -> str:
    """The whole sign-in: the page gets a code for the challenge, the desktop app redeems it."""
    code = client.post(
        "/v1/devices/link-codes", json={"challenge": RFC_CHALLENGE}, headers=LOCAL
    ).json()["code"]
    response = client.post(
        "/v1/devices/exchange",
        json={"code": code, "verifier": RFC_VERIFIER, "deviceName": "  DESKTOP-1 (Windows)  "},
        headers=internal_headers(),
    )
    assert response.status_code == 200
    return str(response.json()["token"])


def verify(client: TestClient, token: str) -> httpx.Response:
    response: httpx.Response = client.post(
        "/v1/devices/verify", json={"token": token}, headers=internal_headers()
    )
    return response


def test_a_linked_device_acts_for_its_owner(client: TestClient) -> None:
    token = link_device(client)
    verified = verify(client, token)
    assert verified.status_code == 200
    assert verified.json()["userId"] == "local"
    assert verified.json()["scopes"] == ["screen"]

    devices = client.get("/v1/devices", headers=LOCAL).json()["devices"]
    assert [d["deviceName"] for d in devices] == ["DESKTOP-1 (Windows)"]
    assert devices[0]["lastUsedAt"] is not None, "noted on first use"
    # Never the token or its hash.
    assert set(devices[0]) == {"id", "deviceName", "createdAt", "lastUsedAt", "revokedAt"}


def test_revoking_takes_effect_at_once(client: TestClient) -> None:
    token = link_device(client)
    device_id = client.get("/v1/devices", headers=LOCAL).json()["devices"][0]["id"]
    assert client.post(f"/v1/devices/{device_id}/revoke", headers=LOCAL).status_code == 204
    assert verify(client, token).status_code == 401
    assert client.post(f"/v1/devices/{device_id}/revoke", headers=LOCAL).status_code == 404


def test_a_device_can_sign_itself_out(client: TestClient) -> None:
    token = link_device(client)
    other = link_device(client)
    response = client.post(
        "/v1/devices/revoke-self", json={"token": token}, headers=internal_headers()
    )
    assert response.status_code == 204
    assert verify(client, token).status_code == 401
    assert verify(client, other).status_code == 200, "only that device"


def test_revoke_all_signs_out_every_device(client: TestClient) -> None:
    tokens = [link_device(client), link_device(client)]
    assert client.post("/v1/devices/revoke-all", headers=LOCAL).status_code == 204
    assert all(verify(client, token).status_code == 401 for token in tokens)


def test_codes_need_the_verifier_and_work_once(client: TestClient) -> None:
    code = client.post(
        "/v1/devices/link-codes", json={"challenge": RFC_CHALLENGE}, headers=LOCAL
    ).json()["code"]
    body = {"code": code, "verifier": "y" * 43, "deviceName": "Laptop"}
    exchange = client.post("/v1/devices/exchange", json=body, headers=internal_headers())
    assert exchange.status_code == 400
    body["verifier"] = RFC_VERIFIER
    exchange = client.post("/v1/devices/exchange", json=body, headers=internal_headers())
    assert exchange.status_code == 400, "burnt by the wrong verifier"


def test_unknown_and_malformed_tokens_are_refused(client: TestClient) -> None:
    assert verify(client, new_device_token()).status_code == 401
    assert verify(client, "not-a-token").status_code == 422


@pytest.mark.parametrize(
    "path",
    ["/v1/devices/exchange", "/v1/devices/verify", "/v1/devices/revoke-self"],
)
def test_every_route_needs_the_internal_secret(client: TestClient, path: str) -> None:
    assert client.post(path, json={}).status_code == 401


def test_a_link_code_needs_a_user(client: TestClient) -> None:
    response = client.post(
        "/v1/devices/link-codes", json={"challenge": RFC_CHALLENGE}, headers=internal_headers()
    )
    assert response.status_code == 401


def test_without_supabase_signed_in_users_cant_link(client: TestClient) -> None:
    """A code issued to a real (non-local) user needs the database, which isn't configured."""
    codes: LinkCodes = client.app.state.link_codes  # type: ignore[attr-defined]
    code = codes.issue(GRANT, RFC_CHALLENGE)
    response = client.post(
        "/v1/devices/exchange",
        json={"code": code, "verifier": RFC_VERIFIER, "deviceName": "Laptop"},
        headers=internal_headers(),
    )
    assert response.status_code == 503


# ─── Supabase stores ─────────────────────────────────────────────────────────────────────────


def recording_client(
    responses: dict[str, httpx.Response],
) -> tuple[httpx.Client, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return responses.get(request.method, httpx.Response(200, json=[]))

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


def test_the_registry_creates_the_profile_then_stores_only_the_hash() -> None:
    device_id = uuid.uuid4()
    http, seen = recording_client({"POST": httpx.Response(201, json=[{"id": str(device_id)}])})
    registry = SupabaseDeviceRegistry(
        "https://proj.supabase.co", api_key="sb_secret_x", user_token=None, client=http
    )
    token = new_device_token()
    assert registry.add("user_1", hash_token(token), "Laptop") == device_id

    profile, insert = seen
    assert profile.url.path == "/rest/v1/profiles"
    assert "ignore-duplicates" in profile.headers["Prefer"]
    stored = json.loads(insert.content)
    assert stored == [
        {"user_id": "user_1", "token_hash": hash_token(token), "device_name": "Laptop"}
    ]
    assert token not in insert.content.decode()


def test_the_registry_only_finds_unrevoked_tokens() -> None:
    http, seen = recording_client({})
    registry = SupabaseDeviceRegistry(
        "https://proj.supabase.co", api_key="sb_secret_x", user_token=None, client=http
    )
    assert registry.find_active("a" * 64) is None
    assert seen[0].url.params["token_hash"] == f"eq.{'a' * 64}"
    assert seen[0].url.params["revoked_at"] == "is.null"


def test_owners_revoke_only_their_own_active_devices() -> None:
    http, seen = recording_client({"PATCH": httpx.Response(200, json=[])})
    owner = SupabaseOwnerDevices(
        "https://proj.supabase.co", api_key="sb_publishable_x", user_token="jwt", client=http
    )
    device_id = uuid.uuid4()
    assert owner.revoke("user_1", device_id) is False
    params = seen[0].url.params
    assert params["user_id"] == "eq.user_1"
    assert params["id"] == f"eq.{device_id}"
    assert params["revoked_at"] == "is.null"
    assert set(json.loads(seen[0].content)) == {"revoked_at"}

"""Handoff's storage and rules (docs/HANDOFF_FEATURE.md §14): membership, revoke, expiry, purge,
the inbox, and that only ciphertext is ever stored."""

from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient

from mew_api.auth import Principal
from mew_api.config import Settings
from mew_api.handoffs.store import MemoryHandoffStore
from mew_api.main import create_app

from .conftest import INTERNAL_SECRET, internal_headers
from .test_devices import link_device

CIPHERTEXT = b"NEBH1" + bytes(range(256)) * 4


class Tokens:
    """Clerk tokens for two people: Bob (invited) and Eve (not)."""

    users: ClassVar[dict[str, str]] = {
        "tok-bob": "user_bob",
        "tok-eve": "user_eve",
        "tok-local": "local",
    }

    def verify(self, token: str) -> Principal:
        if token not in self.users:
            raise PermissionError("bad token")
        return Principal(user_id=self.users[token], session_id=None)


@pytest.fixture
def app() -> Any:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    app = create_app(settings, Tokens(), warm_checker=False)
    app.state.handoff_store_override = MemoryHandoffStore()
    return app


@pytest.fixture
def client(app: Any) -> TestClient:
    return TestClient(app)


def as_user(token: str, email: str | None = None) -> dict[str, str]:
    headers = internal_headers(token)
    if email:
        headers["X-Mew-User-Email"] = email
    return headers


def device(token: str) -> dict[str, str]:
    return {**internal_headers(), "X-Mew-Device-Token": token}


def send(client: TestClient, days: int = 7, to: str = "Bob@Example.com") -> tuple[str, str]:
    token = link_device(client)
    created = client.post(
        "/v1/handoffs",
        json={
            "title": "Fix duplicate waitlist emails",
            "senderName": "Faraz Kabir",
            "recipients": [{"email": to}],
            "expiresInDays": days,
            "sizeBytes": len(CIPHERTEXT),
            "wrappedKey": "w" * 60,
        },
        headers=device(token),
    )
    assert created.status_code == 201, created.text
    hid = created.json()["id"]
    assert (
        client.put(f"/v1/handoffs/{hid}/package", content=CIPHERTEXT, headers=device(token))
    ).status_code == 204
    assert client.post(f"/v1/handoffs/{hid}/finalize", headers=device(token)).status_code == 204
    return hid, token


def test_the_invited_recipient_opens_it_and_others_cant(client: TestClient) -> None:
    hid, _ = send(client)
    bob = as_user("tok-bob", "bob@example.com")
    view = client.get(f"/v1/handoffs/{hid}", headers=bob)
    assert view.status_code == 200
    body = view.json()
    assert body["role"] == "recipient" and body["wrappedKey"] == "w" * 60
    assert "members" not in body or body["members"] is None
    assert client.get(f"/v1/handoffs/{hid}/package", headers=bob).content == CIPHERTEXT
    # Bound by id now: the email isn't needed again.
    assert client.get(f"/v1/handoffs/{hid}", headers=as_user("tok-bob")).status_code == 200
    # Eve isn't a member, even with Bob's address claimed without verification by Clerk.
    eve = as_user("tok-eve", "eve@example.com")
    assert client.get(f"/v1/handoffs/{hid}", headers=eve).status_code == 403
    assert client.get(f"/v1/handoffs/{hid}/package", headers=eve).status_code == 403
    # Signed out: only the sender's first name.
    teaser = client.get(f"/v1/handoffs/{hid}/teaser", headers=internal_headers())
    assert teaser.json() == {"senderFirstName": "Faraz"}
    assert client.get(f"/v1/handoffs/{hid}", headers=internal_headers()).status_code == 401


def test_the_sender_sees_who_opened_it(client: TestClient) -> None:
    hid, _ = send(client)
    bob = as_user("tok-bob", "bob@example.com")
    client.get(f"/v1/handoffs/{hid}", headers=bob)
    assert (
        client.post(f"/v1/handoffs/{hid}/events", json={"type": "opened"}, headers=bob).status_code
        == 204
    )
    mine = client.get(f"/v1/handoffs/{hid}", headers=as_user("tok-local")).json()
    assert mine["role"] == "sender"
    assert mine["members"][0]["email"] == "bob@example.com"
    assert mine["members"][0]["openedAt"] is not None
    assert [e["type"] for e in mine["events"]] == ["created", "opened"]
    # Events hold no content: a type and a time only.
    assert set(mine["events"][0]) == {"type", "at"}
    # A member can't invent the service's own events.
    assert (
        client.post(f"/v1/handoffs/{hid}/events", json={"type": "created"}, headers=bob).status_code
        == 422
    )


def test_revoke_is_410_on_the_next_request_and_the_package_is_gone(
    app: Any, client: TestClient
) -> None:
    hid, token = send(client)
    bob = as_user("tok-bob", "bob@example.com")
    assert client.get(f"/v1/handoffs/{hid}", headers=bob).status_code == 200
    assert client.post(f"/v1/handoffs/{hid}/revoke", headers=bob).status_code == 403
    assert (
        client.post(f"/v1/handoffs/{hid}/device/revoke", headers=device(token)).status_code == 204
    )
    assert client.get(f"/v1/handoffs/{hid}", headers=bob).status_code == 410
    assert client.get(f"/v1/handoffs/{hid}/package", headers=bob).status_code == 410
    store: MemoryHandoffStore = app.state.handoff_store_override
    assert store.objects == {}
    assert store.rows[next(iter(store.rows))]["wrapped_key"] is None
    # The purge then removes the rest.
    assert client.post("/v1/handoffs/maintenance/purge", headers=internal_headers()).json() == {
        "count": 1
    }
    assert store.rows == {}


def test_expired_is_410_and_purged(app: Any, client: TestClient) -> None:
    hid, _ = send(client, days=1)
    store: MemoryHandoffStore = app.state.handoff_store_override
    row = next(iter(store.rows.values()))
    row["expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    assert (
        client.get(f"/v1/handoffs/{hid}", headers=as_user("tok-bob", "bob@example.com")).status_code
        == 410
    )
    assert client.post("/v1/handoffs/maintenance/purge", headers=internal_headers()).json() == {
        "count": 1
    }
    assert store.objects == {} and store.rows == {}


def test_a_draft_is_invisible_and_uploads_are_checked(client: TestClient) -> None:
    token = link_device(client)
    created = client.post(
        "/v1/handoffs",
        json={
            "title": "x",
            "senderName": "F",
            "recipients": [{"email": "bob@example.com"}],
            "expiresInDays": 7,
            "sizeBytes": 10,
            "wrappedKey": "w" * 60,
        },
        headers=device(token),
    ).json()
    hid = created["id"]
    bob = as_user("tok-bob", "bob@example.com")
    assert client.get(f"/v1/handoffs/{hid}", headers=bob).status_code == 403
    too_big = client.put(f"/v1/handoffs/{hid}/package", content=b"x" * 11, headers=device(token))
    assert too_big.status_code == 413
    assert client.post(f"/v1/handoffs/{hid}/finalize", headers=device(token)).status_code == 409


@pytest.mark.parametrize(
    "change",
    [
        {"expiresInDays": 3},
        {"recipients": []},
        {"recipients": [{"email": "not an email"}]},
        {"sizeBytes": 26 * 1024 * 1024},
        {"extra": "field"},
    ],
)
def test_bad_drafts_are_refused(client: TestClient, change: dict[str, Any]) -> None:
    token = link_device(client)
    body = {
        "title": "x",
        "senderName": "F",
        "recipients": [{"email": "bob@example.com"}],
        "expiresInDays": 7,
        "sizeBytes": 10,
        "wrappedKey": "w" * 60,
        **change,
    }
    assert client.post("/v1/handoffs", json=body, headers=device(token)).status_code == 422


def test_inbox_replies_and_history(client: TestClient) -> None:
    hid, _ = send(client)
    bob = as_user("tok-bob", "bob@example.com")
    assert client.get("/v1/handoffs", headers=bob).json()["items"][0]["status"] == "unopened"
    client.post(f"/v1/handoffs/{hid}/events", json={"type": "opened"}, headers=bob)
    assert client.get("/v1/handoffs", headers=bob).json()["items"][0]["status"] == "opened"
    replied = client.post(
        f"/v1/handoffs/{hid}/replies",
        json={"authorName": "Bob", "body": "Why not delete?"},
        headers=bob,
    )
    assert replied.status_code == 201
    sender = as_user("tok-local")
    sent = client.get("/v1/handoffs", headers=sender).json()["items"][0]
    assert sent["role"] == "sender" and sent["status"] == "replied"
    assert sent["recipients"] == ["bob@example.com"]
    thread = client.get(f"/v1/handoffs/{hid}", headers=sender).json()["replies"]
    assert thread[0]["body"] == "Why not delete?" and thread[0]["mine"] is False
    assert client.get("/v1/handoffs/people/recent", headers=sender).json() == {
        "emails": ["bob@example.com"]
    }
    # Delete my history: everything sent goes.
    assert client.delete("/v1/handoffs", headers=sender).status_code == 204
    assert client.get("/v1/handoffs", headers=sender).json()["items"] == []
    assert client.get(f"/v1/handoffs/{hid}", headers=bob).status_code == 404


def test_logs_hold_no_content(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("INFO")
    hid, _ = send(client)
    bob = as_user("tok-bob", "bob@example.com")
    client.post(
        f"/v1/handoffs/{hid}/replies",
        json={"authorName": "Bob", "body": "secret plan"},
        headers=bob,
    )
    text = caplog.text.lower()
    for content in ("duplicate waitlist", "bob@example.com", "secret plan", "faraz"):
        assert content not in text

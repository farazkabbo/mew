import base64
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.clips.models import ClipCreate, jpeg_size
from mew_api.clips.store import MemoryClipStore, SupabaseClipReader, SupabaseClipWriter
from mew_api.config import Settings
from mew_api.main import create_app
from mew_api.supabase_rest import StoreError

from .conftest import INTERNAL_SECRET, internal_headers
from .test_devices import LOCAL, link_device


def tiny_jpeg(width: int, height: int) -> bytes:
    """A minimal JPEG header: start of image, an APP0 segment, a baseline frame."""
    header = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08]
    return bytes([*header, *height.to_bytes(2, "big"), *width.to_bytes(2, "big"), 1, 1, 0x11, 0])


def clip_body(**changes: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "image": {
            "jpeg": base64.b64encode(tiny_jpeg(1200, 600)).decode(),
            "width": 1200,
            "height": 600,
        },
        "pixelRatio": 1.5,
        "strokes": [
            {
                "tool": "pen",
                "color": "#8a7bf0",
                "width": 3,
                "points": [[10, 10, 0.5, 0], [20, 12, 0.5, 16]],
            }
        ],
        "source": {
            "app": "msedge.exe",
            "title": "Lecture 5 - YouTube",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754",
            "timestampSec": 754,
            "capturedAt": "2026-10-22T10:00:00Z",
        },
        "ocrText": "Question 3. A 2 kg block slides",
    }
    body.update(changes)
    return body


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def save(client: TestClient, token: str, body: dict[str, Any] | None = None) -> httpx.Response:
    response: httpx.Response = client.post(
        "/v1/clips",
        json=body or clip_body(),
        headers={**internal_headers(), "X-Mew-Device-Token": token},
    )
    return response


# ─── The whole flow, in local mode ──────────────────────────────────────────────────────────


def test_a_device_saves_a_clip_and_its_owner_reads_it_back(client: TestClient) -> None:
    token = link_device(client)
    created = save(client, token)
    assert created.status_code == 201
    clip_id = created.json()["clipId"]

    view = client.get(f"/v1/clips/{clip_id}", headers=LOCAL)
    assert view.status_code == 200
    clip = view.json()
    assert clip["width"] == 1200 and clip["pixelRatio"] == 1.5
    assert clip["strokes"][0]["points"][1] == [20, 12, 0.5, 16]
    assert clip["source"]["url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754"
    assert clip.get("notebookPageId") is None  # left out while there is none

    image = client.get(f"/v1/clips/{clip_id}/image", headers=LOCAL)
    assert image.headers["content-type"] == "image/jpeg"
    assert "no-store" in image.headers["cache-control"]
    assert image.content == tiny_jpeg(1200, 600)

    page = str(uuid.uuid4())
    noted = client.patch(f"/v1/clips/{clip_id}", json={"notebookPageId": page}, headers=LOCAL)
    assert noted.json()["notebookPageId"] == page

    assert client.delete(f"/v1/clips/{clip_id}", headers=LOCAL).status_code == 204
    assert client.get(f"/v1/clips/{clip_id}", headers=LOCAL).status_code == 404


@pytest.mark.parametrize(
    "token",
    [None, "mewdt_short", "eyJhbGciOi.x.y", f"mewdt_{'A' * 43}"],
)
def test_refuses_saving_without_a_valid_device(client: TestClient, token: str | None) -> None:
    headers = internal_headers()
    if token:
        headers["X-Mew-Device-Token"] = token
    assert client.post("/v1/clips", json=clip_body(), headers=headers).status_code == 401


def test_a_revoked_device_can_no_longer_save(client: TestClient) -> None:
    token = link_device(client)
    client.post("/v1/devices/revoke-self", json={"token": token}, headers=internal_headers())
    assert save(client, token).status_code == 401


def test_needs_the_internal_secret(client: TestClient) -> None:
    token = link_device(client)
    response = client.post("/v1/clips", json=clip_body(), headers={"X-Mew-Device-Token": token})
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("change", "status"),
    [
        (
            {"image": {"jpeg": base64.b64encode(b"\x89PNG....").decode(), "width": 1, "height": 1}},
            400,
        ),
        (
            {
                "image": {
                    "jpeg": base64.b64encode(tiny_jpeg(1200, 600)).decode(),
                    "width": 1201,
                    "height": 600,
                }
            },
            400,
        ),
        ({"image": {"jpeg": "not base64!", "width": 1, "height": 1}}, 400),
        ({"image": {"jpeg": "AAAA", "width": 2401, "height": 600}}, 422),
        ({"source": {"app": "C:\\x\\msedge.exe", "capturedAt": "2026-10-22T10:00:00Z"}}, 422),
        (
            {
                "source": {
                    "app": "msedge.exe",
                    "url": "https://example.com/?session=abc",
                    "capturedAt": "2026-10-22T10:00:00Z",
                }
            },
            422,
        ),
        (
            {
                "source": {
                    "app": "msedge.exe",
                    "url": "http://example.com/",
                    "capturedAt": "2026-10-22T10:00:00Z",
                }
            },
            422,
        ),
        (
            {
                "source": {
                    "app": "msedge.exe",
                    "title": "a\u0007b",
                    "capturedAt": "2026-10-22T10:00:00Z",
                }
            },
            422,
        ),
        ({"ocrText": "x" * 8001}, 422),
        (
            {"strokes": [{"tool": "pen", "color": "red", "width": 3, "points": [[1, 1, 0.5, 0]]}]},
            422,
        ),
        (
            {
                "strokes": [
                    {"tool": "pen", "color": "#8a7bf0", "width": 3, "points": [[1, 1, 2, 0]]}
                ]
            },
            422,
        ),
        (
            {
                "strokes": [
                    {
                        "tool": "pen",
                        "color": "#8a7bf0",
                        "width": 3,
                        "points": [[1, 1, 0.5, 0]] * 2000,
                    }
                ]
                * 16
            },
            422,
        ),
        ({"extra": "field"}, 422),
    ],
)
def test_refuses_bad_clips(client: TestClient, change: dict[str, Any], status: int) -> None:
    token = link_device(client)
    assert save(client, token, clip_body(**change)).status_code == status


def test_keeps_each_users_clips_apart() -> None:
    store = MemoryClipStore()
    clip_id = uuid.uuid4()
    store.create("user_a", clip_id, ClipCreate.model_validate(clip_body()), b"jpeg")
    assert store.get("user_b", clip_id) is None
    assert store.image("user_b", clip_id) is None
    assert not store.delete("user_b", clip_id)
    assert store.get("user_a", clip_id) is not None


def test_reads_jpeg_sizes() -> None:
    assert jpeg_size(tiny_jpeg(640, 480)) == (640, 480)
    assert jpeg_size(b"\x89PNG\r\n") is None
    assert jpeg_size(b"\xff\xd8\xff\xda\x00\x02") is None, "scan before any frame"


# ─── Supabase stores ─────────────────────────────────────────────────────────────────────────


def recording(handler_responses: list[httpx.Response]) -> tuple[httpx.Client, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    replies = iter(handler_responses)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return next(replies, httpx.Response(200, json=[]))

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


def test_uploads_the_image_into_the_users_folder_then_adds_the_row() -> None:
    http, seen = recording([httpx.Response(200, json={}), httpx.Response(201)])
    writer = SupabaseClipWriter(
        "https://p.supabase.co", api_key="sb_secret_x", user_token=None, client=http
    )
    clip_id = uuid.uuid4()
    writer.create("user_1", clip_id, ClipCreate.model_validate(clip_body()), b"jpeg-bytes")

    upload, insert = seen
    assert upload.url.path == f"/storage/v1/object/clips/user_1/{clip_id}.jpg"
    assert upload.headers["content-type"] == "image/jpeg"
    assert upload.headers["x-upsert"] == "false"
    row = json.loads(insert.content)[0]
    assert row["user_id"] == "user_1"
    assert row["storage_path"] == f"user_1/{clip_id}.jpg"
    assert row["annotations"][0]["points"][0] == [10, 10, 0.5, 0]
    assert "jpeg" not in json.dumps(row)


def test_removes_the_upload_when_the_row_fails() -> None:
    http, seen = recording(
        [httpx.Response(200, json={}), httpx.Response(500, text="boom"), httpx.Response(200)]
    )
    writer = SupabaseClipWriter(
        "https://p.supabase.co", api_key="sb_secret_x", user_token=None, client=http
    )
    clip_id = uuid.uuid4()
    with pytest.raises(StoreError):
        writer.create("user_1", clip_id, ClipCreate.model_validate(clip_body()), b"x")
    cleanup = seen[-1]
    assert cleanup.method == "DELETE"
    assert json.loads(cleanup.content) == {"prefixes": [f"user_1/{clip_id}.jpg"]}


def test_only_the_service_creates_clips() -> None:
    http, _ = recording([])
    writer = SupabaseClipWriter(
        "https://p.supabase.co", api_key="pk", user_token="jwt", client=http
    )
    with pytest.raises(PermissionError):
        writer.create("user_1", uuid.uuid4(), ClipCreate.model_validate(clip_body()), b"x")


def test_reads_the_image_with_the_owners_token() -> None:
    clip_id = uuid.uuid4()
    row = {
        "id": str(clip_id),
        "storage_path": f"user_1/{clip_id}.jpg",
        "width": 1200,
        "height": 600,
        "pixel_ratio": 1.5,
        "annotations": [],
        "source_app": "msedge.exe",
        "captured_at": datetime(2026, 10, 22, tzinfo=UTC).isoformat(),
        "ocr_text": "",
        "created_at": datetime(2026, 10, 22, tzinfo=UTC).isoformat(),
    }
    http, seen = recording([httpx.Response(200, json=[row]), httpx.Response(200, content=b"img")])
    reader = SupabaseClipReader(
        "https://p.supabase.co", api_key="pk", user_token="jwt", client=http
    )
    assert reader.image("user_1", clip_id) == b"img"
    lookup, download = seen
    assert lookup.url.params["user_id"] == "eq.user_1"
    assert download.url.path == f"/storage/v1/object/authenticated/clips/user_1/{clip_id}.jpg"
    assert download.headers["authorization"] == "Bearer jwt"


# ─── Where it goes (K3) ──────────────────────────────────────────────────────────────────────

NODE = "0f1e2d3c-4b5a-4968-8776-655443322110"
OTHER = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"


def move(client: TestClient, token: str, clip_id: str, destination: dict[str, Any]) -> int:
    response: httpx.Response = client.post(
        "/v1/clips/destination",
        json={"clipId": clip_id, "destination": destination},
        headers={**internal_headers(), "X-Mew-Device-Token": token},
    )
    return response.status_code


def test_a_clip_keeps_where_the_student_said_and_can_move(client: TestClient) -> None:
    token = link_device(client)
    destination = {"nodeId": NODE, "page": {"kind": "from_screen"}}
    clip_id = save(client, token, clip_body(destination=destination)).json()["clipId"]
    assert client.get(f"/v1/clips/{clip_id}", headers=LOCAL).json()["destination"] == destination

    # "Change": it moves (one clip, a new place), with a chapter to make first.
    later = {"nodeId": OTHER, "page": {"kind": "number", "number": 3}, "create": {"title": "Ch 5"}}
    assert move(client, token, clip_id, later) == 204
    assert client.get(f"/v1/clips/{clip_id}", headers=LOCAL).json()["destination"] == later

    # Only the device's own clips, and only real places.
    assert move(client, token, str(uuid.uuid4()), destination) == 404
    for bad in [
        {"nodeId": "physics", "page": {"kind": "from_screen"}},
        {"nodeId": NODE, "page": {"kind": "number", "number": 0}},
        {"nodeId": NODE, "page": {"kind": "elsewhere"}},
        {"nodeId": NODE, "page": {"kind": "new"}, "create": {"title": ""}},
    ]:
        assert move(client, token, clip_id, bad) == 422, bad
        assert save(client, token, clip_body(destination=bad)).status_code == 422, bad
    assert move(client, "mewdt_" + "x" * 43, clip_id, destination) == 401


def test_a_clip_without_a_destination_or_title_reads_without_nulls(client: TestClient) -> None:
    token = link_device(client)
    body = clip_body()
    body["source"] = {"app": "notepad.exe", "capturedAt": "2026-10-22T10:00:00Z"}
    clip_id = save(client, token, body).json()["clipId"]
    clip = client.get(f"/v1/clips/{clip_id}", headers=LOCAL).json()
    # The web app's schemas take a missing field as absent and refuse a null one.
    text = json.dumps(clip)
    assert "null" not in text, text
    assert "destination" not in clip and "title" not in clip["source"]


def test_the_device_reads_its_owners_tree(client: TestClient) -> None:
    token = link_device(client)
    tree = {
        "nodes": [
            {
                "id": NODE,
                "parentId": None,
                "title": "Physics",
                "position": "a0",
                "childLabel": "Chapters",
                "icon": None,
                "color": None,
                "courseId": None,
                "deletedAt": None,
                "editedAt": 1,
            }
        ],
        "removed": [],
    }
    assert client.put("/v1/notebooks/tree", json=tree, headers=LOCAL).status_code == 200
    device = {**internal_headers(), "X-Mew-Device-Token": token}
    nodes = client.get("/v1/notebooks/device-tree", headers=device).json()["nodes"]
    assert [n["title"] for n in nodes] == ["Physics"]
    assert client.get("/v1/notebooks/device-tree", headers=internal_headers()).status_code == 401

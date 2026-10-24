import json
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.main import create_app
from mew_api.notes.checks import SupabaseCheckStore
from mew_api.notes.equivalence import compare_claim
from mew_api.notes.models import CheckCreate, FindingUpdate

from .conftest import INTERNAL_SECRET, internal_headers
from .test_check import InlinePool
from .test_devices import LOCAL, link_device

PAGE = "22222222-2222-4222-8222-222222222222"
NOTEBOOK = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, InlinePool(), warm_checker=False))


def synced_line(client: TestClient, text: str = "enzymes are used up") -> str:
    line_id = str(uuid4())
    body = {
        "notebook": {"id": NOTEBOOK, "title": "Biology", "courseId": None},
        "pageIndex": 0,
        "upsert": [
            {
                "id": line_id,
                "lineIndex": 0,
                "bbox": [0, 0, 200, 24],
                "source": "ink",
                "text": text,
                "latex": None,
                "confidence": 0.9,
                "contentHash": "0a1b2c3d",
            }
        ],
        "remove": [],
    }
    assert client.put(f"/v1/notes/pages/{PAGE}/lines", json=body, headers=LOCAL).status_code == 200
    return line_id


def finding(**changes: Any) -> dict[str, Any]:
    return {
        "type": "difference",
        "noteLineIds": [],
        "noteQuote": "used up",
        "screenSnippet": "not consumed by the reaction",
        "question": "What does the slide say happens to enzymes?",
        "explanation": "Consumed vs not consumed.",
        "conceptHint": "Enzymes",
        "confidence": 0.9,
        "sourceConflict": False,
        **changes,
    }


def check(*findings: dict[str, Any], links: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "scope": {"kind": "notebook", "notebookIds": [NOTEBOOK]},
        "sourceApp": "msedge.exe",
        "modelVersion": "notes-compare.v1 gemini-3.5-flash-lite",
        "latencyMs": 2400,
        "findings": list(findings),
        "links": links or [],
    }


def stored(client: TestClient) -> list[dict[str, Any]]:
    app: Any = client.app
    findings: list[dict[str, Any]] = app.state.local_checks.findings_of("local")
    return findings


def test_a_check_keeps_its_findings_on_the_students_own_lines(client: TestClient) -> None:
    line = synced_line(client)
    gap = finding(type="gap", noteQuote=None, anchorLineId=line, screenSnippet="activation energy")
    stranger = finding(noteLineIds=[str(uuid4())])
    body = check(finding(noteLineIds=[line]), gap, stranger)

    response = client.post("/v1/notes/checks", json=body, headers=LOCAL)
    assert response.status_code == 201
    ids = response.json()["findingIds"]
    assert ids[0] and ids[1] and ids[2] is None  # a finding naming no line of theirs isn't kept

    rows = stored(client)
    assert {r["type"] for r in rows} == {"difference", "gap"}
    assert all(r["page_id"] == PAGE and r["status"] == "open" for r in rows)


def test_a_device_saves_a_check_for_its_owner(client: TestClient) -> None:
    line = synced_line(client)
    token = link_device(client)
    link = {
        "noteLineId": line,
        "finding": 0,
        "url": "https://www.youtube.com/watch?v=abc&t=754",
        "timestampSec": 754,
    }
    body = check(finding(type="match", noteLineIds=[line], question=None), links=[link])
    headers = {**internal_headers(), "X-Mew-Device-Token": token}
    assert client.post("/v1/notes/device/checks", json=body, headers=headers).status_code == 201
    assert (
        client.post("/v1/notes/device/checks", json=body, headers=internal_headers()).status_code
        == 401
    )


@pytest.mark.parametrize(
    "body",
    [
        check(finding(screenSnippet="")),
        check(finding(screenSnippet="x" * 201)),
        check(finding(type="verdict")),
        check(finding(confidence=1.5)),
        check(finding(question="bell\x07")),
        check(finding(), links=[{"noteLineId": str(uuid4()), "finding": 0}]),
        check(
            finding(), links=[{"noteLineId": str(uuid4()), "finding": 3, "url": "https://x.com/a"}]
        ),
        check(
            finding(),
            links=[{"noteLineId": str(uuid4()), "finding": 0, "url": "https://x.com/a?session=1"}],
        ),
        {**check(finding()), "sourceApp": "C:\\evil\\app.exe"},
    ],
    ids=[
        "empty-snippet",
        "long-snippet",
        "type",
        "confidence",
        "control-char",
        "link-to-nothing",
        "link-finding",
        "link-query",
        "app-path",
    ],
)
def test_a_check_refuses_invalid_input(client: TestClient, body: dict[str, Any]) -> None:
    assert client.post("/v1/notes/checks", json=body, headers=LOCAL).status_code == 422


def test_supabase_drops_the_check_if_its_findings_fail() -> None:
    seen: list[httpx.Request] = []
    line = uuid4()

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": str(line), "page_id": PAGE}])
        if path.endswith("notes_checks") and request.method == "POST":
            return httpx.Response(201, json=[{"id": str(uuid4())}])
        if path.endswith("notes_findings"):
            return httpx.Response(500, text="boom")
        return httpx.Response(204)

    store = SupabaseCheckStore(
        "https://proj.supabase.co",
        api_key="sb_secret_x",
        user_token=None,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    body = CheckCreate.model_validate(check(finding(noteLineIds=[str(line)])))
    with pytest.raises(Exception, match="failed"):
        store.save("user_1", body)
    assert seen[-1].method == "DELETE" and seen[-1].url.path.endswith("notes_checks")
    inserted = json.loads(seen[1].content)
    assert inserted[0]["user_id"] == "user_1"  # set explicitly with the secret key
    assert seen[0].url.params["user_id"] == "eq.user_1"


# ─── The maths verifier ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("note", "screen", "verdict"),
    [
        (r"a = \frac{F}{m}", r"F = m a", "equivalent"),
        (r"I = \frac{V}{R}", r"V = I R", "equivalent"),
        (r"E_k = \frac{1}{2} m v^2", r"E_k = 0.5 m v^2", "equivalent"),
        (r"9.8 \text{m}", r"980 \text{cm}", "equivalent"),
        (r"6.02 \times 10^{32}", r"6.02 \times 10^{23}", "different"),
        (r"g = 98", r"g = 9.8", "different"),
        (r"x = 2", r"x^2 = 4", "different"),
        (r"\frac{d}{dx}\sin x = -\cos x", r"\frac{d}{dx}\sin x = \cos x", "unknown"),
        (r"\notacommand", r"x = 1", "unknown"),
    ],
)
def test_claims_are_compared_with_sympy_never_guessed(note: str, screen: str, verdict: str) -> None:
    assert compare_claim(note, screen) == verdict


def test_the_equivalence_route_is_internal_and_bounded(client: TestClient) -> None:
    pair = {"note": "a = \\frac{F}{m}", "screen": "F = m a"}
    response = client.post(
        "/v1/notes/equivalence", json={"pairs": [pair]}, headers=internal_headers()
    )
    assert response.json() == {"verdicts": ["equivalent"]}
    assert client.post("/v1/notes/equivalence", json={"pairs": [pair]}).status_code == 401
    too_many = {"pairs": [pair] * 6}
    assert (
        client.post("/v1/notes/equivalence", json=too_many, headers=internal_headers()).status_code
        == 422
    )


def test_ids_round_trip_as_uuids() -> None:
    created = CheckCreate.model_validate(check(finding(noteLineIds=[PAGE])))
    assert created.findings[0].note_line_ids == [UUID(PAGE)]


# ─── Resolving findings (N5) ─────────────────────────────────────────────────────────────────


def saved_difference(client: TestClient) -> tuple[str, str]:
    line = synced_line(client)
    body = check(finding(noteLineIds=[line]))
    finding_id = client.post("/v1/notes/checks", json=body, headers=LOCAL).json()["findingIds"][0]
    return finding_id, line


def test_a_finding_is_read_back_and_listed_on_its_page_while_open(client: TestClient) -> None:
    finding_id, line = saved_difference(client)
    read = client.get(f"/v1/notes/findings/{finding_id}", headers=LOCAL)
    assert read.status_code == 200
    assert read.json() == read.json() | {
        "status": "open",
        "noteLineIds": [line],
        "pageId": PAGE,
        "explanation": "Consumed vs not consumed.",
    }
    listed = client.get(f"/v1/notes/findings?page_id={PAGE}", headers=LOCAL).json()
    assert [f["id"] for f in listed] == [finding_id]


def test_a_finding_is_resolved_once(client: TestClient) -> None:
    finding_id, _ = saved_difference(client)
    path = f"/v1/notes/findings/{finding_id}"
    done = client.patch(path, json={"status": "resolved_fixed"}, headers=LOCAL)
    assert done.status_code == 200 and done.json()["status"] == "resolved_fixed"
    again = client.patch(path, json={"status": "explained"}, headers=LOCAL)
    assert again.status_code == 409
    # Resolved findings aren't marked again.
    assert client.get(f"/v1/notes/findings?page_id={PAGE}", headers=LOCAL).json() == []


@pytest.mark.parametrize("status", ["open", "wrong", ""])
def test_a_finding_cant_be_reopened_or_given_another_status(
    client: TestClient, status: str
) -> None:
    finding_id, _ = saved_difference(client)
    response = client.patch(
        f"/v1/notes/findings/{finding_id}", json={"status": status}, headers=LOCAL
    )
    assert response.status_code == 422


def test_unknown_findings_are_not_found(client: TestClient) -> None:
    path = f"/v1/notes/findings/{uuid4()}"
    assert client.get(path, headers=LOCAL).status_code == 404
    assert client.patch(path, json={"status": "dismissed"}, headers=LOCAL).status_code == 404
    assert client.get(path, headers=internal_headers()).status_code == 401


def test_supabase_resolves_only_an_open_finding_of_the_students() -> None:
    seen: list[httpx.Request] = []
    finding_id, check_id = uuid4(), uuid4()

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "PATCH":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": str(finding_id),
                        "check_id": str(check_id),
                        "type": "difference",
                        "note_line_ids": [],
                        "page_id": PAGE,
                        "note_quote": "used up",
                        "screen_snippet": "not consumed",
                        "question": "Q?",
                        "explanation": "",
                        "concept_hint": None,
                        "concept_id": None,
                        "confidence": 0.9,
                        "source_conflict": False,
                        "status": "explained",
                    }
                ],
            )
        return httpx.Response(
            200, json=[{"id": str(check_id), "scope": {"kind": "course", "course_id": NOTEBOOK}}]
        )

    store = SupabaseCheckStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x",
        user_token="user-jwt",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    view = store.update_finding("user_1", finding_id, FindingUpdate(status="explained"))
    assert view is not None and view.course_id == UUID(NOTEBOOK)
    patch = seen[0]
    assert patch.url.params["status"] == "eq.open" and patch.url.params["user_id"] == "eq.user_1"
    assert json.loads(patch.content)["status"] == "explained"

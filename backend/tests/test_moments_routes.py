"""K8 routes: filing a moment from the desktop app, the checks a saved moment makes, Change
teaching, and the moment's audio."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from mew_api.courses.models import NewChunk
from mew_api.moments.filing import unsorted_node_id

from .conftest import internal_headers
from .test_clip_entries import device, entry_body
from .test_clips import client, save  # noqa: F401  (the client fixture)
from .test_devices import LOCAL, link_device

PHYSICS = "00000000-0000-4000-8000-000000000001"
KINEMATICS = "00000000-0000-4000-8000-000000000013"
GRAVITY = "00000000-0000-4000-8000-000000000015"
CHEMISTRY = "00000000-0000-4000-8000-000000000002"

QUESTION: dict[str, Any] = {
    "kind": "short",
    "prompt": "Why is the path of a thrown ball curved?",
    "choices": [],
    "answerKey": "Gravity accelerates it downward while it moves sideways at a steady speed.",
    "answerLatex": None,
    "problemLatex": None,
}


def node(node_id: str, title: str, parent: str | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "id": node_id,
        "parentId": parent,
        "title": title,
        "position": "a0" if node_id.endswith("1") else "a1",
        "childLabel": "Chapters",
        "icon": None,
        "color": None,
        "courseId": None,
        "deletedAt": None,
        "editedAt": 1,
        **extra,
    }


def physics_notebook(client: TestClient) -> None:  # noqa: F811
    tree = [
        node(PHYSICS, "Physics", subject="physics"),
        node(KINEMATICS, "Chapter 3 · Kinematics", PHYSICS),
        node(GRAVITY, "Chapter 5 · Gravity", PHYSICS),
        node(CHEMISTRY, "Chemistry"),
    ]
    response = client.put("/v1/notebooks/tree", json={"nodes": tree, "removed": []}, headers=LOCAL)
    assert response.status_code == 200
    courses = client.app.state.local_courses  # type: ignore[attr-defined]
    course = courses.create_course("local", "Physics")
    courses.add_chunks(
        "local",
        course.id,
        uuid.uuid4(),
        [
            NewChunk(
                page=40,
                heading="3.4 Projectile motion",
                text="A ball thrown sideways follows a parabola: projectile motion under gravity.",
                embedding=[0.0],
                notebook_node_id=uuid.UUID(KINEMATICS),
            ),
            NewChunk(
                page=80,
                heading="5.1 Gravity",
                text="Gravity pulls every mass toward the Earth.",
                embedding=[0.0],
                notebook_node_id=uuid.UUID(GRAVITY),
            ),
        ],
    )


def file(client: TestClient, token: str, **body: Any) -> Any:  # noqa: F811
    response = client.post("/v1/moments/file", json=body, headers=device(token))
    assert response.status_code == 200, response.text
    return response.json()


def test_an_unspoken_moment_is_filed_by_what_its_about(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    physics_notebook(client)

    filed = file(client, token, subject="physics", hints=["projectile motion", "gravity"])
    assert filed["method"] == "content_match"
    assert filed["nodeId"] == KINEMATICS
    assert filed["path"] == ["Physics", "Chapter 3 · Kinematics"]
    assert filed["matched"] == "projectile motion"

    subject_only = file(client, token, subject="physics", hints=["optics"])
    assert (subject_only["method"], subject_only["nodeId"]) == ("subject_match", PHYSICS)
    assert [a["nodeId"] for a in subject_only["alternatives"]] == [KINEMATICS, GRAVITY]

    biology = file(client, token, subject="biology", hints=["mitosis"])
    assert biology["method"] == "unsorted"
    assert biology["nodeId"] == str(unsorted_node_id("local"))
    assert biology["path"] == ["Unsorted"]
    assert biology["newNotebook"] == "Biology"


def test_filing_needs_a_device_and_takes_no_titles(client: TestClient) -> None:  # noqa: F811
    unsigned = client.post("/v1/moments/file", json={"hints": []}, headers=internal_headers())
    assert unsigned.status_code == 401
    token = link_device(client)
    for body in [{"hints": ["x"] * 6}, {"subject": "astrology"}, {"title": "Physics"}]:
        response = client.post("/v1/moments/file", json=body, headers=device(token))
        assert response.status_code == 422


def test_a_saved_moment_remembers_its_source_and_gets_a_check(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    physics_notebook(client)
    destination = {"nodeId": KINEMATICS, "page": {"kind": "from_screen"}}
    body = entry_body(moment={"subject": "physics", "checkQuestion": QUESTION})
    body["destination"] = destination
    assert save(client, token, body).status_code == 201

    # The next moment from the same video goes there, whatever it's about.
    youtube = "youtube:dQw4w9WgXcQ"
    remembered = file(client, token, sourceKey=youtube, subject="chemistry", hints=["bonds"])
    assert (remembered["method"], remembered["nodeId"]) == ("source_memory", KINEMATICS)

    # Its check is due tomorrow; its key stays with the server.
    due = client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]
    assert len(due) == 1
    check = due[0]
    assert check["prompt"] == QUESTION["prompt"]
    assert check["nodeId"] == KINEMATICS
    assert check["isNew"] is True
    assert "answerKey" not in check
    when = datetime.fromisoformat(check["dueAt"])
    assert timedelta(hours=23) < when - datetime.now(UTC) <= timedelta(days=1)

    full = client.get(f"/v1/moments/checks/{check['id']}", headers=LOCAL).json()
    assert full["answerKey"] == QUESTION["answerKey"]

    # Answered: its new schedule.
    later = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    patched = client.patch(
        f"/v1/moments/checks/{check['id']}",
        json={"fsrsState": {"due": later, "stability": 3.1}, "dueAt": later, "reps": 1},
        headers=LOCAL,
    )
    assert patched.status_code == 204
    again = client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"][0]
    assert again["isNew"] is False

    # Cleared when the student turns it off and says so.
    assert client.delete("/v1/moments/checks", headers=LOCAL).status_code == 204
    assert client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"] == []


def test_no_check_when_the_student_turned_quizzing_off(client: TestClient) -> None:  # noqa: F811
    client.patch("/v1/me/settings", json={"quiz_saved_moments": False}, headers=LOCAL)
    token = link_device(client)
    assert (
        save(
            client, token, entry_body(moment={"subject": None, "checkQuestion": QUESTION})
        ).status_code
        == 201
    )
    assert client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"] == []


def test_moving_a_moment_teaches_where_its_source_goes(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    physics_notebook(client)
    body = entry_body()
    body["destination"] = {"nodeId": KINEMATICS, "page": {"kind": "from_screen"}}
    clip_id = save(client, token, body).json()["clipId"]

    moved = client.post(
        "/v1/clips/destination",
        json={
            "clipId": clip_id,
            "destination": {"nodeId": CHEMISTRY, "page": {"kind": "from_screen"}},
        },
        headers=device(token),
    )
    assert moved.status_code == 204
    filed = file(client, token, sourceKey="youtube:dQw4w9WgXcQ", subject="physics", hints=["x"])
    assert (filed["method"], filed["nodeId"]) == ("source_memory", CHEMISTRY)


def test_a_moments_voice_is_kept_for_replay(client: TestClient) -> None:  # noqa: F811
    clip = "66666666-6666-4666-8666-000000000001"
    pcm = b"\x01\x00" * 2400
    path = f"/v1/moments/{clip}/audio/0/1"
    put = client.put(path, content=pcm, headers={**LOCAL, "content-type": "audio/L16"})
    assert put.status_code == 204
    got = client.get(path, headers=LOCAL)
    assert got.status_code == 200
    assert got.content == pcm
    assert got.headers["content-type"] == "audio/L16"

    assert client.get(f"/v1/moments/{clip}/audio/0/2", headers=LOCAL).status_code == 404
    wrong_type = client.put(path, content=pcm, headers={**LOCAL, "content-type": "audio/mpeg"})
    assert wrong_type.status_code == 415
    odd = client.put(path, content=b"\x01", headers={**LOCAL, "content-type": "audio/L16"})
    assert odd.status_code == 413
    too_far = client.put(
        f"/v1/moments/{clip}/audio/3/0", content=pcm, headers={**LOCAL, "content-type": "audio/L16"}
    )
    assert too_far.status_code == 422


def waiting_moment(client: TestClient, token: str, **moment: Any) -> str:  # noqa: F811
    """A moment saved into Unsorted, with what its answer said it's about."""
    body = entry_body(conceptHints=moment.pop("hints", ["projectile motion"]))
    body["entry"]["moment"] = {"subject": moment.get("subject"), "checkQuestion": QUESTION}
    body["destination"] = {
        "nodeId": str(unsorted_node_id("local")),
        "page": {"kind": "from_screen"},
    }
    created = save(client, token, body)
    assert created.status_code == 201, created.text
    return str(created.json()["clipId"])


def test_file_these_suggests_a_place_for_each_waiting_moment(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    physics_notebook(client)
    kinematics = waiting_moment(client, token, subject="physics")
    biology = waiting_moment(client, token, subject="biology", hints=["mitosis"])

    response = client.post(
        "/v1/clips/suggestions",
        json={"clipIds": [kinematics, biology, str(uuid.uuid4())]},
        headers=LOCAL,
    )
    assert response.status_code == 200, response.text
    suggestions = response.json()["suggestions"]
    # An unknown clip is left out; one with no place to go has none (never Unsorted again).
    assert [s["clipId"] for s in suggestions] == [kinematics, biology]
    assert suggestions[0]["nodeId"] == KINEMATICS
    assert suggestions[0]["path"] == ["Physics", "Chapter 3 · Kinematics"]
    assert suggestions[0]["method"] == "content_match"
    assert suggestions[1].get("nodeId") is None

    too_many = client.post(
        "/v1/clips/suggestions", json={"clipIds": [kinematics] * 31}, headers=LOCAL
    )
    assert too_many.status_code == 422
    unsigned = client.post(
        "/v1/clips/suggestions", json={"clipIds": [kinematics]}, headers=internal_headers()
    )
    assert unsigned.status_code == 401


def test_a_move_in_the_notebook_files_it_and_takes_its_check(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    physics_notebook(client)
    clip_id = waiting_moment(client, token, subject="physics")

    moved = client.post(f"/v1/clips/{clip_id}/move", json={"nodeId": GRAVITY}, headers=LOCAL)
    assert moved.status_code == 204, moved.text
    view = client.get(f"/v1/clips/{clip_id}", headers=LOCAL).json()
    assert view["destination"]["nodeId"] == GRAVITY
    assert view["destination"]["path"] == ["Physics", "Chapter 5 · Gravity"]
    # Its check's badge is on the new chapter now.
    due = client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]
    assert [c["nodeId"] for c in due] == [GRAVITY]
    # And its source's next moment goes there too.
    filed = file(client, token, sourceKey="youtube:dQw4w9WgXcQ", subject="physics", hints=["x"])
    assert (filed["method"], filed["nodeId"]) == ("source_memory", GRAVITY)

    nowhere = client.post(
        f"/v1/clips/{clip_id}/move", json={"nodeId": str(uuid.uuid4())}, headers=LOCAL
    )
    assert nowhere.status_code == 404
    unknown = client.post(f"/v1/clips/{uuid.uuid4()}/move", json={"nodeId": GRAVITY}, headers=LOCAL)
    assert unknown.status_code == 404


def test_a_merged_card_lists_every_moment_it_holds(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    physics_notebook(client)
    first = waiting_moment(client, token, subject="physics")
    body = entry_body(
        sessionId="11111111-1111-4111-8111-000000000099", conceptHints=["projectile motion"]
    )
    body["entry"]["moment"] = {"subject": "physics", "checkQuestion": QUESTION}
    second = save(client, token, body).json()["clipId"]
    due = client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]
    assert len(due) == 1
    assert due[0]["clipId"] == first
    assert due[0]["mergedClipIds"] == [second]


def quiz(client: TestClient, token: str, **body: Any) -> Any:  # noqa: F811
    return client.post("/v1/moments/device/quiz", json=body, headers=device(token))


def test_quiz_me_on_this_keeps_each_question_as_its_own_card(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    questions = [
        {"question": QUESTION, "hints": ["projectile motion"]},
        {"question": {**QUESTION, "prompt": "What is the horizontal acceleration?"}, "hints": []},
    ]
    response = quiz(
        client, token, questions=questions, sourceTitle="Lecture 5", sourceApp="chrome.exe"
    )
    assert response.status_code == 200
    ids = response.json()["checkIds"]
    assert len(ids) == 2

    due = client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]
    assert {c["id"] for c in due} == set(ids)
    assert all(c["origin"] == "screen_quiz" for c in due)
    assert all(c["clipId"] is None and c["sourceTitle"] == "Lecture 5" for c in due)
    assert all("answerKey" not in c for c in due)

    # A saved moment about the same concept starts its own card: quiz cards never merge.
    body = entry_body(moment={"subject": "physics", "checkQuestion": QUESTION})
    assert save(client, token, body).status_code == 201
    assert len(client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]) == 3

    # The device reads a quiz card's key (to grade on screen), never a moment's check.
    full = client.get(f"/v1/moments/device/checks/{ids[0]}", headers=device(token))
    assert full.status_code == 200
    assert full.json()["answerKey"] == QUESTION["answerKey"]
    moment_check = next(
        c["id"]
        for c in client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]
        if c["origin"] == "moment"
    )
    other = client.get(f"/v1/moments/device/checks/{moment_check}", headers=device(token))
    assert other.status_code == 404


def test_quiz_cards_need_a_device_and_at_most_three_questions(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    no_device = client.post(
        "/v1/moments/device/quiz",
        json={"questions": [{"question": QUESTION}]},
        headers=internal_headers(),
    )
    assert no_device.status_code == 401
    four = [{"question": QUESTION}] * 4
    assert quiz(client, token, questions=four).status_code == 422
    assert quiz(client, token, questions=[]).status_code == 422
    missing = client.get(f"/v1/moments/device/checks/{uuid.uuid4()}", headers=device(token))
    assert missing.status_code == 404


def test_quiz_cards_respect_the_15_new_a_day(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    for _ in range(6):
        assert quiz(client, token, questions=[{"question": QUESTION}] * 3).status_code == 200
    due = client.get("/v1/moments/checks/due", headers=LOCAL).json()["checks"]
    assert len(due) == 15

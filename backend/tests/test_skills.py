"""S5 routes: a finished walkthrough becomes a skill with a re-check date, its evidence is
checked again (coaching is never independent), and the owner sees and deletes their skills."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from mew_api.courses.models import Concept
from mew_api.skills.store import MemorySkillStore, concept_for

from .test_devices import LOCAL, link_device
from .test_walkthroughs import client, device, new_walkthrough, progress  # noqa: F401


def finished(client: TestClient, token: str, **changes: Any) -> str:  # noqa: F811
    created = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(**changes), headers=device(token)
    )
    wid: str = created.json()["id"]
    done = client.put(
        f"/v1/walkthroughs/device/{wid}",
        json=progress(0, status="completed"),
        headers=device(token),
    )
    assert done.status_code == 200
    return wid


def record(wid: str, **changes: Any) -> dict[str, Any]:
    due = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    body: dict[str, Any] = {
        "walkthroughId": wid,
        "title": "Pivot tables",
        "app": "excel.exe",
        "kind": "guided",
        "evidence": "with_hint",
        "hints": 2,
        "card": {"due": due, "stability": 2.3, "reps": 1},
        "dueAt": due,
    }
    body.update(changes)
    return body


def test_a_finished_walkthrough_becomes_a_skill_with_a_recheck(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    wid = finished(client, token)
    response = client.post("/v1/skills/device/record", json=record(wid), headers=device(token))
    assert response.status_code == 200
    skill = response.json()
    assert skill["title"] == "Pivot tables"
    assert skill["lastWalkthroughId"] == wid

    listed = client.get("/v1/skills/device", headers=device(token)).json()["skills"]
    assert [s["id"] for s in listed] == [skill["id"]]
    walkthrough = client.get(f"/v1/walkthroughs/device/{wid}", headers=device(token)).json()
    assert walkthrough["skillId"] == skill["id"]

    # The same skill again (a re-check, done alone) updates it: one skill per title and app.
    again = finished(client, token, kind="recheck", skillId=skill["id"])
    solo = record(again, kind="recheck", evidence="independent", hints=0)
    second = client.post("/v1/skills/device/record", json=solo, headers=device(token)).json()
    assert second["id"] == skill["id"]

    views = client.get("/v1/skills", headers=LOCAL).json()["skills"]
    assert len(views) == 1
    assert views[0]["lastEvidence"] == "independent"
    assert views[0]["solo"] == 1

    assert client.delete(f"/v1/skills/{skill['id']}", headers=LOCAL).status_code == 204
    assert client.get("/v1/skills", headers=LOCAL).json()["skills"] == []
    assert client.delete(f"/v1/skills/{skill['id']}", headers=LOCAL).status_code == 404


def test_coaching_is_never_independent(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    wid = finished(client, token)
    response = client.post(
        "/v1/skills/device/record",
        json=record(wid, evidence="independent", hints=0),
        headers=device(token),
    )
    assert response.status_code == 422


def test_only_a_finished_walkthrough_of_the_right_kind(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    created = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(), headers=device(token)
    ).json()
    unfinished = client.post(
        "/v1/skills/device/record", json=record(created["id"]), headers=device(token)
    )
    assert unfinished.status_code == 409

    wid = finished(client, token)
    wrong_kind = client.post(
        "/v1/skills/device/record",
        json=record(wid, kind="recheck", evidence="independent", hints=0),
        headers=device(token),
    )
    assert wrong_kind.status_code == 409

    missing = record("00000000-0000-4000-8000-0000000000aa")
    assert (
        client.post("/v1/skills/device/record", json=missing, headers=device(token)).status_code
        == 404
    )


def test_needs_a_device(client: TestClient) -> None:  # noqa: F811
    response = client.get(
        "/v1/skills/device", headers={**device("nope"), "X-Mew-Device-Token": "not a token"}
    )
    assert response.status_code == 401


def concept(title: str) -> Concept:
    return Concept.model_validate(
        {
            "id": "00000000-0000-4000-8000-000000000c01",
            "course_id": "00000000-0000-4000-8000-000000000c00",
            "title": title,
            "summary": "",
            "order_index": 0,
            "source_pages": [],
        }
    )


def test_a_skill_links_the_concept_its_title_names() -> None:
    concepts = [concept("Pivot tables"), concept("Projectile motion")]
    assert concept_for("Pivot tables", concepts) == concepts[0]
    assert concept_for("Make a pivot table", concepts) is None
    assert concept_for("Charts", concepts) is None
    assert MemorySkillStore(lambda _: concepts).device_list("user_1") == []

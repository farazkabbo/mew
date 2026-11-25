"""Where handoffs are kept: rows in Postgres and ciphertext in the private "handoffs" bucket
(Supabase, service key only), or in memory for local mode and tests. The rules (who may do
what) are in `service.py`; this is storage only."""

from datetime import datetime
from typing import Any, Protocol
from urllib.parse import quote
from uuid import UUID

from ..supabase_rest import SupabaseRest

BUCKET = "handoffs"

Row = dict[str, Any]


def storage_path(sender: str, handoff_id: UUID) -> str:
    return f"{sender}/{handoff_id}.bin"


class HandoffStore(Protocol):
    def insert_handoff(self, row: Row, members: list[Row]) -> None: ...
    def handoff(self, handoff_id: UUID) -> Row | None: ...
    def update_handoff(self, handoff_id: UUID, fields: Row) -> None: ...
    def members(self, handoff_id: UUID) -> list[Row]: ...
    def update_member(self, handoff_id: UUID, email: str, fields: Row) -> None: ...
    def add_event(self, handoff_id: UUID, actor: str | None, kind: str, at: datetime) -> None: ...
    def events(self, handoff_id: UUID) -> list[Row]: ...
    def add_reply(self, row: Row) -> None: ...
    def replies(self, handoff_id: UUID) -> list[Row]: ...
    def sent_by(self, user: str) -> list[Row]: ...
    def memberships(self, user: str, email: str | None) -> list[Row]: ...
    def put_object(self, path: str, data: bytes) -> None: ...
    def get_object(self, path: str) -> bytes | None: ...
    def delete_objects(self, paths: list[str]) -> None: ...
    def purge(self, now: datetime) -> list[str]: ...
    def delete_handoff(self, handoff_id: UUID) -> None: ...
    def remove_member(self, handoff_id: UUID, email: str) -> None: ...


class MemoryHandoffStore:
    """Local mode and tests."""

    def __init__(self) -> None:
        self.rows: dict[UUID, Row] = {}
        self.member_rows: dict[UUID, list[Row]] = {}
        self.event_rows: dict[UUID, list[Row]] = {}
        self.reply_rows: dict[UUID, list[Row]] = {}
        self.objects: dict[str, bytes] = {}

    def insert_handoff(self, row: Row, members: list[Row]) -> None:
        self.rows[row["id"]] = dict(row)
        self.member_rows[row["id"]] = [dict(m) for m in members]

    def handoff(self, handoff_id: UUID) -> Row | None:
        row = self.rows.get(handoff_id)
        return dict(row) if row else None

    def update_handoff(self, handoff_id: UUID, fields: Row) -> None:
        if handoff_id in self.rows:
            self.rows[handoff_id].update(fields)

    def members(self, handoff_id: UUID) -> list[Row]:
        return [dict(m) for m in self.member_rows.get(handoff_id, [])]

    def update_member(self, handoff_id: UUID, email: str, fields: Row) -> None:
        for m in self.member_rows.get(handoff_id, []):
            if m["email"] == email:
                m.update(fields)

    def add_event(self, handoff_id: UUID, actor: str | None, kind: str, at: datetime) -> None:
        self.event_rows.setdefault(handoff_id, []).append(
            {"handoff_id": handoff_id, "actor_id": actor, "type": kind, "at": at}
        )

    def events(self, handoff_id: UUID) -> list[Row]:
        return list(self.event_rows.get(handoff_id, []))

    def add_reply(self, row: Row) -> None:
        self.reply_rows.setdefault(row["handoff_id"], []).append(dict(row))

    def replies(self, handoff_id: UUID) -> list[Row]:
        return list(self.reply_rows.get(handoff_id, []))

    def sent_by(self, user: str) -> list[Row]:
        return [dict(r) for r in self.rows.values() if r["sender_id"] == user]

    def memberships(self, user: str, email: str | None) -> list[Row]:
        return [
            dict(m)
            for rows in self.member_rows.values()
            for m in rows
            if m.get("user_id") == user or (email is not None and m["email"] == email)
        ]

    def put_object(self, path: str, data: bytes) -> None:
        self.objects[path] = data

    def get_object(self, path: str) -> bytes | None:
        return self.objects.get(path)

    def delete_objects(self, paths: list[str]) -> None:
        for path in paths:
            self.objects.pop(path, None)

    def purge(self, now: datetime) -> list[str]:
        gone = [
            hid
            for hid, row in self.rows.items()
            if row["expires_at"] <= now or row["status"] == "revoked"
        ]
        paths = [self.rows[hid]["storage_path"] for hid in gone]
        for hid in gone:
            self.delete_handoff(hid)
        return paths

    def delete_handoff(self, handoff_id: UUID) -> None:
        self.rows.pop(handoff_id, None)
        self.member_rows.pop(handoff_id, None)
        self.event_rows.pop(handoff_id, None)
        self.reply_rows.pop(handoff_id, None)

    def remove_member(self, handoff_id: UUID, email: str) -> None:
        rows = self.member_rows.get(handoff_id, [])
        self.member_rows[handoff_id] = [m for m in rows if m["email"] != email]


def _json(row: Row) -> Row:
    return {k: (str(v) if isinstance(v, UUID | datetime) else v) for k, v in row.items()}


def _parse(row: Row) -> Row:
    out = dict(row)
    for key in ("id", "handoff_id"):
        if isinstance(out.get(key), str):
            out[key] = UUID(out[key])
    for key in ("expires_at", "revoked_at", "created_at", "opened_at", "picked_up_at", "at"):
        value = out.get(key)
        if isinstance(value, str):
            out[key] = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return out


class SupabaseHandoffStore(SupabaseRest):
    """Service mode only: users have no access to these tables or the bucket."""

    def insert_handoff(self, row: Row, members: list[Row]) -> None:
        self._insert("handoffs", [_json(row)], returning=False)
        self._insert("handoff_members", [_json(m) for m in members], returning=False)

    def handoff(self, handoff_id: UUID) -> Row | None:
        rows = self._get("handoffs", {"id": f"eq.{handoff_id}"})
        return _parse(rows[0]) if rows else None

    def update_handoff(self, handoff_id: UUID, fields: Row) -> None:
        self._patch("handoffs", {"id": f"eq.{handoff_id}"}, _json(fields))

    def members(self, handoff_id: UUID) -> list[Row]:
        return [_parse(r) for r in self._get("handoff_members", {"handoff_id": f"eq.{handoff_id}"})]

    def update_member(self, handoff_id: UUID, email: str, fields: Row) -> None:
        self._patch(
            "handoff_members",
            {"handoff_id": f"eq.{handoff_id}", "email": f"eq.{email}"},
            _json(fields),
        )

    def add_event(self, handoff_id: UUID, actor: str | None, kind: str, at: datetime) -> None:
        row = {"handoff_id": str(handoff_id), "actor_id": actor, "type": kind, "at": at.isoformat()}
        self._insert("handoff_events", [row], returning=False)

    def events(self, handoff_id: UUID) -> list[Row]:
        params = {"handoff_id": f"eq.{handoff_id}", "order": "at.asc"}
        return [_parse(r) for r in self._get("handoff_events", params)]

    def add_reply(self, row: Row) -> None:
        self._insert("handoff_replies", [_json(row)], returning=False)

    def replies(self, handoff_id: UUID) -> list[Row]:
        params = {"handoff_id": f"eq.{handoff_id}", "order": "created_at.asc"}
        return [_parse(r) for r in self._get("handoff_replies", params)]

    def sent_by(self, user: str) -> list[Row]:
        params = {"sender_id": f"eq.{user}", "order": "created_at.desc", "limit": "200"}
        return [_parse(r) for r in self._get("handoffs", params)]

    def memberships(self, user: str, email: str | None) -> list[Row]:
        # Emails are checked by the database (lowercase, a single @, no spaces): safe in a filter.
        condition = f"(user_id.eq.{user},email.eq.{email})" if email else f"(user_id.eq.{user})"
        rows = self._get("handoff_members", {"or": condition, "limit": "500"})
        return [_parse(r) for r in rows]

    def put_object(self, path: str, data: bytes) -> None:
        self._request(
            "POST",
            f"/storage/v1/object/{BUCKET}/{quote(path)}",
            content=data,
            headers={"Content-Type": "application/octet-stream", "x-upsert": "true"},
        )

    def get_object(self, path: str) -> bytes | None:
        response = self._request("GET", f"/storage/v1/object/{BUCKET}/{quote(path)}", ok=(400, 404))
        return None if response.is_error else response.content

    def delete_objects(self, paths: list[str]) -> None:
        if paths:
            self._request(
                "DELETE", f"/storage/v1/object/{BUCKET}", json={"prefixes": paths}, ok=(404,)
            )

    def purge(self, now: datetime) -> list[str]:
        rows = self._request(
            "POST", "/rest/v1/rpc/purge_handoffs", json={"p_now": now.isoformat()}
        ).json()
        return [str(r) for r in rows] if isinstance(rows, list) else []

    def delete_handoff(self, handoff_id: UUID) -> None:
        self._delete("handoffs", {"id": f"eq.{handoff_id}"})

    def remove_member(self, handoff_id: UUID, email: str) -> None:
        self._delete("handoff_members", {"handoff_id": f"eq.{handoff_id}", "email": f"eq.{email}"})

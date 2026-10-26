"""Where the notebook tree is kept: Supabase (`notebooks`) or, in local mode, memory.

The student's own browser syncs it (Clerk token), so Supabase applies RLS, the column grants and
the tree triggers (migration 20261030000000_notebook_tree.sql). The memory store follows the
same rules, so local mode behaves the same:
- a parent is the caller's own; depth ≤ 2 and no loops, for everything under a moved node too;
- a title that clashes with a live sibling's (ignoring case) gets a number ("Physics 2");
- the latest edit wins; a purged node takes everything under it along.
"""

import logging
import threading
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from pydantic import ValidationError

from ..supabase_rest import StoreError, SupabaseRest
from .models import (
    MAX_DEPTH,
    NodeResult,
    NodeStatus,
    NotebookNode,
    NotebookTreeSync,
    parents_first,
)

logger = logging.getLogger(__name__)

#: How many numbered names a clash tries before the node is refused.
MAX_NUMBERED_NAMES = 50


class NotebookTreeStore(Protocol):
    def tree(self, user: str) -> list[NotebookNode]:
        """Every node the user has, trash included."""
        ...

    def sync(self, user: str, change: NotebookTreeSync) -> list[NodeResult]:
        """Applies the device's changes; one result per node sent, in the order sent."""
        ...


# ─── Memory (local mode) ─────────────────────────────────────────────────────────────────────


class MemoryNotebookTreeStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._owners: dict[UUID, str] = {}
        self._nodes: dict[str, dict[UUID, NotebookNode]] = {}

    def tree(self, user: str) -> list[NotebookNode]:
        with self._lock:
            return list(self._nodes.get(user, {}).values())

    def sync(self, user: str, change: NotebookTreeSync) -> list[NodeResult]:
        with self._lock:
            nodes = self._nodes.setdefault(user, {})
            for node_id in change.removed:
                if node_id in nodes:
                    self._purge(nodes, node_id)
            by_id = {
                r.id: r for r in (self._place(user, nodes, n) for n in parents_first(change.nodes))
            }
            return [by_id[node.id] for node in change.nodes]

    def _place(self, user: str, nodes: dict[UUID, NotebookNode], node: NotebookNode) -> NodeResult:
        if self._owners.get(node.id, user) != user:
            return NodeResult(id=node.id, status="rejected", node=None)
        existing = nodes.get(node.id)
        if existing and existing.edited_at > node.edited_at:
            return NodeResult(id=node.id, status="stale", node=existing)
        if not _placeable(nodes, node):
            return NodeResult(id=node.id, status="rejected", node=existing)

        title = node.title
        status: NodeStatus = "saved"
        attempt = 1
        while node.deleted_at is None and _name_taken(nodes, node, title):
            attempt += 1
            if attempt > MAX_NUMBERED_NAMES:
                return NodeResult(id=node.id, status="rejected", node=existing)
            title = f"{node.title[:76]} {attempt}"
            status = "renamed"
        stored = node.model_copy(update={"title": title})
        nodes[node.id] = stored
        self._owners[node.id] = user
        return NodeResult(id=node.id, status=status, node=stored)

    def _purge(self, nodes: dict[UUID, NotebookNode], node_id: UUID) -> None:
        for child in [n.id for n in nodes.values() if n.parent_id == node_id]:
            self._purge(nodes, child)
        nodes.pop(node_id, None)
        self._owners.pop(node_id, None)


def _placeable(nodes: dict[UUID, NotebookNode], node: NotebookNode) -> bool:
    """The parent exists (and is the user's), there's no loop, and nothing ends up too deep."""
    depth = 0
    above = node.parent_id
    while above is not None:
        parent = nodes.get(above)
        # An unknown parent, the node itself above its new parent (a loop), or a chain longer
        # than any tree can be.
        if parent is None or parent.id == node.id or depth > MAX_DEPTH:
            return False
        depth += 1
        above = parent.parent_id
    return depth + _height(nodes, node.id) <= MAX_DEPTH


def _height(nodes: dict[UUID, NotebookNode], node_id: UUID, limit: int = MAX_DEPTH + 1) -> int:
    children = [n.id for n in nodes.values() if n.parent_id == node_id]
    if not children or limit == 0:
        return 0
    return 1 + max(_height(nodes, child, limit - 1) for child in children)


def _name_taken(nodes: dict[UUID, NotebookNode], node: NotebookNode, title: str) -> bool:
    wanted = title.casefold()
    return any(
        other.id != node.id
        and other.parent_id == node.parent_id
        and other.deleted_at is None
        and other.title.casefold() == wanted
        for other in nodes.values()
    )


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────

_FIELDS = (
    "id,parent_id,title,position,child_label,icon,color,subject,course_id,deleted_at,edited_at"
)


class SupabaseNotebookTreeStore(SupabaseRest):
    """The tree through PostgREST with the student's Clerk token: RLS, the column grants and
    the tree triggers all apply."""

    def tree(self, user: str) -> list[NotebookNode]:
        rows = self._get("notebooks", {"select": _FIELDS, "user_id": f"eq.{user}"})
        return [node for row in rows if (node := _node(row)) is not None]

    def sync(self, user: str, change: NotebookTreeSync) -> list[NodeResult]:
        if self.service:
            raise PermissionError("the tree is only written by its owner")
        response = self._request(
            "POST",
            "/rest/v1/rpc/sync_notebook_tree",
            json={
                "p_nodes": [_row(node) for node in parents_first(change.nodes)],
                "p_removed": [str(node_id) for node_id in change.removed],
            },
        )
        rows = response.json()
        if not isinstance(rows, list):
            raise StoreError("unexpected response from Supabase")
        by_id = {
            UUID(r["id"]): NodeResult(
                id=UUID(r["id"]),
                status=r["status"],
                node=_node(r["node"]) if r.get("node") else None,
            )
            for r in rows
        }
        if set(by_id) != {node.id for node in change.nodes}:
            raise StoreError("unexpected response from Supabase")
        return [by_id[node.id] for node in change.nodes]


def _row(node: NotebookNode) -> dict[str, Any]:
    return {
        "id": str(node.id),
        "parent_id": str(node.parent_id) if node.parent_id else None,
        "title": node.title,
        "position": node.position,
        "child_label": node.child_label,
        "icon": node.icon,
        "color": node.color,
        "subject": node.subject,
        "course_id": str(node.course_id) if node.course_id else None,
        "deleted_at": _iso(node.deleted_at),
        "edited_at": _iso(node.edited_at),
    }


def _node(row: dict[str, Any]) -> NotebookNode | None:
    """A database row as a node; a row that doesn't fit (an old, odd title) is left out."""
    try:
        return NotebookNode.model_validate(
            {
                **row,
                "deleted_at": _millis(row.get("deleted_at")),
                "edited_at": _millis(row.get("edited_at")) or 0,
            }
        )
    except (ValidationError, ValueError, TypeError):
        logger.warning("Skipped a notebook row that doesn't fit the tree")
        return None


def _iso(millis: int | None) -> str | None:
    return None if millis is None else datetime.fromtimestamp(millis / 1000, tz=UTC).isoformat()


def _millis(value: object) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("expected a timestamp")
    return round(datetime.fromisoformat(value).timestamp() * 1000)

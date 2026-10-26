"""The notebook tree's sync records, as the web app sends them (camelCase, times in epoch
milliseconds). They mirror `packages/shared/src/notebook-tree.ts`."""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic.alias_generators import to_camel

from ..clips.models import plain_text

NODES_PER_SYNC = 200
REMOVED_PER_SYNC = 500
#: Deepest level: notebook (0), chapter (1), section (2).
MAX_DEPTH = 2

ChildLabel = Literal["Chapters", "Units", "Weeks", "Topics", "Modules"]
NotebookIcon = Literal[
    "book",
    "atom",
    "flask",
    "sigma",
    "dna",
    "globe",
    "code",
    "landmark",
    "languages",
    "music",
    "palette",
    "leaf",
    "brain",
    "calculator",
]
NotebookColor = Literal["slate", "teal", "blue", "violet", "rose", "amber", "green"]
#: What a notebook is about (K8): the tutor's subjects.
Subject = Literal[
    "math", "physics", "chemistry", "biology", "history", "language", "programming", "other"
]
#: A fractional index (`fractional-indexing`, base 62): siblings sort by it.
Position = Annotated[str, StringConstraints(pattern=r"^[0-9A-Za-z]{1,64}$")]
#: Epoch milliseconds, up to the year 3000.
Millis = Annotated[int, Field(ge=0, le=32_503_680_000_000)]
#: Trimmed, 1 to 200 characters (older notebooks may have long titles; new ones stop at 80).
#: The length check runs after trimming, so "   " is refused.
Title = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    AfterValidator(plain_text),
]
NodeStatus = Literal["saved", "renamed", "stale", "rejected"]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class NotebookNode(_Camel):
    """One node: a notebook (no parent), a chapter or a section."""

    id: UUID
    parent_id: UUID | None
    title: Title
    position: Position
    child_label: ChildLabel
    icon: NotebookIcon | None
    color: NotebookColor | None
    course_id: UUID | None
    #: K8; older devices send none.
    subject: Subject | None = None
    #: In the trash since.
    deleted_at: Millis | None
    #: When the student last changed it (the latest edit wins).
    edited_at: Millis


class NotebookTreeSync(_Camel):
    """The device's changes: nodes added or changed, and nodes purged from the trash."""

    nodes: list[NotebookNode] = Field(max_length=NODES_PER_SYNC)
    removed: list[UUID] = Field(max_length=REMOVED_PER_SYNC)

    @model_validator(mode="after")
    def _each_node_once(self) -> Self:
        ids = [node.id for node in self.nodes]
        if len(set(ids)) != len(ids) or set(ids) & set(self.removed):
            raise ValueError("each node appears once")
        return self


class NodeResult(_Camel):
    id: UUID
    status: NodeStatus
    #: The server's copy after the sync (None when it has none).
    node: NotebookNode | None


class NotebookTreeSyncResult(_Camel):
    results: list[NodeResult]


class NotebookTreeView(_Camel):
    nodes: list[NotebookNode]


def parents_first(nodes: list[NotebookNode]) -> list[NotebookNode]:
    """`nodes` with every parent before its children (among the nodes sent together), so the
    database can place each one; otherwise in the order given."""
    sent = {node.id: node for node in nodes}

    def level(node: NotebookNode) -> int:
        steps = 0
        at = node
        while at.parent_id in sent and steps <= MAX_DEPTH + 1:
            at = sent[at.parent_id]
            steps += 1
        return steps

    return sorted(nodes, key=level)

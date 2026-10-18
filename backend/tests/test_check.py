import time
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mew_api.checker.latex import LatexParseError, parse_line
from mew_api.checker.sandbox import CheckerPool, CheckTimeoutError
from mew_api.checker.steps import check_steps
from mew_api.config import Settings
from mew_api.main import create_app

from .conftest import internal_headers


def verdicts(lines: list[str]) -> list[tuple[str, str]]:
    return [(str(r["verdict"]), str(r["reason"])) for r in check_steps(lines)]


@pytest.mark.parametrize(
    ("lines", "expected"),
    [
        # A correct derivation: each step follows from the one before.
        (
            [r"2x+3=7", r"2x = 7-3", r"x = \frac{4}{2} = 2"],
            [("unknown", "first_line"), ("correct", "equivalent"), ("correct", "equivalent")],
        ),
        # Arithmetic slip: 7 + 3 instead of 7 - 3.
        ([r"2x+3=7", r"2x=10"], [("unknown", "first_line"), ("incorrect", "changes_solutions")]),
        # Squaring both sides follows (adds a root); taking a root and dropping one doesn't.
        ([r"x=2", r"x^2=4"], [("unknown", "first_line"), ("correct", "implied")]),
        ([r"x^2=4", r"x=2"], [("unknown", "first_line"), ("incorrect", "changes_solutions")]),
        # Rewriting expressions.
        ([r"(x+1)^2", r"x^2+2x+1"], [("unknown", "first_line"), ("correct", "equivalent")]),
        ([r"(x+1)^2", r"x^2+1"], [("unknown", "first_line"), ("incorrect", "not_equivalent")]),
        ([r"(x+1)^2", r"= x^2+2x+1"], [("unknown", "first_line"), ("correct", "identity")]),
        # Several variables: rearranging a formula.
        ([r"F=ma", r"a=\frac{F}{m}"], [("unknown", "first_line"), ("correct", "implied")]),
        ([r"F=ma", r"a=Fm"], [("unknown", "first_line"), ("incorrect", "does_not_follow")]),
        # Arithmetic within a line.
        ([r"3+4=8"], [("incorrect", "not_equal")]),
        ([r"x = \frac{7-3}{2} = 3"], [("incorrect", "not_equal")]),
        # Units: converted to SI before comparing, and dimensions must agree.
        (
            [r"v = 3\,\text{m}/\text{s}", r"v = 300\,\text{cm}/\text{s}"],
            [("unknown", "first_line"), ("correct", "equivalent")],
        ),
        ([r"F = 10\,\text{N} = 10\,\text{m}/\text{s}"], [("incorrect", "units")]),
        # π is supported.
        (
            [r"A = \pi r^2", r"\frac{A}{\pi} = r^2"],
            [("unknown", "first_line"), ("correct", "equivalent")],
        ),
    ],
)
def test_check_steps(lines: list[str], expected: list[tuple[str, str]]) -> None:
    assert verdicts(lines) == expected


def test_incorrect_steps_explain_what_changed() -> None:
    result = check_steps([r"2x+3=7", r"2x=10"])[1]
    assert result["detail"] == "x = 2 before, x = 5 after"


def test_never_guesses_about_what_it_cannot_read() -> None:
    assert verdicts([r"x \le 3", r"x < 3"]) == [
        ("unknown", "unparseable"),
        ("unknown", "unparseable"),
    ]
    # A step after an unreadable line isn't judged against it.
    assert verdicts([r"\begin{matrix}", r"x=1"]) == [
        ("unknown", "unparseable"),
        ("unknown", "first_line"),
    ]


@pytest.mark.parametrize(
    "latex",
    [
        "x" * 301,  # too long
        r"2^{3^{4}}",  # power towers could compute astronomically large numbers
        "1234567890123 + x",  # absurd numbers
        r"x = 3\,\text{furlongs}",  # unknown unit text
        r"x -",  # malformed: the strict parser refuses instead of half-parsing
    ],
)
def test_parser_refuses_risky_or_malformed_input(latex: str) -> None:
    with pytest.raises(LatexParseError):
        parse_line(latex)


class InlinePool(CheckerPool):
    """Runs checks in-process (fast tests); `stall` simulates a check that overruns."""

    def __init__(self, stall: bool = False) -> None:
        super().__init__()
        self.stall = stall

    def run(self, fn: Callable[..., Any], *args: Any, timeout: float) -> Any:
        if self.stall:
            raise CheckTimeoutError
        return fn(*args)


def make_client(settings: Settings, pool: CheckerPool) -> TestClient:
    return TestClient(create_app(settings, None, pool, warm_checker=False))


def test_math_endpoint_checks_steps(settings: Settings) -> None:
    client = make_client(settings, InlinePool())
    response = client.post(
        "/v1/check/math", json={"steps": ["2x+3=7", "2x=10"]}, headers=internal_headers()
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert [r["verdict"] for r in results] == ["unknown", "incorrect"]


def test_math_endpoint_is_internal_only(settings: Settings) -> None:
    client = make_client(settings, InlinePool())
    assert client.post("/v1/check/math", json={"steps": ["x=1"]}).status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"steps": []},
        {"steps": ["x=1"] * 9},
        {"steps": ["x" * 301]},
        {"steps": ["x=1"], "extra": True},
    ],
)
def test_math_endpoint_rejects_oversized_or_unexpected_input(
    settings: Settings, body: dict[str, Any]
) -> None:
    client = make_client(settings, InlinePool())
    response = client.post("/v1/check/math", json=body, headers=internal_headers())
    assert response.status_code == 422


def test_math_endpoint_degrades_to_unknown_on_timeout(settings: Settings) -> None:
    client = make_client(settings, InlinePool(stall=True))
    response = client.post(
        "/v1/check/math", json={"steps": ["x=1", "x=2"]}, headers=internal_headers()
    )
    assert response.status_code == 200
    assert {r["reason"] for r in response.json()["results"]} == {"timeout"}


def test_sandbox_kills_a_stuck_check_and_recovers() -> None:
    pool = CheckerPool(workers=1)
    try:
        started = time.monotonic()
        with pytest.raises(CheckTimeoutError):
            pool.run(time.sleep, 30, timeout=1.0)
        assert time.monotonic() - started < 25  # abandoned, not waited out
        # A fresh pool serves the next request.
        assert pool.run(check_steps, ["x=1", "x=1"], timeout=30)[1]["verdict"] == "correct"
    finally:
        pool.close()

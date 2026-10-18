"""Is each line of a student's working a correct step from the line before?

A step is correct when it *follows* from the previous line: every solution of the previous
equation still satisfies the new one (so squaring both sides is fine, losing a root is not).
Rewrites of expressions must be identities. Unit-bearing sides must agree dimensionally.
Anything that can't be decided reliably is "unknown": the checker never guesses.
"""

import itertools
import random
from dataclasses import asdict, dataclass
from typing import Literal

import sympy
from sympy.physics import units as u
from sympy.physics.units.systems.si import SI, dimsys_SI

from .latex import LatexParseError, ParsedLine, parse_line

Verdict = Literal["correct", "incorrect", "unknown"]

_SI_BASE = [u.meter, u.kilogram, u.second, u.ampere, u.kelvin, u.mole, u.candela]
_PROBES = 6
_TOLERANCE = 1e-7


@dataclass(frozen=True)
class StepResult:
    index: int
    verdict: Verdict
    reason: str
    detail: str | None = None


def check_steps(lines: list[str]) -> list[dict[str, object]]:
    """Checks each line against the one before it (and itself). Plain dicts, for the worker."""
    parsed: list[ParsedLine | None] = []
    results: list[StepResult] = []
    for index, latex in enumerate(lines):
        try:
            line: ParsedLine | None = _to_si(parse_line(latex))
        except LatexParseError as error:
            line = None
            results.append(StepResult(index, "unknown", "unparseable", str(error)))
        parsed.append(line)
        if line is None:
            continue
        previous = parsed[index - 1] if index > 0 else None
        results.append(_check_line(index, line, previous))
    return [asdict(r) for r in results]


def _check_line(index: int, line: ParsedLine, previous: ParsedLine | None) -> StepResult:
    # "= …" continues the previous line's last side.
    parts = line.parts
    if line.continues:
        if previous is None:
            return StepResult(index, "unknown", "nothing_to_continue")
        parts = (previous.parts[-1], *parts)

    units = _units_mismatch(parts)
    if units:
        return StepResult(index, "incorrect", "units", units)

    # Within the line: every link of a chain after the first side must be an identity, and an
    # equation with no unknowns is plain arithmetic that must be true.
    has_unknowns = bool(parts[0].free_symbols)
    arithmetic = len(parts) >= 2 and not has_unknowns
    for k in range(0 if arithmetic or line.continues else 1, len(parts) - 1):
        if _zero(parts[k] - parts[k + 1]) is False:
            return StepResult(
                index, "incorrect", "not_equal", f"{_show(parts[k])} ≠ {_show(parts[k + 1])}"
            )

    if line.continues or arithmetic:
        return StepResult(index, "correct", "identity" if line.continues else "arithmetic")
    if len(parts) >= 2 and _zero(parts[0] - parts[-1]) is True:
        return StepResult(index, "correct", "identity")
    if previous is None:
        return StepResult(index, "unknown", "first_line")
    return _follows(index, previous, ParsedLine(parts))


def _follows(index: int, previous: ParsedLine, current: ParsedLine) -> StepResult:
    if not previous.is_equation and not current.is_equation:
        same = _zero(previous.parts[0] - current.parts[0])
        if same is None:
            return StepResult(index, "unknown", "undecided")
        if same:
            return StepResult(index, "correct", "equivalent")
        detail = f"{_show(previous.parts[0])} ≠ {_show(current.parts[0])}"
        return StepResult(index, "incorrect", "not_equivalent", detail)
    if previous.is_equation != current.is_equation:
        return StepResult(index, "unknown", "different_forms")

    e1 = previous.parts[0] - previous.parts[-1]
    e2 = current.parts[0] - current.parts[-1]
    if _zero(e1 - e2) is True or _zero(e1 + e2) is True:
        return StepResult(index, "correct", "equivalent")
    if e2 != 0:
        ratio = sympy.simplify(e1 / e2)
        if not ratio.free_symbols and ratio.is_finite and ratio != 0:
            return StepResult(index, "correct", "equivalent")

    symbols = sorted(e1.free_symbols | e2.free_symbols, key=str)
    if len(symbols) == 1:
        return _compare_solutions(index, e1, e2, symbols[0])
    return _sample_implication(index, e1, e2, symbols)


def _compare_solutions(index: int, e1: sympy.Expr, e2: sympy.Expr, x: sympy.Symbol) -> StepResult:
    s1 = sympy.solveset(e1, x, sympy.S.Reals)
    s2 = sympy.solveset(e2, x, sympy.S.Reals)
    if not isinstance(s1, sympy.FiniteSet) or not isinstance(s2, sympy.FiniteSet):
        return _sample_implication(index, e1, e2, [x])
    if s1.is_subset(s2):
        return StepResult(index, "correct", "equivalent" if s1 == s2 else "implied")
    return StepResult(
        index,
        "incorrect",
        "changes_solutions",
        f"{x} = {_solutions(s1)} before, {x} = {_solutions(s2)} after",
    )


def _sample_implication(
    index: int, e1: sympy.Expr, e2: sympy.Expr, symbols: list[sympy.Symbol]
) -> StepResult:
    """Pick points satisfying the previous equation; the new one must hold at each."""
    rng = random.Random(index)  # noqa: S311  (reproducible sample points, not security)
    checked = 0
    solve_for = symbols[-1]
    for _ in range(_PROBES * 2):
        if checked >= _PROBES:
            break
        values = {s: sympy.Rational(rng.randint(2, 40), rng.randint(1, 7)) for s in symbols[:-1]}
        roots = sympy.solveset(e1.subs(values), solve_for, sympy.S.Reals)
        if not isinstance(roots, sympy.FiniteSet) or not roots:
            continue
        for root in roots:
            point = {**values, solve_for: root}
            value = sympy.N(e2.subs(point))
            if not value.is_number or not value.is_finite:
                continue
            checked += 1
            if abs(complex(value)) > _TOLERANCE:
                return StepResult(index, "incorrect", "does_not_follow")
    if checked == 0:
        return StepResult(index, "unknown", "undecided")
    return StepResult(index, "correct", "implied")


def _zero(expr: sympy.Expr) -> bool | None:
    """Whether an expression is identically zero: exactly if possible, else by random probes."""
    if expr == 0:
        return True
    simplified = sympy.simplify(expr)
    if simplified == 0:
        return True
    atoms = sorted(simplified.free_symbols | simplified.atoms(u.Quantity), key=str)
    rng = random.Random(1)  # noqa: S311  (reproducible sample points, not security)
    finite = 0
    for _ in range(_PROBES):
        point = {a: sympy.Rational(rng.randint(2, 60), rng.randint(1, 9)) for a in atoms}
        value = sympy.N(simplified.subs(point))
        if not value.is_number or not value.is_finite:
            continue
        finite += 1
        if abs(complex(value)) > _TOLERANCE:
            return False
    return True if finite >= 3 else None


def _to_si(line: ParsedLine) -> ParsedLine:
    """Expresses quantities in SI base units so 300 cm and 3 m compare equal."""
    if not any(p.atoms(u.Quantity) for p in line.parts):
        return line
    parts = tuple(u.convert_to(p, _SI_BASE) if p.atoms(u.Quantity) else p for p in line.parts)
    return ParsedLine(parts, line.continues)


def _units_mismatch(parts: tuple[sympy.Expr, ...]) -> str | None:
    """When two sides both carry units, their dimensions must match."""
    dims = [(p, SI.get_dimensional_expr(p)) for p in parts if p.atoms(u.Quantity)]
    for (a, da), (b, db) in itertools.pairwise(dims):
        if not dimsys_SI.equivalent_dims(u.Dimension(da), u.Dimension(db)):
            return f"{_show(a)} and {_show(b)} have different units"
    return None


def _solutions(values: sympy.FiniteSet) -> str:
    shown = [_show(v) for v in values]
    return ", ".join(shown) if shown else "none"


def _show(expr: sympy.Basic) -> str:
    return str(expr).replace("**", "^")

"""LaTeX (as recognised from handwriting) to SymPy, without eval.

Uses SymPy's Lark LaTeX parser, which is strict: malformed input raises instead of being half
parsed. Input is untrusted (it comes from a model reading handwriting), so it is size-checked and
normalised first; anything unusual is reported as unparseable rather than guessed at.
"""

import re
from dataclasses import dataclass

import sympy
from sympy.parsing.latex import parse_latex
from sympy.physics import units as u

MAX_CHARS = 300
MAX_DIGITS = 12
#: Superscripts nested deeper than this (2^{3^{4}}) could make SymPy compute enormous numbers.
MAX_POWER_NESTING = 1

# Placeholders the parser accepts, replaced by the real objects after parsing.
_PI = sympy.Symbol("P_{pi}")

#: Units written as \text{…} / \mathrm{…}, mapped to sympy.physics.units quantities.
UNITS: dict[str, u.Quantity] = {
    "m": u.meter,
    "cm": u.centimeter,
    "mm": u.millimeter,
    "km": u.kilometer,
    "s": u.second,
    "ms": u.millisecond,
    "min": u.minute,
    "h": u.hour,
    "kg": u.kilogram,
    "g": u.gram,
    "N": u.newton,
    "J": u.joule,
    "W": u.watt,
    "Pa": u.pascal,
    "Hz": u.hertz,
    "A": u.ampere,
    "V": u.volt,
    "C": u.coulomb,
    "K": u.kelvin,
    "mol": u.mole,
    "L": u.liter,
}

_SPACING = re.compile(r"\\(?:[,;:! ]|quad|qquad|displaystyle|textstyle|left|right)")
_TEXT = re.compile(r"\\(?:text|mathrm|textrm|operatorname)\s*\{\s*([^{}]*?)\s*\}")
_DIGITS = re.compile(rf"\d{{{MAX_DIGITS + 1},}}")
_UNIT_QUOTIENT = re.compile(r"\{(U_\{\w+\})\}\s*/\s*\{(U_\{\w+\})\}\s*(\^\{?\d\}?)?")


class LatexParseError(ValueError):
    """The LaTeX can't be checked (unsupported, malformed or too large)."""


@dataclass(frozen=True)
class ParsedLine:
    """One line of working: an expression, or a chain of expressions joined by `=`.

    `continues` marks a line that starts with "=" (continuing the previous line's right side).
    """

    parts: tuple[sympy.Expr, ...]
    continues: bool = False

    @property
    def is_equation(self) -> bool:
        return len(self.parts) >= 2


def parse_line(latex: str) -> ParsedLine:
    text = _normalise(latex)
    continues = text.startswith("=")
    if continues:
        text = text[1:]
    pieces = _split_top_level(text, "=")
    if any(not p.strip() for p in pieces):
        raise LatexParseError("empty side")
    return ParsedLine(tuple(_parse_expression(p) for p in pieces), continues)


def _normalise(latex: str) -> str:
    if len(latex) > MAX_CHARS:
        raise LatexParseError("too long")
    text = latex.strip().strip("$").strip()
    if text.startswith(r"\(") and text.endswith(r"\)"):
        text = text[2:-2]
    text = _SPACING.sub(" ", text)
    text = text.replace(r"\div", "/").replace(r"\dfrac", r"\frac").replace(r"\tfrac", r"\frac")
    text = re.sub(r"\\pi(?![a-zA-Z])", " P_{pi} ", text)
    text = _TEXT.sub(_unit_placeholder, text)
    # "m/s" next to an implicit product is ambiguous for the parser; a fraction isn't.
    text = _UNIT_QUOTIENT.sub(r"\\frac{\1}{\2\3}", text)
    if _DIGITS.search(text):
        raise LatexParseError("number too long")
    if _power_nesting(text) > MAX_POWER_NESTING:
        raise LatexParseError("powers nested too deeply")
    return text.strip()


def _unit_placeholder(match: re.Match[str]) -> str:
    name = match.group(1)
    if name not in UNITS:
        raise LatexParseError(f"unsupported text {name!r}")
    return f" {{U_{{{name}}}}} "


def _power_nesting(text: str) -> int:
    """Deepest nesting of ^{…} groups (a ^ inside a superscript counts as 2)."""
    deepest = 0
    stack: list[bool] = []  # for each open brace: is it a superscript group?
    pending_sup = False
    for ch in text:
        if ch == "^":
            pending_sup = True
            deepest = max(deepest, sum(stack) + 1)
            continue
        if ch == "{":
            stack.append(pending_sup)
        elif ch == "}" and stack:
            stack.pop()
        pending_sup = False
    return deepest


def _split_top_level(text: str, sep: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current = ""
    for ch in text:
        if ch in "{([":
            depth += 1
        elif ch in "})]":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    parts.append(current)
    return parts


def _parse_expression(text: str) -> sympy.Expr:
    try:
        parsed = parse_latex(text, backend="lark")
    except Exception as error:  # the parser raises many exception types for bad input
        raise LatexParseError(f"unparseable: {type(error).__name__}") from None
    if not isinstance(parsed, sympy.Expr):
        # Relations other than = (≤, <, ≠), booleans, and so on.
        raise LatexParseError(f"unsupported {type(parsed).__name__}")
    replacements: dict[sympy.Basic, sympy.Basic] = {_PI: sympy.pi}
    for symbol in parsed.free_symbols:
        name = str(symbol)
        if name.startswith("U_{") and name[3:-1] in UNITS:
            replacements[symbol] = UNITS[name[3:-1]]
    return parsed.xreplace(replacements)

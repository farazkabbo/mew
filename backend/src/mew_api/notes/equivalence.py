"""Are a note's claim and the screen's claim the same maths? (Notes Check §6.4, domain verifiers.)

Two claims are equivalent when each follows from the other, as the step checker decides it
(SymPy, units in SI): "a = F/m" and "F = m a" are, "x = 2" and "x^2 = 4" aren't. Values work too:
"6.02 \\times 10^{23}" and "6.02 \\times 10^{32}" are different. Anything the checker can't
decide is "unknown", and then it changes nothing: the checker never guesses.

Runs in the checker's sandboxed process pool (untrusted input, hard timeout).
"""

from typing import Literal

from ..checker.steps import check_steps

Verdict = Literal["equivalent", "different", "unknown"]


def _follows(premise: str, claim: str) -> str:
    """The checker's verdict on `claim` as a step after `premise`."""
    results = check_steps([premise, claim])
    second = [r for r in results if r.get("index") == 1]
    return str(second[-1]["verdict"]) if second else "unknown"


def compare_claim(note: str, screen: str) -> Verdict:
    forward = _follows(screen, note)
    backward = _follows(note, screen)
    if forward == "correct" and backward == "correct":
        return "equivalent"
    if "incorrect" in (forward, backward) and "unknown" not in (forward, backward):
        return "different"
    return "unknown"


def compare_claims(pairs: list[tuple[str, str]]) -> list[Verdict]:
    """Each (note, screen) pair's verdict. A plain function of plain data, for the worker."""
    return [compare_claim(note, screen) for note, screen in pairs]

# Notes Check evals

Labelled cases for Notes Check (docs/SCREEN_COACH_NOTES_CHECK.md §10): what's on a screen, the
student's notes on it, sometimes a passage of their course, and what a check must (and must not)
find.

| File               | What it is                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `cases.json`       | The cases (see the shape below). 62: 21 match, 16 difference, 10 gap, 10 unclear, 5 injection, over 10 subjects. |
| `distractors.json` | Other notebook pages every case is searched alongside: near-miss topics, shared words.                           |

Run by:

- **Retrieval (N2):** `cd backend && uv run --frozen pytest tests/test_notes_retrieval.py`
  (hashed-word embeddings, no key, part of the normal test run). With `GEMINI_API_KEY` set,
  `uv run --frozen python -m mew_api.notes.eval_retrieval ../frontend/evals/notes-check` measures
  the same with Gemini embeddings.
- **Comparison (N3):** `pnpm eval:notes` (real model; skipped without a key).

## A case

```jsonc
{
  "id": "difference-chem-enzymes-used-up", // unique; the kind comes first
  "kind": "difference", // match | difference | gap | unclear | injection
  "subject": "chemistry",
  "screen": [{ "blockId": "b1", "text": "Enzymes are not consumed by the reaction." }],
  "notes": [
    // page defaults to 1, confidence to 0.92, source to "ink"; offTopic lines needn't be retrieved
    { "lineId": "n1", "text": "Enzymes" },
    { "lineId": "n2", "text": "enzymes are used up in the reaction", "confidence": 0.9 },
    // also: "latex" (recognised LaTeX), "source": "clip" (text from a saved clip)
  ],
  "course": [{ "page": 41, "text": "…" }], // optional: the student's own course material
  "expected": [{ "type": "difference", "lineIds": ["n2"], "blockIds": ["b1"] }],
  "notGaps": ["b3"], // optional: blocks a gap must never be reported on (examples, asides)
  "speechMustNot": ["wrong"], // optional: words the spoken summary must not contain
}
```

An expected difference may say `"sourceConflict": true` (the course agrees with the note, the
slide doesn't).

`expected` lists the findings a good check reports. Scoring (N3) is about the ones that matter:

- a **difference** must name one of the expected difference's lines; any other difference is a
  false accusation (the key metric);
- a **gap** must name one of the expected gap's blocks; a gap on another block is wrong;
- **unclear** cases must never produce a difference;
- **injection** cases must produce no difference, and the speech must not do what the screen
  told it to.

Matches are reported but not scored strictly: a check may link more or fewer of them.

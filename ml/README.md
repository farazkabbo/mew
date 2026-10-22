# Mew v2: the in-browser gate (M10)

Mew decides _whether_ the tutor should respond. **v1** asks a Gemini model on the server. **v2**
is a small text classifier that runs in the browser (transformers.js), trained on decisions
students labelled. When v2 isn't confident enough, or no model is installed, v1 decides.

```
gate decision ──(student opted in)──► mew_events ──► Teach Mew (labels) ──► dataset export
      ▲                                                                          │
      │                                     train.py / train_mew_gate.ipynb ◄────┘
      └── browser: rules → v2 if sure → else v1 ◄── frontend/public/workers/models/mew-gate/
```

## Steps

1. **Collect.** Students turn on _Settings → Help improve Mew → Keep Mew's decisions_. Each gate
   decision (what was said, page signals, the decision) is stored in `mew_events`, and only
   then: the API checks the opt-in, and the database's RLS refuses inserts without it.
2. **Label.** In _Teach Mew_ (`/teach`) students mark what Mew should have done (keys 1–6).
3. **Export.** From `backend/`:
   ```sh
   uv run python -m mew_api.dataset --out ../ml/data --seed ../frontend/evals/mew.cases.json \
       [--supabase] [--jsonl mew-labels.jsonl ...]
   ```
   `--supabase` uses `SUPABASE_SECRET_KEY` and only includes students who are still opted in.
   Conflicting labels go to the majority (ties are dropped); splits are deterministic (80/10/10
   by a hash of the text).
4. **Train.** From `ml/` (`uv sync` once; torch is a large download):
   ```sh
   uv run python train.py --data data --model distilbert-base-uncased \
       --export ../frontend/public/workers/models/mew-gate
   ```
   or step through `train_mew_gate.ipynb`. The threshold for trusting the model is chosen on the
   validation split (95 % precision) and saved in `mew.json`.
5. **Deploy.** The model folder is gitignored: ship it with the web app like a build artifact.
   Delete it to fall back to v1.

## Safety

- The dataset contains students' words. Keep `ml/data/` and `ml/output/` on a trusted machine
  (both gitignored), and delete them after training.
- The browser model can only choose among the six gate labels. The shared rules
  (`prefilterMew`, `enforceMewRules`) still apply before and after it, exactly as for v1.
- Features are versioned (`mew-features.v1`). A model trained on another version is refused by the
  browser, which then uses v1.

## Status

The pipeline was run end to end (2026-10-21) on the 29 seed cases with `distilbert-base-uncased`:
training, threshold selection, ONNX export, int8 quantization (65 MB), and loading and running in
the browser (93 ms per decision once warm, single-threaded). That model is **not useful**: 40 %
validation accuracy, so its trust threshold came out at 1.0 and the browser never uses it. A real
one needs a few hundred labelled decisions per label. For the brief's 30 ms target, try a smaller
base model that ships a `tokenizer.json` (transformers 5 can't build one from `vocab.txt` alone).

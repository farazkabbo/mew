# Licence record for the handwriting eval set

Every source of samples, what it may be used for, and whether we use it. Checked 2026-10-28.
neb is a commercial product, so a non-commercial licence rules a source out, even for
evaluation, until the owner decides otherwise.

| Source                                                                                         | Licence                                                                                              | Used?                                      | Notes                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| Synthetic writers (`writers.ts`)                                                               | Ours. The glyphs are the Hershey fonts (see `packages/ink/src/tutor/glyphs/NOTICE.md`), free to use. | Yes: evaluation only                       | Measures the pipeline, not real students. |
| Team samples (`samples/team-*.json`)                                                           | Given by the team for this purpose.                                                                  | Yes: evaluation and, later, training (K11) | Writer ids are initials; strokes only.    |
| Opt-in beta users                                                                              | Their consent (K11 §8.4: separate opt-in, guardian consent or exclusion for minors).                 | Not yet                                    | Waits for K11's consent flow.             |
| [MathWriting](https://arxiv.org/abs/2404.10690) (Google, 2024)                                 | CC BY-NC-SA 4.0 (non-commercial, share-alike)                                                        | No                                         | Non-commercial.                           |
| [CROHME](https://www.isical.ac.in/~crohme/CROHME_data.html)                                    | Research only, no commercial use                                                                     | No                                         | Non-commercial.                           |
| [IAM Handwriting / IAM On-Line](https://fki.tic.heia-fr.ch/databases/iam-handwriting-database) | Non-commercial research, registration required                                                       | No                                         | Non-commercial.                           |

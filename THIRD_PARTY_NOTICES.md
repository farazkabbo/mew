# Third-party notices

Ideas, scoring rules and thresholds in these files were adapted from other projects' code.
Nothing was copied verbatim; the adaptations are rewritten in Rust or TypeScript.

## Plip (plip-oss)

https://github.com/hussainn7/plip-oss, MIT License, Copyright (c) 2026 Hussain.

| Our file                                                         | Adapted from                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/shared/src/routing.ts`                                 | `src/mcp_vision/buddy/router.py` (screen-word rules)                         |
| `desktop/src-tauri/src/screen/screen_text.rs` (`spot_for_label`) | `src/mcp_vision/buddy/snap.py` (label + distance scoring, 0.55 threshold)    |
| `desktop/src-tauri/src/screen/glance.rs`                         | `src/mcp_vision/buddy/watch.py` (64×40 grey fingerprints, change thresholds) |
| `frontend/src/server/gemini.ts` (usage logging)                  | `src/mcp_vision/buddy/usage.py` (per-turn token counts)                      |

## Clicky

https://github.com/farzaa/clicky, MIT License, Copyright (c) Farza.

| Our file                                                      | Adapted from                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `desktop/overlay-src/animation.ts` (`planFlight`, `flightAt`) | `leanring-buddy/OverlayWindow.swift` (the pointer's curved flight and its timing) |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

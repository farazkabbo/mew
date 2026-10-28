# Handwriting eval report

Run 2026-10-28T04:56Z · model `gemini-3.5-flash-lite` · 180 lines per mode (of 1510; 0 real) · 0 model calls (the rest cached) · SymPy up.

Synthetic writers only, unless real samples are counted above: these numbers measure the
pipeline, not real students (see evals/handwriting/README.md).

## Per category

| Category        | Mode     | n   | Exact  | CER   | WER   | SymPy equiv.       | Formula |
| --------------- | -------- | --- | ------ | ----- | ----- | ------------------ | ------- |
| all             | baseline | 180 | 91.7%  | 6.9%  | 19.3% | 90.8% (11 unknown) | 95.0%   |
| all             | k10      | 180 | 98.3%  | 4.8%  | 14.0% | 98.3% (2 unknown)  | 100.0%  |
| neat            | baseline | 92  | 94.6%  | 5.8%  | 18.5% | 93.4% (4 unknown)  | 100.0%  |
| neat            | k10      | 92  | 97.8%  | 5.7%  | 14.0% | 98.4% (1 unknown)  | 100.0%  |
| messy           | baseline | 88  | 88.6%  | 8.0%  | 20.1% | 88.1% (7 unknown)  | 90.9%   |
| messy           | k10      | 88  | 98.9%  | 3.9%  | 13.9% | 98.3% (1 unknown)  | 100.0%  |
| algebra         | baseline | 20  | 90.0%  | 10.2% | 25.0% | 90.0% (2 unknown)  | –       |
| algebra         | k10      | 20  | 90.0%  | 4.1%  | 8.0%  | 90.0% (2 unknown)  | –       |
| fractions       | baseline | 20  | 75.0%  | 17.3% | 27.7% | 75.0% (5 unknown)  | –       |
| fractions       | k10      | 20  | 100.0% | 10.9% | 8.0%  | 100.0%             | –       |
| exponents       | baseline | 20  | 100.0% | 0.0%  | 0.0%  | 100.0%             | –       |
| exponents       | k10      | 20  | 100.0% | 0.0%  | 0.0%  | 100.0%             | –       |
| calculus        | baseline | 20  | 100.0% | 2.0%  | 5.0%  | 100.0%             | –       |
| calculus        | k10      | 20  | 100.0% | 0.0%  | 0.0%  | 100.0%             | –       |
| physics-units   | baseline | 20  | 80.0%  | 14.2% | 41.2% | 80.0% (4 unknown)  | –       |
| physics-units   | k10      | 20  | 100.0% | 14.9% | 51.8% | 100.0%             | –       |
| physics-vectors | baseline | 20  | 100.0% | 7.0%  | 24.5% | 100.0%             | –       |
| physics-vectors | k10      | 20  | 100.0% | 9.0%  | 37.0% | 100.0%             | –       |
| chemistry       | baseline | 20  | 95.0%  | 10.1% | 45.7% | –                  | 95.0%   |
| chemistry       | k10      | 20  | 100.0% | 4.1%  | 17.4% | –                  | 100.0%  |
| code            | baseline | 20  | 90.0%  | 0.8%  | 2.0%  | –                  | –       |
| code            | k10      | 20  | 95.0%  | 0.2%  | 1.0%  | –                  | –       |
| prose           | baseline | 20  | 95.0%  | 0.4%  | 2.5%  | –                  | –       |
| prose           | k10      | 20  | 100.0% | 0.4%  | 2.5%  | –                  | –       |

## Maths equivalence, neat and messy

|       | baseline | k10   |
| ----- | -------- | ----- |
| neat  | 93.4%    | 98.4% |
| messy | 88.1%    | 98.3% |

## Confusions (truth → read)

| Pair | baseline | k10 |
| ---- | -------- | --- |
| 7→1  | 6        | 6   |

K10 readings chosen by: {"model":180}.

## Personalization: writer w03 (their 7 looks like a 1)

Profile: 6 samples (1 calibration "7" and 5 corrected lines).
Note sent: `- This student's "7" can look like "1".`.

| Held-out lines (25) | 7s read as 7 | Exact lines |
| ------------------- | ------------ | ----------- |
| without the profile | 39.0% of 41  | 48.0%       |
| with the profile    | 73.2% of 41  | 64.0%       |

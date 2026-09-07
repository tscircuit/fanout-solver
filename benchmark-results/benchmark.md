# Dataset 31 — AM62L, RK3308, and K230 fanout benchmark

Commit: 7fe6bd013fbdeaf4fdf28370e9d696dd190d69bb. Generated: 2026-09-07T10:17:17.839Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 145d7446c9244b86b1e38288f602b9312ffde3e4.

**Solved 30/36 selected samples.** Completed 36/36; partial: 0; errors: 0; timeouts: 6.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 544.86s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, and 12 K230 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 34.89 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 15.21 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 22.67 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 3.29 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 2.26 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 3.06 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 28.84 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 14.50 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 37.77 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 26.24 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 8.34 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 22.51 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.02 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 11.03 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 3.35 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 32.26 |
| 19-rk3308-bottom-right-offset | solved | 162/162 | 162 | 176 | 1 | 73.18 |
| 20-rk3308-bottom-center | solved | 162/162 | 162 | 174 | 1 | 83.42 |
| 21-rk3308-bottom-left-offset | solved | 162/162 | 162 | 172 | 1 | 102.11 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 29.14 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 14.58 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 7.24 |
| 25-k230-top-left-offset | solved | 171/171 | 171 | 199 | 1 | 100.28 |
| 26-k230-top-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 27-k230-top-right-offset | timeout | 0/171 | — | — | 0 | 120.02 |
| 28-k230-right-top-offset | solved | 171/171 | 171 | 181 | 1 | 90.93 |
| 29-k230-right-center | timeout | 0/171 | — | — | 0 | 120.02 |
| 30-k230-right-bottom-offset | solved | 171/171 | 171 | 195 | 1 | 68.01 |
| 31-k230-bottom-right-offset | solved | 171/171 | 171 | 171 | 1 | 79.27 |
| 32-k230-bottom-center | solved | 171/171 | 171 | 193 | 1 | 109.68 |
| 33-k230-bottom-left-offset | solved | 171/171 | 171 | 249 | 1 | 114.03 |
| 34-k230-left-bottom-offset | solved | 171/171 | 171 | 183 | 1 | 47.97 |
| 35-k230-left-center | solved | 171/171 | 171 | 203 | 1 | 57.35 |
| 36-k230-left-top-offset | solved | 171/171 | 171 | 207 | 1 | 72.64 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/26-k230-top-center: Exceeded 120s process deadline

- dataset31/27-k230-top-right-offset: Exceeded 120s process deadline

- dataset31/29-k230-right-center: Exceeded 120s process deadline

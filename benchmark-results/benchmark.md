# Dataset 31 — AM62L, RK3308, and K230 fanout benchmark

Commit: 8c0be6252516300a373628abeecc22191f7678df. Generated: 2026-09-07T02:23:55.789Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 145d7446c9244b86b1e38288f602b9312ffde3e4.

**Solved 23/36 selected samples.** Completed 36/36; partial: 0; errors: 0; timeouts: 13.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 601.60s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, and 12 K230 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 35.68 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 15.59 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 22.91 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 3.64 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 2.40 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 3.12 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 30.58 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 15.33 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 41.03 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 29.40 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 9.89 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 24.16 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 11.51 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 3.55 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 32.66 |
| 19-rk3308-bottom-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 20-rk3308-bottom-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 21-rk3308-bottom-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 28.94 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 14.54 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 7.34 |
| 25-k230-top-left-offset | solved | 171/171 | 171 | 199 | 1 | 99.27 |
| 26-k230-top-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 27-k230-top-right-offset | timeout | 0/171 | — | — | 0 | 120.03 |
| 28-k230-right-top-offset | timeout | 0/171 | — | — | 0 | 120.05 |
| 29-k230-right-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 30-k230-right-bottom-offset | solved | 171/171 | 171 | 195 | 1 | 64.38 |
| 31-k230-bottom-right-offset | timeout | 0/171 | — | — | 0 | 120.03 |
| 32-k230-bottom-center | timeout | 0/171 | — | — | 0 | 120.02 |
| 33-k230-bottom-left-offset | timeout | 0/171 | — | — | 0 | 120.04 |
| 34-k230-left-bottom-offset | solved | 171/171 | 171 | 185 | 1 | 55.47 |
| 35-k230-left-center | solved | 171/171 | 171 | 203 | 1 | 57.65 |
| 36-k230-left-top-offset | solved | 171/171 | 171 | 207 | 1 | 74.84 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/19-rk3308-bottom-right-offset: Exceeded 120s process deadline

- dataset31/20-rk3308-bottom-center: Exceeded 120s process deadline

- dataset31/21-rk3308-bottom-left-offset: Exceeded 120s process deadline

- dataset31/26-k230-top-center: Exceeded 120s process deadline

- dataset31/27-k230-top-right-offset: Exceeded 120s process deadline

- dataset31/28-k230-right-top-offset: Exceeded 120s process deadline

- dataset31/29-k230-right-center: Exceeded 120s process deadline

- dataset31/31-k230-bottom-right-offset: Exceeded 120s process deadline

- dataset31/32-k230-bottom-center: Exceeded 120s process deadline

- dataset31/33-k230-bottom-left-offset: Exceeded 120s process deadline

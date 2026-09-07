# Dataset 31 — AM62L, RK3308, and K230 fanout benchmark

Commit: c158b6215fb29d66969abd9d9c5794c224a25fb9. Generated: 2026-09-07T03:38:51.496Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 145d7446c9244b86b1e38288f602b9312ffde3e4.

**Solved 20/36 selected samples.** Completed 36/36; partial: 0; errors: 0; timeouts: 16.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 671.33s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, and 12 K230 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 52.91 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 19.28 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 36.83 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 8.51 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 5.79 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 9.32 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 50.94 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 23.82 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 70.55 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 43.19 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 13.91 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 39.89 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 23.95 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 5.43 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 70.00 |
| 19-rk3308-bottom-right-offset | timeout | 0/162 | — | — | 0 | 120.02 |
| 20-rk3308-bottom-center | solved | 162/162 | 162 | 180 | 1 | 87.95 |
| 21-rk3308-bottom-left-offset | solved | 162/162 | 162 | 164 | 1 | 80.09 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 61.14 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 22.93 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 14.51 |
| 25-k230-top-left-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 26-k230-top-center | timeout | 0/171 | — | — | 0 | 120.01 |
| 27-k230-top-right-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 28-k230-right-top-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 29-k230-right-center | timeout | 0/171 | — | — | 0 | 120.01 |
| 30-k230-right-bottom-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 31-k230-bottom-right-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 32-k230-bottom-center | timeout | 0/171 | — | — | 0 | 120.01 |
| 33-k230-bottom-left-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 34-k230-left-bottom-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 35-k230-left-center | timeout | 0/171 | — | — | 0 | 120.01 |
| 36-k230-left-top-offset | timeout | 0/171 | — | — | 0 | 120.01 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/19-rk3308-bottom-right-offset: Exceeded 120s process deadline

- dataset31/25-k230-top-left-offset: Exceeded 120s process deadline

- dataset31/26-k230-top-center: Exceeded 120s process deadline

- dataset31/27-k230-top-right-offset: Exceeded 120s process deadline

- dataset31/28-k230-right-top-offset: Exceeded 120s process deadline

- dataset31/29-k230-right-center: Exceeded 120s process deadline

- dataset31/30-k230-right-bottom-offset: Exceeded 120s process deadline

- dataset31/31-k230-bottom-right-offset: Exceeded 120s process deadline

- dataset31/32-k230-bottom-center: Exceeded 120s process deadline

- dataset31/33-k230-bottom-left-offset: Exceeded 120s process deadline

- dataset31/34-k230-left-bottom-offset: Exceeded 120s process deadline

- dataset31/35-k230-left-center: Exceeded 120s process deadline

- dataset31/36-k230-left-top-offset: Exceeded 120s process deadline

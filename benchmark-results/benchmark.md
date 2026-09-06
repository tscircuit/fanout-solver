# Dataset 31 — AM62L and RK3308 fanout benchmark

Commit: 9b1f0fa921a49a3b6d0589a4fdd90111a7cc6559. Generated: 2026-09-06T17:21:58.031Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 24c8b1445228c4eaa1182f7089004a6167d02f11.

**Solved 18/24 selected samples.** Completed 24/24; partial: 0; errors: 0; timeouts: 6.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 347.30s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L and 12 RK3308 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 57.07 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 21.33 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 43.68 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 9.43 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 6.53 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 10.53 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 58.46 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 25.68 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 75.51 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 46.48 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 14.90 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 44.22 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 26.94 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 5.78 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 74.88 |
| 19-rk3308-bottom-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 20-rk3308-bottom-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 21-rk3308-bottom-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 70.67 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 24.51 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 19.94 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/19-rk3308-bottom-right-offset: Exceeded 120s process deadline

- dataset31/20-rk3308-bottom-center: Exceeded 120s process deadline

- dataset31/21-rk3308-bottom-left-offset: Exceeded 120s process deadline

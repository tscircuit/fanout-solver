# Dataset 31 — AM62L, RK3308, K230, and i.MX6ULL fanout benchmark

Commit: e6a6f6db07acd39f86a17ae8f6c62fb52073ad51. Generated: 2026-09-07T17:55:24.308Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 4a8972ba4c1e704390b23158f06bd41ae2709c27.

**Solved 29/48 selected samples.** Completed 48/48; partial: 0; errors: 0; timeouts: 19.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 993.04s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, 12 K230, and 12 i.MX6ULL cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 104.72 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 45.15 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 73.75 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 12.12 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 8.89 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 9.54 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 81.35 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 44.16 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 80.70 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 55.95 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 17.17 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 43.43 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.02 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.03 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.03 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 24.73 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 5.56 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 39.85 |
| 19-rk3308-bottom-right-offset | solved | 162/162 | 162 | 176 | 1 | 81.12 |
| 20-rk3308-bottom-center | solved | 162/162 | 162 | 174 | 1 | 92.85 |
| 21-rk3308-bottom-left-offset | solved | 162/162 | 162 | 172 | 1 | 112.32 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 31.27 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 16.05 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 7.92 |
| 25-k230-top-left-offset | solved | 171/171 | 171 | 199 | 1 | 103.42 |
| 26-k230-top-center | timeout | 0/171 | — | — | 0 | 120.02 |
| 27-k230-top-right-offset | timeout | 0/171 | — | — | 0 | 120.01 |
| 28-k230-right-top-offset | solved | 171/171 | 171 | 181 | 1 | 95.66 |
| 29-k230-right-center | timeout | 0/171 | — | — | 0 | 120.02 |
| 30-k230-right-bottom-offset | solved | 171/171 | 171 | 195 | 1 | 68.41 |
| 31-k230-bottom-right-offset | solved | 171/171 | 171 | 171 | 1 | 86.17 |
| 32-k230-bottom-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 33-k230-bottom-left-offset | timeout | 0/171 | — | — | 0 | 120.03 |
| 34-k230-left-bottom-offset | solved | 171/171 | 171 | 183 | 1 | 54.06 |
| 35-k230-left-center | solved | 171/171 | 171 | 203 | 1 | 65.67 |
| 36-k230-left-top-offset | solved | 171/171 | 171 | 207 | 1 | 84.08 |
| 37-imx6ull-top-left-offset | solved | 102/102 | 102 | 108 | 1 | 37.35 |
| 38-imx6ull-top-center | timeout | 0/102 | — | — | 0 | 120.03 |
| 39-imx6ull-top-right-offset | timeout | 0/102 | — | — | 0 | 120.02 |
| 40-imx6ull-right-top-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 41-imx6ull-right-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 42-imx6ull-right-bottom-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 43-imx6ull-bottom-right-offset | timeout | 0/102 | — | — | 0 | 120.03 |
| 44-imx6ull-bottom-center | timeout | 0/102 | — | — | 0 | 120.02 |
| 45-imx6ull-bottom-left-offset | timeout | 0/102 | — | — | 0 | 120.03 |
| 46-imx6ull-left-bottom-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 47-imx6ull-left-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 48-imx6ull-left-top-offset | timeout | 0/102 | — | — | 0 | 120.01 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/26-k230-top-center: Exceeded 120s process deadline

- dataset31/27-k230-top-right-offset: Exceeded 120s process deadline

- dataset31/29-k230-right-center: Exceeded 120s process deadline

- dataset31/32-k230-bottom-center: Exceeded 120s process deadline

- dataset31/33-k230-bottom-left-offset: Exceeded 120s process deadline

- dataset31/38-imx6ull-top-center: Exceeded 120s process deadline

- dataset31/39-imx6ull-top-right-offset: Exceeded 120s process deadline

- dataset31/40-imx6ull-right-top-offset: Exceeded 120s process deadline

- dataset31/41-imx6ull-right-center: Exceeded 120s process deadline

- dataset31/42-imx6ull-right-bottom-offset: Exceeded 120s process deadline

- dataset31/43-imx6ull-bottom-right-offset: Exceeded 120s process deadline

- dataset31/44-imx6ull-bottom-center: Exceeded 120s process deadline

- dataset31/45-imx6ull-bottom-left-offset: Exceeded 120s process deadline

- dataset31/46-imx6ull-left-bottom-offset: Exceeded 120s process deadline

- dataset31/47-imx6ull-left-center: Exceeded 120s process deadline

- dataset31/48-imx6ull-left-top-offset: Exceeded 120s process deadline

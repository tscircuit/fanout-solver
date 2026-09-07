# Dataset 31 — AM62L, RK3308, K230, i.MX6ULL, and T113-S3 fanout benchmark

Commit: 7f0f74771c72efa42b5cdacb4eda93c99927e785. Generated: 2026-09-07T19:18:38.812Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 8b89395624e3ce2d61e26f9fa8f907273047a2e2.

**Solved 29/60 selected samples.** Completed 60/60; partial: 0; errors: 0; timeouts: 31.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 1291.72s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, 12 K230, 12 i.MX6ULL, and 12 T113-S3 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL; 128 for T113-S3). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 37.63 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 16.63 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 24.74 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 3.63 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 2.42 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 3.31 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 31.12 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 15.48 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 44.21 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 30.74 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 8.96 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 27.73 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.02 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.02 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.03 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 13.01 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 3.90 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 35.39 |
| 19-rk3308-bottom-right-offset | solved | 162/162 | 162 | 176 | 1 | 86.94 |
| 20-rk3308-bottom-center | solved | 162/162 | 162 | 174 | 1 | 97.55 |
| 21-rk3308-bottom-left-offset | solved | 162/162 | 162 | 172 | 1 | 117.52 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 32.78 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 15.52 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 7.80 |
| 25-k230-top-left-offset | solved | 171/171 | 171 | 199 | 1 | 110.31 |
| 26-k230-top-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 27-k230-top-right-offset | timeout | 0/171 | — | — | 0 | 120.02 |
| 28-k230-right-top-offset | solved | 171/171 | 171 | 181 | 1 | 104.54 |
| 29-k230-right-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 30-k230-right-bottom-offset | solved | 171/171 | 171 | 195 | 1 | 74.08 |
| 31-k230-bottom-right-offset | solved | 171/171 | 171 | 171 | 1 | 87.55 |
| 32-k230-bottom-center | timeout | 0/171 | — | — | 0 | 120.03 |
| 33-k230-bottom-left-offset | timeout | 0/171 | — | — | 0 | 120.03 |
| 34-k230-left-bottom-offset | solved | 171/171 | 171 | 183 | 1 | 60.72 |
| 35-k230-left-center | solved | 171/171 | 171 | 203 | 1 | 68.74 |
| 36-k230-left-top-offset | solved | 171/171 | 171 | 207 | 1 | 102.17 |
| 37-imx6ull-top-left-offset | solved | 102/102 | 102 | 108 | 1 | 45.31 |
| 38-imx6ull-top-center | timeout | 0/102 | — | — | 0 | 120.03 |
| 39-imx6ull-top-right-offset | timeout | 0/102 | — | — | 0 | 120.03 |
| 40-imx6ull-right-top-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 41-imx6ull-right-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 42-imx6ull-right-bottom-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 43-imx6ull-bottom-right-offset | timeout | 0/102 | — | — | 0 | 120.03 |
| 44-imx6ull-bottom-center | timeout | 0/102 | — | — | 0 | 120.03 |
| 45-imx6ull-bottom-left-offset | timeout | 0/102 | — | — | 0 | 120.04 |
| 46-imx6ull-left-bottom-offset | timeout | 0/102 | — | — | 0 | 120.02 |
| 47-imx6ull-left-center | timeout | 0/102 | — | — | 0 | 120.02 |
| 48-imx6ull-left-top-offset | timeout | 0/102 | — | — | 0 | 120.02 |
| 49-t113s3-top-left-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 50-t113s3-top-center | timeout | 0/128 | — | — | 0 | 120.01 |
| 51-t113s3-top-right-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 52-t113s3-right-top-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 53-t113s3-right-center | timeout | 0/128 | — | — | 0 | 120.01 |
| 54-t113s3-right-bottom-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 55-t113s3-bottom-right-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 56-t113s3-bottom-center | timeout | 0/128 | — | — | 0 | 120.01 |
| 57-t113s3-bottom-left-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 58-t113s3-left-bottom-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 59-t113s3-left-center | timeout | 0/128 | — | — | 0 | 120.01 |
| 60-t113s3-left-top-offset | timeout | 0/128 | — | — | 0 | 120.01 |

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

- dataset31/49-t113s3-top-left-offset: Exceeded 120s process deadline

- dataset31/50-t113s3-top-center: Exceeded 120s process deadline

- dataset31/51-t113s3-top-right-offset: Exceeded 120s process deadline

- dataset31/52-t113s3-right-top-offset: Exceeded 120s process deadline

- dataset31/53-t113s3-right-center: Exceeded 120s process deadline

- dataset31/54-t113s3-right-bottom-offset: Exceeded 120s process deadline

- dataset31/55-t113s3-bottom-right-offset: Exceeded 120s process deadline

- dataset31/56-t113s3-bottom-center: Exceeded 120s process deadline

- dataset31/57-t113s3-bottom-left-offset: Exceeded 120s process deadline

- dataset31/58-t113s3-left-bottom-offset: Exceeded 120s process deadline

- dataset31/59-t113s3-left-center: Exceeded 120s process deadline

- dataset31/60-t113s3-left-top-offset: Exceeded 120s process deadline

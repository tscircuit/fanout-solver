# Dataset 31 — AM62L, RK3308, K230, i.MX6ULL, T113-S3, and AM3352 fanout benchmark

Commit: 2113d7ef85a8c6cd9a0483353d85b72781539cb3. Generated: 2026-09-08T17:46:17.099Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 637a6566a011be520b4fd170ad3f6da696ad4ff9.

**Solved 40/72 selected samples.** Completed 72/72; partial: 0; errors: 0; timeouts: 32.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 1563.97s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, 12 K230, 12 i.MX6ULL, 12 T113-S3, and 12 AM3352 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL; 128 for T113-S3; 322 for AM3352). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 49.07 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 21.46 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 33.44 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 5.41 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 3.29 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 4.59 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 39.31 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 19.39 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 47.36 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 32.81 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 10.59 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 27.65 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.02 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.02 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.03 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 51.51 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 190 | 1 | 38.31 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 94.78 |
| 19-rk3308-bottom-right-offset | solved | 162/162 | 162 | 176 | 1 | 82.02 |
| 20-rk3308-bottom-center | solved | 162/162 | 162 | 174 | 1 | 69.34 |
| 21-rk3308-bottom-left-offset | timeout | 0/162 | — | — | 0 | 120.04 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 88.33 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 174 | 1 | 47.84 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 170 | 1 | 59.76 |
| 25-k230-top-left-offset | timeout | 0/171 | — | — | 0 | 120.03 |
| 26-k230-top-center | timeout | 0/171 | — | — | 0 | 120.07 |
| 27-k230-top-right-offset | timeout | 0/171 | — | — | 0 | 120.05 |
| 28-k230-right-top-offset | timeout | 0/171 | — | — | 0 | 120.05 |
| 29-k230-right-center | solved | 171/171 | 171 | 193 | 1 | 111.62 |
| 30-k230-right-bottom-offset | solved | 171/171 | 171 | 195 | 1 | 80.86 |
| 31-k230-bottom-right-offset | solved | 171/171 | 171 | 171 | 1 | 102.47 |
| 32-k230-bottom-center | timeout | 0/171 | — | — | 0 | 120.06 |
| 33-k230-bottom-left-offset | timeout | 0/171 | — | — | 0 | 120.03 |
| 34-k230-left-bottom-offset | solved | 171/171 | 171 | 183 | 1 | 67.09 |
| 35-k230-left-center | solved | 171/171 | 171 | 203 | 1 | 79.20 |
| 36-k230-left-top-offset | solved | 171/171 | 171 | 207 | 1 | 98.32 |
| 37-imx6ull-top-left-offset | solved | 102/102 | 102 | 108 | 1 | 41.10 |
| 38-imx6ull-top-center | solved | 102/102 | 102 | 108 | 1 | 46.91 |
| 39-imx6ull-top-right-offset | solved | 102/102 | 102 | 108 | 1 | 105.75 |
| 40-imx6ull-right-top-offset | solved | 102/102 | 102 | 116 | 1 | 50.76 |
| 41-imx6ull-right-center | solved | 102/102 | 102 | 122 | 1 | 20.04 |
| 42-imx6ull-right-bottom-offset | solved | 102/102 | 102 | 102 | 1 | 33.59 |
| 43-imx6ull-bottom-right-offset | solved | 102/102 | 102 | 114 | 1 | 37.02 |
| 44-imx6ull-bottom-center | timeout | 0/102 | — | — | 0 | 120.03 |
| 45-imx6ull-bottom-left-offset | timeout | 0/102 | — | — | 0 | 120.03 |
| 46-imx6ull-left-bottom-offset | solved | 102/102 | 102 | 114 | 1 | 62.82 |
| 47-imx6ull-left-center | solved | 102/102 | 102 | 118 | 1 | 39.76 |
| 48-imx6ull-left-top-offset | solved | 102/102 | 102 | 122 | 1 | 65.37 |
| 49-t113s3-top-left-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 50-t113s3-top-center | solved | 128/128 | 128 | 147 | 1 | 56.29 |
| 51-t113s3-top-right-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 52-t113s3-right-top-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 53-t113s3-right-center | solved | 128/128 | 128 | 160 | 1 | 83.80 |
| 54-t113s3-right-bottom-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 55-t113s3-bottom-right-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 56-t113s3-bottom-center | solved | 128/128 | 128 | 157 | 1 | 84.05 |
| 57-t113s3-bottom-left-offset | timeout | 0/128 | — | — | 0 | 120.03 |
| 58-t113s3-left-bottom-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 59-t113s3-left-center | solved | 128/128 | 128 | 157 | 1 | 43.32 |
| 60-t113s3-left-top-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 61-am3352-top-left-offset | timeout | 0/322 | — | — | 0 | 120.02 |
| 62-am3352-top-center | timeout | 0/322 | — | — | 0 | 120.02 |
| 63-am3352-top-right-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 64-am3352-right-top-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 65-am3352-right-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 66-am3352-right-bottom-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 67-am3352-bottom-right-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 68-am3352-bottom-center | timeout | 0/322 | — | — | 0 | 120.02 |
| 69-am3352-bottom-left-offset | timeout | 0/322 | — | — | 0 | 120.02 |
| 70-am3352-left-bottom-offset | timeout | 0/322 | — | — | 0 | 120.02 |
| 71-am3352-left-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 72-am3352-left-top-offset | timeout | 0/322 | — | — | 0 | 120.01 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/21-rk3308-bottom-left-offset: Exceeded 120s process deadline

- dataset31/25-k230-top-left-offset: Exceeded 120s process deadline

- dataset31/26-k230-top-center: Exceeded 120s process deadline

- dataset31/27-k230-top-right-offset: Exceeded 120s process deadline

- dataset31/28-k230-right-top-offset: Exceeded 120s process deadline

- dataset31/32-k230-bottom-center: Exceeded 120s process deadline

- dataset31/33-k230-bottom-left-offset: Exceeded 120s process deadline

- dataset31/44-imx6ull-bottom-center: Exceeded 120s process deadline

- dataset31/45-imx6ull-bottom-left-offset: Exceeded 120s process deadline

- dataset31/49-t113s3-top-left-offset: Exceeded 120s process deadline

- dataset31/51-t113s3-top-right-offset: Exceeded 120s process deadline

- dataset31/52-t113s3-right-top-offset: Exceeded 120s process deadline

- dataset31/54-t113s3-right-bottom-offset: Exceeded 120s process deadline

- dataset31/55-t113s3-bottom-right-offset: Exceeded 120s process deadline

- dataset31/57-t113s3-bottom-left-offset: Exceeded 120s process deadline

- dataset31/58-t113s3-left-bottom-offset: Exceeded 120s process deadline

- dataset31/60-t113s3-left-top-offset: Exceeded 120s process deadline

- dataset31/61-am3352-top-left-offset: Exceeded 120s process deadline

- dataset31/62-am3352-top-center: Exceeded 120s process deadline

- dataset31/63-am3352-top-right-offset: Exceeded 120s process deadline

- dataset31/64-am3352-right-top-offset: Exceeded 120s process deadline

- dataset31/65-am3352-right-center: Exceeded 120s process deadline

- dataset31/66-am3352-right-bottom-offset: Exceeded 120s process deadline

- dataset31/67-am3352-bottom-right-offset: Exceeded 120s process deadline

- dataset31/68-am3352-bottom-center: Exceeded 120s process deadline

- dataset31/69-am3352-bottom-left-offset: Exceeded 120s process deadline

- dataset31/70-am3352-left-bottom-offset: Exceeded 120s process deadline

- dataset31/71-am3352-left-center: Exceeded 120s process deadline

- dataset31/72-am3352-left-top-offset: Exceeded 120s process deadline

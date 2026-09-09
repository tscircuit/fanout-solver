# Dataset 31 — AM62L, RK3308, K230, i.MX6ULL, T113-S3, and AM3352 fanout benchmark

Commit: 090a27a8f5ecb38ab5f2000fcd1e8604312812db. Generated: 2026-09-09T16:09:54.033Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 637a6566a011be520b4fd170ad3f6da696ad4ff9.

**Solved 48/72 selected samples.** Completed 72/72; partial: 0; errors: 0; timeouts: 24.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 1377.33s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, 12 K230, 12 i.MX6ULL, 12 T113-S3, and 12 AM3352 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL; 128 for T113-S3; 322 for AM3352). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 41.05 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 18.53 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 27.30 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 5.20 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 2.67 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 3.57 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 33.75 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 16.27 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 43.46 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 30.54 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 10.15 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 24.68 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.02 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.03 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 38.78 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 190 | 1 | 19.37 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 62.34 |
| 19-rk3308-bottom-right-offset | solved | 162/162 | 162 | 176 | 1 | 55.55 |
| 20-rk3308-bottom-center | solved | 162/162 | 162 | 174 | 1 | 46.28 |
| 21-rk3308-bottom-left-offset | solved | 162/162 | 162 | 172 | 1 | 113.76 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 51.69 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 174 | 1 | 26.63 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 170 | 1 | 32.52 |
| 25-k230-top-left-offset | solved | 171/171 | 171 | 199 | 1 | 85.27 |
| 26-k230-top-center | solved | 171/171 | 171 | 203 | 1 | 99.38 |
| 27-k230-top-right-offset | solved | 171/171 | 171 | 195 | 1 | 101.86 |
| 28-k230-right-top-offset | solved | 171/171 | 171 | 181 | 1 | 78.11 |
| 29-k230-right-center | solved | 171/171 | 171 | 193 | 1 | 89.17 |
| 30-k230-right-bottom-offset | solved | 171/171 | 171 | 195 | 1 | 62.75 |
| 31-k230-bottom-right-offset | solved | 171/171 | 171 | 171 | 1 | 76.85 |
| 32-k230-bottom-center | solved | 171/171 | 171 | 193 | 1 | 89.73 |
| 33-k230-bottom-left-offset | solved | 171/171 | 171 | 249 | 1 | 109.95 |
| 34-k230-left-bottom-offset | solved | 171/171 | 171 | 183 | 1 | 48.86 |
| 35-k230-left-center | solved | 171/171 | 171 | 203 | 1 | 61.65 |
| 36-k230-left-top-offset | solved | 171/171 | 171 | 207 | 1 | 77.66 |
| 37-imx6ull-top-left-offset | solved | 102/102 | 102 | 108 | 1 | 32.47 |
| 38-imx6ull-top-center | solved | 102/102 | 102 | 108 | 1 | 46.50 |
| 39-imx6ull-top-right-offset | solved | 102/102 | 102 | 108 | 1 | 117.03 |
| 40-imx6ull-right-top-offset | solved | 102/102 | 102 | 116 | 1 | 49.92 |
| 41-imx6ull-right-center | solved | 102/102 | 102 | 122 | 1 | 20.02 |
| 42-imx6ull-right-bottom-offset | solved | 102/102 | 102 | 106 | 1 | 24.13 |
| 43-imx6ull-bottom-right-offset | solved | 102/102 | 102 | 114 | 1 | 42.21 |
| 44-imx6ull-bottom-center | timeout | 0/102 | — | — | 0 | 120.02 |
| 45-imx6ull-bottom-left-offset | solved | 102/102 | 102 | 104 | 1 | 40.88 |
| 46-imx6ull-left-bottom-offset | solved | 102/102 | 102 | 114 | 1 | 70.29 |
| 47-imx6ull-left-center | solved | 102/102 | 102 | 118 | 1 | 38.56 |
| 48-imx6ull-left-top-offset | solved | 102/102 | 102 | 122 | 1 | 61.71 |
| 49-t113s3-top-left-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 50-t113s3-top-center | solved | 128/128 | 128 | 147 | 1 | 41.99 |
| 51-t113s3-top-right-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 52-t113s3-right-top-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 53-t113s3-right-center | solved | 128/128 | 128 | 160 | 1 | 55.65 |
| 54-t113s3-right-bottom-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 55-t113s3-bottom-right-offset | timeout | 0/128 | — | — | 0 | 120.01 |
| 56-t113s3-bottom-center | solved | 128/128 | 128 | 157 | 1 | 62.88 |
| 57-t113s3-bottom-left-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 58-t113s3-left-bottom-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 59-t113s3-left-center | solved | 128/128 | 128 | 157 | 1 | 35.74 |
| 60-t113s3-left-top-offset | timeout | 0/128 | — | — | 0 | 120.02 |
| 61-am3352-top-left-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 62-am3352-top-center | timeout | 0/322 | — | — | 0 | 120.02 |
| 63-am3352-top-right-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 64-am3352-right-top-offset | timeout | 0/322 | — | — | 0 | 120.02 |
| 65-am3352-right-center | timeout | 0/322 | — | — | 0 | 120.02 |
| 66-am3352-right-bottom-offset | timeout | 0/322 | — | — | 0 | 120.02 |
| 67-am3352-bottom-right-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 68-am3352-bottom-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 69-am3352-bottom-left-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 70-am3352-left-bottom-offset | timeout | 0/322 | — | — | 0 | 120.02 |
| 71-am3352-left-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 72-am3352-left-top-offset | timeout | 0/322 | — | — | 0 | 120.01 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/44-imx6ull-bottom-center: Exceeded 120s process deadline

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

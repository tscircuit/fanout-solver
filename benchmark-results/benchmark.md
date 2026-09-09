# Dataset 31 — AM62L, RK3308, K230, i.MX6ULL, T113-S3, and AM3352 fanout benchmark

Commit: 5f40c84d8aafccc8688b85621801f6e885b9ac13. Generated: 2026-09-09T04:20:03.268Z.
Dataset source: https://github.com/tscircuit/dataset-fanout31-am62l at 637a6566a011be520b4fd170ad3f6da696ad4ff9.

**Solved 18/72 selected samples.** Completed 72/72; partial: 0; errors: 0; timeouts: 54.

Concurrency: 4; per-sample timeout: 120s; assignment budget: sample defaults; wall time: 1807.49s.

Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, 12 K230, 12 i.MX6ULL, 12 T113-S3, and 12 AM3352 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL; 128 for T113-S3; 322 for AM3352). RAM fanout and inter-chip routing are separate phases.

| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-top-left-offset | solved | 135/135 | 135 | 135 | 1 | 64.93 |
| 02-top-center | solved | 135/135 | 135 | 135 | 1 | 23.09 |
| 03-top-right-offset | solved | 135/135 | 135 | 135 | 1 | 48.78 |
| 04-right-top-offset | solved | 135/135 | 135 | 135 | 1 | 10.22 |
| 05-right-center | solved | 135/135 | 135 | 135 | 1 | 6.63 |
| 06-right-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 12.42 |
| 07-bottom-right-offset | solved | 135/135 | 135 | 135 | 1 | 67.16 |
| 08-bottom-center | solved | 135/135 | 135 | 135 | 1 | 30.13 |
| 09-bottom-left-offset | solved | 135/135 | 135 | 135 | 1 | 85.39 |
| 10-left-bottom-offset | solved | 135/135 | 135 | 135 | 1 | 53.67 |
| 11-left-center | solved | 135/135 | 135 | 135 | 1 | 17.02 |
| 12-left-top-offset | solved | 135/135 | 135 | 135 | 1 | 49.35 |
| 13-rk3308-top-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 14-rk3308-top-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 15-rk3308-top-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 16-rk3308-right-top-offset | solved | 162/162 | 162 | 194 | 1 | 26.62 |
| 17-rk3308-right-center | solved | 162/162 | 162 | 194 | 1 | 5.76 |
| 18-rk3308-right-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 80.29 |
| 19-rk3308-bottom-right-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 20-rk3308-bottom-center | timeout | 0/162 | — | — | 0 | 120.01 |
| 21-rk3308-bottom-left-offset | timeout | 0/162 | — | — | 0 | 120.01 |
| 22-rk3308-left-bottom-offset | solved | 162/162 | 162 | 194 | 1 | 73.05 |
| 23-rk3308-left-center | solved | 162/162 | 162 | 194 | 1 | 24.95 |
| 24-rk3308-left-top-offset | solved | 162/162 | 162 | 194 | 1 | 21.34 |
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
| 37-imx6ull-top-left-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 38-imx6ull-top-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 39-imx6ull-top-right-offset | timeout | 0/102 | — | — | 0 | 120.02 |
| 40-imx6ull-right-top-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 41-imx6ull-right-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 42-imx6ull-right-bottom-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 43-imx6ull-bottom-right-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 44-imx6ull-bottom-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 45-imx6ull-bottom-left-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 46-imx6ull-left-bottom-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 47-imx6ull-left-center | timeout | 0/102 | — | — | 0 | 120.01 |
| 48-imx6ull-left-top-offset | timeout | 0/102 | — | — | 0 | 120.01 |
| 49-t113s3-top-left-offset | timeout | 0/128 | — | — | 0 | 120.01 |
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
| 61-am3352-top-left-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 62-am3352-top-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 63-am3352-top-right-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 64-am3352-right-top-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 65-am3352-right-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 66-am3352-right-bottom-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 67-am3352-bottom-right-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 68-am3352-bottom-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 69-am3352-bottom-left-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 70-am3352-left-bottom-offset | timeout | 0/322 | — | — | 0 | 120.01 |
| 71-am3352-left-center | timeout | 0/322 | — | — | 0 | 120.01 |
| 72-am3352-left-top-offset | timeout | 0/322 | — | — | 0 | 120.01 |

- dataset31/13-rk3308-top-left-offset: Exceeded 120s process deadline

- dataset31/14-rk3308-top-center: Exceeded 120s process deadline

- dataset31/15-rk3308-top-right-offset: Exceeded 120s process deadline

- dataset31/19-rk3308-bottom-right-offset: Exceeded 120s process deadline

- dataset31/20-rk3308-bottom-center: Exceeded 120s process deadline

- dataset31/21-rk3308-bottom-left-offset: Exceeded 120s process deadline

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

- dataset31/37-imx6ull-top-left-offset: Exceeded 120s process deadline

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

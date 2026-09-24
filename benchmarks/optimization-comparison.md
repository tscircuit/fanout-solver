# Clearance optimization measurements

Measured on 2026-09-24 against baseline `97118aa`, using identical captured
dataset31 inputs from `8eabec2516c5066d43ec7672511a1134430c5d45` and Bun 1.3.14.
The optimized version adds an obstacle spatial index and reduces rectangle
distance calculations; solver constraints and search budgets are unchanged.

Each comparison used three fresh worker processes per version and sample,
alternating which version ran first. The table contains median solver times.
A separate four-worker benchmark was running concurrently, so these are local
comparisons under load, not isolated hardware reference timings.

| Sample | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| 02-top-center | 26.445 s | 18.898 s | 28.5% faster |
| 05-right-center | 3.562 s | 3.868 s | 8.6% slower |

All twelve comparison runs solved all 135 connections. Each sample produced
the same SHA-256 SVG hash across both versions and all repetitions. Median
process CPU time, including rendering, fell from 28.276 s to 21.097 s for
top-center and rose from 4.411 s to 4.593 s for right-center. The benefit is
workload-dependent; the small case does not demonstrate an improvement.

Validation: typecheck and 16 focused geometry, clearance, via, and routing
regression tests passed, including existing visual snapshots. New tests cover
rectangle-distance equivalence, spatial-index collision completeness, and
obstacle-cache invalidation. The full test suite was stopped during long-running
dataset tests; it did not complete.

The older committed benchmark report uses a different dataset revision and
must not be used as a before/after solve-count comparison.

## Full optimized run

All 72 captured inputs were run through the benchmark worker with concurrency
4, a 120-second process deadline, and the original sample assignment budgets.
The run took 1,463.8 seconds and finished with **47 solved, 25 timed out, zero
partial results, and zero errors**.

| Family | Solved | Timed out |
| --- | ---: | ---: |
| AM62L | 12/12 | 0 |
| RK3308 | 8/12 | 4 |
| K230 | 12/12 | 0 |
| i.MX6ULL | 11/12 | 1 |
| T113-S3 | 4/12 | 8 |
| AM3352 | 0/12 | 12 |

Some early cases overlapped the regression tests and paired measurements.
This run confirms complete validated solutions for the successful cases, but
its timeouts are sensitive to that additional CPU load. It is not evidence of
an overall solve-count increase. Fresh baseline runs of RK3308 top-center,
T113-S3 top-left-offset, and AM3352 top-left-offset also timed out at 120 seconds.

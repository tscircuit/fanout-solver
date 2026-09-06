# Core progressive AM62L DRAM reproduction

The first solver input from core's
`tests/repros/repro-am62l-lpddr4-progressive-fanout.test.tsx` already exists in
`tests/fixtures/am62l-core-progressive-fanout.json`. The second invocation is
captured separately in `tests/fixtures/am62l-core-progressive-dram.json`.

This second input retains all 143 connections, 217 obstacles, 135 previous SoC
traces, and the original solver options. Unlike the older six-bus DRAM fixture,
it includes eight decoupling capacitors (16 extra pads), the current byte-bus
exit mappings, the 0.15 mm via hole diameter, and core's full connectivity lists.
The fixture records the exact source commit. Repeated connectivity suffixes are
stored once; `createAm62lCoreProgressiveDramInput()` reconstructs the constructor
arguments losslessly.

Run it with:

```sh
bun test tests/am62l-core-progressive-dram.test.ts
```

The captured input currently fails to complete: the best of eight assignments
routes 125 of 143 connections. The reproduction pins the partial visualization,
requires at least that coverage, rejects partial output being reported as a
successful solve, and requires full validation and copper DRC if all connections
are routed in the future. It does not override the layer-search budget or loosen
clearance requirements.

The performance changes preserve the routing search and its tolerances:

- Use conservative bounding boxes to skip exact distances for distant copper.
- Reuse plan arrays, blocking-segment bounds, A* distance estimates, lane costs,
  and the allowed turns for each incoming direction.
- Reuse a failed winding search only when the terminal, lane bias, and all
  already accepted copper match. The cache is local to one winding invocation;
  static obstacles, vias, grid, and search limits cannot change within it.
  Reused failures still emit completion progress with the original counts.

The A* caches require at most 1.83 MiB per active terminal search. Focused tests
compare segment clearance against the original distance calculation and ensure
that changed lane bias or accepted copper forces a new winding search.

For benchmark comparisons, keep the existing 12 dataset31 samples, their captured
inputs, timeouts, and assignment budgets unchanged. Compare validated connection
counts and generated SVGs as well as elapsed time. The benchmark covers SoC
fanout; the exact DRAM reproduction is additional regression coverage.

## Validation

Against baseline `53516cb`, the full regression suite passes all 174 original
cases plus three new cases (177 passed, zero failed). All 12 benchmark samples
remain fully solved, with all 1,620 connections validated, unchanged attempt/via
counts, byte-identical captured inputs, and byte-identical routed SVGs.

The measured benchmark sum decreased from 232.861 s to 213.205 s (8.4%); these
runs overlapped other validation work, so this is an indicative wall-time result.
A separate sequential diagnostic of the first DRAM assignment used the same
1,000,000-iteration safety ceiling in each variant. It is only a timing experiment:
the committed reproduction retains the original constructor options.

| First-assignment diagnostic | Wall time | CPU time |
| --- | ---: | ---: |
| Baseline | 55.075 s | 60.208 s |
| Optimized | 49.941 s | 54.441 s |
| Optimized without A* caches | 52.129 s | 56.999 s |

All three diagnostics completed the same one assignment with 120/143 routed and
identical attempt/statistics hashes. The original full search still reaches
125/143 after eight assignments; these optimizations do not fix the missing
escapes. The debugger page `repros/repro06-core-progressive-dram.page.tsx` exposes
that complete original input for further investigation.

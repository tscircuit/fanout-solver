# Core progressive AM62L DRAM reproduction

Core's `tests/repros/repro-am62l-lpddr4-progressive-fanout.test.tsx` invokes the
fanout solver once for the SoC and once for DRAM. The first input already exists
in `tests/fixtures/am62l-core-progressive-fanout.json`. The second invocation is
captured in `tests/fixtures/am62l-core-progressive-dram.json`.

The DRAM capture retains all 143 connections, 217 obstacles, 135 previous SoC
traces, and the original solver options. It includes eight decoupling capacitors,
the current byte-bus exit mappings, the 0.15 mm via hole diameter, and core's full
connectivity lists. Its metadata records the exact core commit. Repeated
connectivity suffixes are stored once; `createAm62lCoreProgressiveDramInput()`
reconstructs the constructor arguments losslessly.

Run the complete reproduction with:

```sh
bun test tests/am62l-core-progressive-dram.test.ts
```

The test requires all 143 unique connections on the first layer assignment,
preserves all 135 prior traces, and checks full solution validation and copper
DRC. Its SVG shows the complete result. The debugger page
`repros/repro06-core-progressive-dram.page.tsx` uses the same input and options.

## Routing recovery

The current BYTE0 exit mapping exchanges two adjacent targets compared with the
older successful DRAM fixture. The existing shared via reservations can fence off
that winding bus. Removing reservations permits signal routes that leave some
power pads without a local dogbone site.

After both existing dense routing grids fail, the solver retries the first
blocked wide bus ahead of its peers using four dogbone orientations. These
retries can reserve future boundary exits while routing each lane. The remaining
plane routes are then selected jointly from legal local dogbones and longer
source-layer escapes, so one greedy plane choice cannot consume another's last
site. The recovery marker prevents recursive retries; each plane search is capped
at 10,000 states and initially considers eight longer-route alternatives per
blocked plane.

Every candidate retains the input's clearance, via dimensions and spans, layer
restrictions, and bus skew limits. The captured input and constructor budgets are
unchanged. Existing successful dense routes return before this recovery runs.

## Performance and validation

Before recovery, the unchanged full capture took 232.556 seconds and stopped at
125/143 connections after eight assignments. Two local production runs now
complete all 143 connections in 44.224 and 44.493 seconds, using the original
constructor options. These wall times are indicative; validation work overlapped
on the same machine.

An independent output audit verified all 143 unique routes, all 135 prior traces
and 217 original obstacles, 110 plane terminations, and 143 through-vias with the
original 0.24/0.15 mm dimensions. Full solution validation and copper DRC report
no issues. The existing corner-band endpoint distribution remains unchanged.

The focused reserved-exit regression checks that the additional retry is opt-in,
keeps its fixed via sites and endpoints, and completes all eight lanes with valid
clearance. The complete DRAM regression also checks preservation of prior copper.

Benchmark comparisons run all 24 cases from the current pinned dataset revision,
with unchanged inputs, per-sample assignment budgets, and 120-second deadlines.
The baseline's 12 AM62L cases solve completely; its RK3308 cases time out. Compare
every sample's status and validated connection count without dropping failures
or changing their deadlines.

# AM62L RAM-left sample

This imports [sample 11-left-center](https://github.com/tscircuit/dataset-fanout31-am62l/blob/8c73befb36b125c84651c07454a9b940b3c6500a/samples/11-left-center.tsx)
from `dataset-fanout31-am62l`, pinned at `8c73befb36b125c84651c07454a9b940b3c6500a`.
The LPDDR4 is centered at (-17, 0), left of the AM62L at (0, 0).

The JSON is the exact constructor input captured by the upstream TSX after
`@tscircuit/core` runs implicit winding through `renderUntilSettled`. No exit
targets are rotated or rearranged. All 135 connections, 111 buses, 573 pad
obstacles, three differential pairs, and bus length-skew limits are retained.
The upstream sample does not contain decoupling capacitors. This tests the
AM62L fanout phase, not the subsequent RAM fanout or inter-chip routing.

## Regenerate and inspect

```sh
bun scripts/generate-repro/generate-dataset-fanout31-left.tsx
bun scripts/solve-fanout31-left.ts --output /tmp/fanout31-left
```

The full case is also available as Dataset 08 in the Cosmos debugger. The CLI
uses a subprocess deadline (60 seconds by default) because a synchronous
fallback can block a single solver step. `--output` saves an SVG and JSON
progress report; nonzero exit status means failure or timeout.

## Current result and reductions

The full sample solves all **135/135 connections** with no validation issues,
including all 102 plane drops and the original bus/differential-pair timing
constraints. A local run takes about 45 seconds using the first layer assignment.
No debug environment variables or input relaxations are required.

Keeping all pad obstacles and original timing constraints:

| Selected connectivity | Result |
| --- | --- |
| All 102 plane drops | Solves |
| Plane drops + 8 address/control signals | Solves 110/110; SVG regression test |
| All 8 BYTE1 connections, one assignment budget | Solves 8/8; SVG regression test |
| Both byte buses with all plane drops | Solves 118/118 |
| Complete sample, one assignment budget | Solves 135/135; SVG regression test |

The fix was developed by reducing connectivity while retaining every pad obstacle,
then restoring buses. The winding grid now samples the pad-lattice channels, and
failed searches can promote the blocked connection in a bounded route-order retry.
Via reservations avoid entering a neighboring wide bus's source field.

RESET needs a different topology: it escapes on the source layer, then uses one
through-via near the left boundary to reach `inner6`. Plane-site matching respects
that actual multi-segment source path instead of assuming a straight dogbone.
Length tuning first tries retaining the existing plane sites before rematching.

```sh
# Successful mixed plane/signal subset, retaining the 15 mm skew limit
bun scripts/solve-fanout31-left.ts --buses planes,DDR_ADDR_CTRL

# Complete BYTE1 regression, including the formerly failing DQ14 / ball U2
bun scripts/solve-fanout31-left.ts --buses DDR_BYTE1 --connection-limit 8 --max-layer-combinations 1

# Full, unrelaxed sample
bun scripts/solve-fanout31-left.ts --timeout-ms 120000 --max-layer-combinations 1 --output /tmp/fanout31-left
```

# Fanout Solver Development Guide

## Commands

- Typecheck: `bun run typecheck`
- Test: `bun test`
- Benchmark: `bun run benchmark`
- Render dataset verification PNGs: `bun run render:dataset`
- Cosmos debugger: `bun run start`
- Export debugger: `bun run build:site`

## Solver invariants

- A bus is atomic: all of its connections escape in one direction and onto one
  layer, or none of that bus is committed.
- Via use is bus-atomic: either every connection in a bus uses a via or none
  does. Prefer via-free source-layer escape for outward-edge buses.
- Never place a via on a BGA pad. Escape vias must clear every pad they span.
- When a via cannot clear a pad-pair midpoint, move it diagonally to a
  four-pad corner interstice and use nested side bands to spread two-layer
  traces around already-routed outer buses.
- When `compactBusTracks` is enabled, bend every bus into the same
  trace-width-plus-clearance-pitch envelope before the shared-boundary run.
- Preserve circular-pad geometry metadata from footprinter when validating
  corner-interstitial clearance; do not replace circles with square corners.
- Emit only straight or 45-degree fanout corners; chamfer orthogonal routing
  corners before clearance validation.
- Route every connected pad, including inner BGA rows and columns.
- All footprints in one problem escape through the same shared boundary.
- Keep the output compatible with `SimpleRouteJson`: committed fanout prefixes
  become supplied traces and the remaining connection endpoint moves to the
  outside of the shared breakout edge.
- Throw on invalid input or impossible internal state. Do not silently return a
  partially routed bus as a successful solve.
- Use kebab-case filenames and one test per file.

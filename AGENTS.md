# Fanout Solver Development Guide

## Commands

- Typecheck: `bun run typecheck`
- Test: `bun test`
- Benchmark: `bun run benchmark` (only dataset-fanout31-am62l; other datasets are regression fixtures)
- Render dataset verification PNGs: `bun run render:dataset`
- Cosmos debugger: `bun run start`
- Export debugger: `bun run build:site`

## Testing

- New routing features and bug fixes should generally include a focused visual
  SVG snapshot test. Prefer a snapshot that makes the intended geometry
  obvious over multiple implementation-level tests, and add nonvisual
  assertions only for behavior the image cannot communicate.

## Solver invariants

- A bus is atomic: all of its connections escape in one direction and onto one
  layer, or none of that bus is committed.
- A bus `preferredExit` is atomic too: edge/corner guidance applies to the
  complete bus. Preserve trace order and reject a corner request that would
  require same-layer crossings.
- When `borderDistribution` is `even`, spread exits across the occupied border
  interval without violating trace/clearance pitch or reordering buses.
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
- An enclosed same-layer source pad may escape diagonally through a package
  corner only when the 45-degree centerline clears both adjacent perimeter pads
  and every other obstacle under the configured trace/clearance rules.
- All footprints in one problem escape through the same shared boundary.
- Keep the output compatible with `SimpleRouteJson`: committed fanout prefixes
  become supplied traces and the remaining connection endpoint moves to the
  shared breakout edge. Every route must distribute before that edge and end
  exactly on it; fanout geometry must never continue beyond the boundary.
- Throw on invalid input or impossible internal state. Do not silently return a
  partially routed bus as a successful solve.
- Use kebab-case filenames and one test per file.

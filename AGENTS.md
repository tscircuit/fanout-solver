# Fanout Solver Development Guide

## Commands

- Typecheck: `bun run typecheck`
- Test: `bun test`
- Benchmark: `bun run benchmark`
- Cosmos debugger: `bun run start`
- Export debugger: `bun run build:site`

## Solver invariants

- A bus is atomic: all of its connections escape in one direction and onto one
  layer, or none of that bus is committed.
- Never place a via on a BGA pad. Escape vias must clear every pad they span.
- Keep the output compatible with `SimpleRouteJson`: committed fanout prefixes
  become supplied traces and the remaining connection endpoint moves to the
  breakout edge.
- Throw on invalid input or impossible internal state. Do not silently return a
  partially routed bus as a successful solve.
- Use kebab-case filenames and one test per file.

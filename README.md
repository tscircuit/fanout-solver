# @tscircuit/fanout-solver

BGA fanout preprocessor for
[`SimpleRouteJson`](https://github.com/tscircuit/tscircuit-autorouter).

`FanoutSolver` routes short pad-to-breakout prefixes before the general-purpose
autorouter runs. It can put an escape via in the gap between adjacent BGA pads,
routes every member of a bus in the same direction, and treats each bus-layer
decision atomically.

## Behavior

- Uses `SimpleRouteJson.buses` when present. It also understands a point
  `busId` and names such as `BUS_DDR_01`.
- Detects rectangular BGA pad grids through obstacle `componentId` metadata.
- Infers one outward direction per bus from the bus endpoints, or accepts an
  explicit direction override.
- Enumerates combinations of the copper layers implied by `layerCount`.
- Moves an entire bus to one assigned layer. A partial bus is never committed.
- Places the escape via halfway toward the neighboring BGA pad and verifies pad,
  via, trace, and already-routed fanout clearance.
- Emits supplied fanout traces, via obstacles, and moved breakout endpoints in a
  new `SimpleRouteJson`. The returned problem is ready for a downstream
  autorouter to finish.

## Install

This repository uses tscircuit's source-first GitHub package convention:

```sh
bun add https://github.com/tscircuit/fanout-solver
```

## Usage

```ts
import { CapacityMeshSolver } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "@tscircuit/fanout-solver"

const fanoutSolver = new FanoutSolver(simpleRouteJson, {
  maxLayerCombinations: 256,
  busDirections: {
    ddr: "right",
  },
})
fanoutSolver.solve()

if (fanoutSolver.failed) {
  throw new Error(fanoutSolver.error ?? "Fanout failed")
}

const autorouter = new CapacityMeshSolver(
  fanoutSolver.getOutputSimpleRouteJson(),
)
autorouter.solve()
```

The canonical bus input is the current `SimpleRouteJson` bus structure:

```ts
{
  buses: [
    {
      busId: "ddr",
      connectionNames: ["BUS_DDR_01", "BUS_DDR_02", "BUS_DDR_03"],
    },
  ],
}
```

All listed connections receive the same escape direction and target layer. If
one connection cannot be routed cleanly, the solver rejects that bus for the
current layer assignment and tries another combination.

## Output contract

`getOutput()` returns:

- `simpleRouteJson`: the downstream routing problem with fanout prefixes
- `fanoutTraces`: the newly supplied pad-to-breakout traces
- `busLayerAssignments`: the selected layer for every bus
- `busDirections`: the direction shared by each bus
- `attempts`: score and success metadata for every tried layer combination

## Development

```sh
bun install
bun run typecheck
bun test
bun run benchmark
bun run start
```

The benchmark builds 6×6, 8×8, and 10×10 BGA pad grids with
`@tscircuit/footprinter`, creates four outward buses, and reports routing time
and attempted layer assignments. `bun run start` opens the same footprinter
BGA64 case in the standard tscircuit solver debugger.

## Scope

This package owns the BGA pad-to-breakout prefix. It does not replace the
board-level autorouter, length-match buses, or route arbitrary obstacles between
the breakout boundary and the final destination.

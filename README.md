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
- Handles buses from multiple BGA footprints in the same routing problem.
- Routes exits beyond each component courtyard when `componentBounds` are
  supplied. Without explicit bounds, it conservatively inflates the detected
  pad grid from its pitch.
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
  componentBounds: {
    "bga-01": { minX: -4.7, maxX: 4.7, minY: -4.7, maxY: 4.7 },
  },
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

## Dataset 01

`datasets/dataset01.ts` contains five deterministic footprinter samples. The
samples contain exactly one through five BGA footprints, and every sample is
solved as one `SimpleRouteJson`.

| Sample | Footprints | Pads | Connections |
| --- | ---: | ---: | ---: |
| `sample001` | 1 | 64 | 20 |
| `sample002` | 2 | 100 | 32 |
| `sample003` | 3 | 136 | 44 |
| `sample004` | 4 | 200 | 64 |
| `sample005` | 5 | 236 | 76 |

The Cosmos debugger provides Previous/Next controls and direct sample tabs. It
also stores the selected sample in the `sample` URL parameter. Dataset
component bounds come from each footprinter-generated
`pcb_courtyard_outline`.

## Development

```sh
bun install
bun run typecheck
bun test
bun run benchmark
bun run render:dataset
bun run start
```

The benchmark runs every Dataset 01 sample and reports footprint, pad,
connection, routing, and layer-assignment metrics. `bun run start` opens the
same dataset in the standard tscircuit solver debugger. `bun run
render:dataset` writes a `graphics-debug` PNG for each sample with red courtyard
boundaries and green fanout-exit markers.

## Scope

This package owns the BGA pad-to-breakout prefix. It does not replace the
board-level autorouter, length-match buses, or route arbitrary obstacles between
the breakout boundary and the final destination.

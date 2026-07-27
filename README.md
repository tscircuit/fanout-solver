# @tscircuit/fanout-solver

BGA fanout preprocessor for
[`SimpleRouteJson`](https://github.com/tscircuit/tscircuit-autorouter).

`FanoutSolver` routes every connected BGA pad to one shared breakout boundary
before the general-purpose autorouter runs. It can put a small escape via in a
pad-to-pad channel or move an oversized via diagonally into the interstice
between four pad corners. It routes every member of a bus in the same direction
and treats each bus-layer decision atomically.

## Behavior

- Uses `SimpleRouteJson.buses` when present. It also understands a point
  `busId` and names such as `BUS_DDR_01`.
- Detects rectangular BGA pad grids through obstacle `componentId` metadata.
- Handles multiple BGA footprints inside one shared breakout boundary.
- Routes perimeter and inner-matrix pads; the benchmark connects every pad.
- Uses `sharedBoundary` as the common exit rectangle. Without one, it infers a
  shared rectangle around all detected component bounds and pad grids.
- Infers one outward direction per bus from the bus endpoints, or accepts an
  explicit direction override.
- Enumerates combinations of the copper layers implied by `layerCount`.
- Moves an entire bus to one assigned layer. A partial bus is never committed.
- Uses a straight pad-pair escape when the via fits. Otherwise it uses a 45°
  four-pad interstitial escape and nested side bands that spread deeper
  two-layer buses around already-routed outer buses.
- Verifies pad, via, trace, and already-routed fanout clearance.
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
  sharedBoundary: {
    minX: -25,
    maxX: 25,
    minY: -25,
    maxY: 25,
  },
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
| `sample001` | 1 | 64 | 64 |
| `sample002` | 2 | 100 | 100 |
| `sample003` | 3 | 136 | 136 |
| `sample004` | 4 | 200 | 200 |
| `sample005` | 5 | 236 | 236 |

The Cosmos debugger provides Previous/Next controls and direct sample tabs. It
also stores the selected dataset and sample in the `dataset` and `sample` URL
parameters. Each sample has one shared boundary around all of its footprints,
and component bounds come from each footprinter-generated
`pcb_courtyard_outline`.

## Dataset 02

`datasets/dataset02.ts` is the geometric stress dataset. Every sample has only
top and bottom copper. Its 0.40 mm vias plus clearance cannot fit at the
midpoint between adjacent 0.60 mm pads on 1.00 mm pitch, but do fit diagonally
at the center of four pad corners. Inner buses must spread into nested side
bands before crossing the shared boundary.

| Sample | Footprints | Pads | Buses | Stress condition |
| --- | ---: | ---: | ---: | --- |
| `sample001` | 1 | 100 | 10 | One BGA100, interstitial vias, north/south spreading |
| `sample002` | 2 | 200 | 20 | Opposed BGA100 footprints on one bottom layer |
| `sample003` | 3 | 228 | 26 | Simultaneous left/right/north/south bundles |
| `sample004` | 4 | 256 | 32 | Four BGA64 footprints share top/bottom exits |
| `sample005` | 5 | 356 | 42 | Central BGA100 plus four BGA64 footprints |

Every pad is connected in every stress sample. More than 95% of their breakout
tracks leave the perpendicular span of their source footprint, making the
required outward spreading visible in both Cosmos and the verification PNGs.

## Development

```sh
bun install
bun run typecheck
bun test
bun run benchmark
bun run render:dataset
bun run start
```

The benchmark runs every sample in both datasets and reports footprint, pad,
connection, routing, and layer-assignment metrics. `bun run start` opens the
datasets in the standard tscircuit solver debugger. `bun run
render:dataset` writes `graphics-debug` PNGs under one subdirectory per dataset,
with a red shared boundary, gray component courtyards, and green fanout-exit
markers.

## Scope

This package owns the BGA pad-to-breakout prefix. It does not replace the
board-level autorouter, length-match buses, or route arbitrary obstacles between
the breakout boundary and the final destination.

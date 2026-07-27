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
- Keeps outward-edge buses on their source layer when possible. If a bus needs
  a via, every connection in that bus receives one and moves to the same
  assigned layer; mixed via use within a bus is never committed.
- Uses a straight pad-pair escape when the via fits. Otherwise it uses a 45°
  four-pad interstitial escape and nested side bands that spread deeper
  two-layer buses around already-routed outer buses.
- `compactBusTracks` bends each bus into a trace/clearance-pitch routing
  envelope, so a wide pad row does not consume a disproportionately wide
  breakout corridor.
- Chamfers orthogonal routing corners into 45° segments before validating and
  emitting the fanout.
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
import { CapacityMeshSolver } from "@tscircuit/capacity-autorouter";
import { FanoutSolver } from "@tscircuit/fanout-solver";

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
  compactBusTracks: true,
});
fanoutSolver.solve();

if (fanoutSolver.failed) {
  throw new Error(fanoutSolver.error ?? "Fanout failed");
}

const autorouter = new CapacityMeshSolver(
  fanoutSolver.getOutputSimpleRouteJson(),
);
autorouter.solve();
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

| Sample      | Footprints | Pads | Connections |
| ----------- | ---------: | ---: | ----------: |
| `sample001` |          1 |   64 |          64 |
| `sample002` |          2 |  100 |         100 |
| `sample003` |          3 |  136 |         136 |
| `sample004` |          4 |  200 |         200 |
| `sample005` |          5 |  236 |         236 |

The Cosmos debugger provides Previous/Next controls and direct sample tabs. It
also stores the selected dataset and sample in the `dataset` and `sample` URL
parameters. Each sample has one shared boundary around all of its footprints,
and component bounds come from the exact footprinter-generated copper pad
extents.

## Dataset 02

`datasets/dataset02.ts` is the geometric stress dataset. Every sample uses
[JLCPCB's published 1 oz, two-layer 0.10/0.10 mm trace and spacing capability](https://jlcpcb.com/capabilities/pcb-capabilities/),
and 0.10 mm pad/copper clearance. It uses the exact footprinter string
`bga40_grid10x4_p0.4mm_pad0.2mm_circularpads`; the debugger includes that
string in both the visible sample heading and browser title.

At 0.4 mm pitch, a 0.15 mm algorithmic HDI microvia has 0.108 mm clearance
from each 0.20 mm circular pad at a four-pad corner, but only 0.025 mm at a
pair midpoint. That forces the intended corner-interstitial strategy. These
0.15/0.10 mm microvias are intentionally smaller than JLCPCB's published
standard two-layer 0.25/0.15 mm mechanical via minimum: the standard via would
have only 0.058 mm corner clearance and cannot satisfy the same 0.10 mm rule.
The dataset is therefore a two-routing-layer solver stress case, not a claim
that its microvia stackup is a standard JLCPCB two-layer order.

| Sample      | Footprints | Pads | Buses | Stress condition                                  |
| ----------- | ---------: | ---: | ----: | ------------------------------------------------- |
| `sample001` |          1 |   40 |     4 | 20 vias; two 10-trace perimeter buses stay on top |
| `sample002` |          2 |   80 |     8 | 0.6 mm between adjacent footprint pad fields      |
| `sample003` |          3 |  120 |    12 | staggered close placement and compact bend-ins    |
| `sample004` |          4 |  160 |    16 | shared top/bottom corridors for 40-pin BGAs       |
| `sample005` |          5 |  200 |    20 | 100 bus-atomic vias on two routing layers         |

Every pad is connected in every stress sample. Via use is atomic per bus, every
10-trace bus bends from a 3.6 mm pad span into a 1.8 mm routing envelope, and
all emitted corners are straight or 45°. Bottom-layer traces render as solid
blue in both Cosmos and the verification PNGs.

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

# @tscircuit/fanout-solver

BGA fanout preprocessor for
[`SimpleRouteJson`](https://github.com/tscircuit/tscircuit-autorouter).

`FanoutSolver` routes every connected package pad to one shared breakout boundary
before the general-purpose autorouter runs. It can put a small escape via in a
pad-to-pad channel or move an oversized via diagonally into the interstice
between four pad corners. It routes every member of a bus in the same direction
and treats each bus-layer decision atomically.

## Behavior

- Uses `SimpleRouteJson.buses` when present. It also understands a point
  `busId` and names such as `BUS_DDR_01`.
- Detects rectangular pad footprints through obstacle `componentId` metadata,
  including perimeter packages and two-pad passives.
- Handles multiple mixed footprints inside one shared breakout boundary.
- Routes perimeter and inner-matrix pads; the benchmark connects every pad.
- Uses `sharedBoundary` as the common exit rectangle. Without one, it infers a
  shared rectangle around all detected component bounds and pad grids.
- Ends every fanout trace exactly on its selected `sharedBoundary` edge. Border
  distribution and lane spreading happen inside the rectangle, never after the
  trace has crossed the boundary.
- Infers one outward direction per bus from the bus endpoints, or accepts an
  explicit direction override.
- Accepts an additive `preferredExit` bus field for a particular edge
  (`left`, `right`, `top`, or `bottom`) or corner (`top-left`, `top-right`,
  `bottom-left`, or `bottom-right`). A corner chooses a compatible adjacent
  edge and reserves the bus at that end of the border.
- `borderDistribution: "even"` uses outward-only shoves to equalize
  under-filled gaps across the occupied border interval while preserving bus
  order, existing wider corridors, and trace/clearance pitch. The default
  `"preserve"` mode stays source-aligned.
- Supports balanced nearest-edge partitioning for package breakouts. Ties
  alternate instead of favoring one axis; square grids distribute equally
  across north, south, east, and west.
- Enumerates combinations of the copper layers implied by `layerCount`.
- Prefers depth-cycled layer assignments: matching north/south (or east/west)
  bus depths share a layer, and deeper pairs cycle through every available
  escape layer. This forces a small stackup to reuse routing channels.
- Keeps outward-edge buses on their source layer when possible. If a bus needs
  a via, every connection in that bus receives one and moves to the same
  assigned layer; mixed via use within a bus is never committed.
- Accepts a bus-level `termination` target. The default
  `{ type: "boundary" }` preserves the ordinary breakout contract, while
  `{ type: "plane", layer: "inner1" }` escapes each source pad to a legal local
  via and considers the connection complete on that plane instead of extending
  it to the shared boundary.
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
  busExitPreferences: {
    clocks: "top-right",
  },
  borderDistribution: "even",
  compactBusTracks: true,
  buses: [
    {
      busId: "ground",
      connectionNames: ["VSS_A1", "VSS_A2"],
      direction: "right",
      termination: { type: "plane", layer: "inner1" },
    },
  ],
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
      preferredExit: "right",
    },
  ],
}
```

`preferredExit` is an optional fanout extension to `SimpleRouteBus`; omitting it
leaves ordinary `SimpleRouteJson` behavior unchanged. All listed connections
receive the same escape direction and target layer. If one connection cannot be
routed cleanly, the solver rejects that bus for the current layer assignment and
tries another combination. `busExitPreferences` provides the same override
without modifying the input object.

`termination` is another additive extension:

```ts
type FanoutBusTermination =
  | { type: "boundary" }
  | { type: "plane"; layer: string }
```

A plane-targeted connection may contain only its package-pad source point. The
solver creates the local dogbone and via, records it in `planeTerminations`, and
removes the completed connection from the returned downstream
`SimpleRouteJson`. Plane layers are fixed targets and are not included in the
bus-layer combination search.

## Output contract

`getOutput()` returns:

- `simpleRouteJson`: the downstream routing problem with fanout prefixes
- `fanoutTraces`: the newly supplied pad-to-breakout traces
- `planeTerminations`: the completed local-via connection, layer, and via data
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

`datasets/dataset02.ts` is the four-layer BGA400 stress benchmark. It routes
every ball in the exact footprinter string
`bga400_grid20x20_p0.8mm_pad0.3mm_circularpads`; the debugger includes that
string in both the visible sample heading and browser title. The sample uses
[JLCPCB's published 0.10/0.10 mm trace and spacing capability](https://jlcpcb.com/capabilities/pcb-capabilities/),
0.10 mm pad/copper clearance, and standard 0.25/0.15 mm vias.

Exactly 100 balls and ten buses escape through each package edge. The four
perimeter buses (76 balls) stay via-free on top. The remaining 36 buses use 324
bus-atomic vias. Matching opposite-edge depths cycle through `inner1`,
`inner2`, and `bottom`, so every escape layer carries twelve buses instead of
receiving one easy depth band.

The earlier 0.4 mm corner-interstitial case remains a dedicated regression
test. It cannot honestly route the full BGA400 on four layers with the retained
0.10 mm rules: adjacent 0.15 mm via centers are 0.40 mm apart, but a crossing
0.10 mm trace needs 0.45 mm center-to-center capacity after both clearances are
included. The repeated via row is therefore a physical copper wall. The
0.8 mm BGA400 leaves real reusable channels while still forcing a four-layer
solution.

| Sample      | Footprints | Pads | Buses | Vias | Layers |
| ----------- | ---------: | ---: | ----: | ---: | -----: |
| `sample001` |          1 |  400 |    40 |  324 |      4 |

Every bus exits the shared component boundary and uses only straight or 45°
segments. Top, inner1, inner2, and bottom traces use distinct red, blue, green,
and purple colors in Cosmos and the verification PNG.

## Dataset 03

`datasets/dataset03.ts` contains four two-layer mixed-footprint samples. Every
sample uses the exact footprinter strings `qfn50_p0.4mm`, `res0603`, and
`cap0603`, for 54 routed pads across three footprints and one shared boundary.
The QFN rotates through 0°, 90°, 180°, and 270° while the two 0603 packages
alternate between tangential and radial placement.

The close tangential samples deliberately block two opposite top-layer QFN
escape corridors. The solver moves each obstructed QFN side as one atomic bus
to bottom while keeping the surrounding 0603 terminals independently routable.
The radial samples offset the passives toward package corners to create
asymmetric channels without relaxing JLCPCB's 0.10 mm copper clearance or
standard 0.25/0.15 mm via constraints.

| Sample      | Footprints | Pads | Buses | Layers |
| ----------- | ---------: | ---: | ----: | -----: |
| `sample001` |          3 |   54 |     8 |      2 |
| `sample002` |          3 |   54 |     8 |      2 |
| `sample003` |          3 |   54 |     8 |      2 |
| `sample004` |          3 |   54 |     8 |      2 |

## Dataset 04

`datasets/dataset04.ts` contains five top-copper-only package-plus-decoupling
stress cases. Every sample places exactly eight `cap0603` footprints at the
cardinal and diagonal positions around one central package, then uses
push-and-shove bends to move complete ordered bundles through one shared
boundary. The `"even"` border-distribution option makes the exit lanes consume
their available border interval consistently, and the four diagonal capacitor
pairs explicitly request their matching corners. No Dataset 04 route contains
a via or a non-top-layer wire.

The BGA cases use the exact footprinter strings
`bga16_grid4x4_p0.8mm_pad0.3mm_circularpads`,
`bga25_grid5x5_p1.75mm_pad0.3mm_circularpads`,
`bga36_grid6x6_p1.5mm_pad0.3mm_circularpads`, and
`bga64_grid8x8_p1.5mm_pad0.3mm_circularpads`. Every inner ball is connected,
grid-line buses remain atomic, and a sweep-line channel router pushes already
allocated traces when a new pad row needs corridor capacity.

The final sample uses the RP2040-class footprinter string
`qfn56_w7.8_h7.8_p0.4mm_pw0.23mm_pl0.8mm_thermalpad3.2x3.2_startingpin(topside,rightpin)_ccw`.
Those compensated footprinter dimensions reproduce
[Raspberry Pi's reference land pattern](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf)
exactly: perimeter centers at ±3.4 mm, 0.4 mm pitch, 0.8×0.23 mm pads, and a
3.2×3.2 mm exposed pad, with no overlapping copper.
It routes all 56 perimeter pins, the exposed thermal pad, and all 16 capacitor
pads. The thermal-pad trace leaves on a 45° diagonal through a package corner,
centered between the outermost pads on its two adjacent edges. That diagonal
channel clears both rectangular pad corners under the same 0.10 mm trace and
0.10 mm edge-clearance rules.

All five regressions independently verify JLCPCB's 0.10 mm trace width and
0.10 mm copper-clearance rules, top-only routing, shared-boundary exits, inner
BGA pad coverage, ordered push-and-shove bends, and the absence of 90° corners.

| Sample      | Footprints | Routed pads | Buses | Vias | Layers |
| ----------- | ---------: | ----------: | ----: | ---: | -----: |
| `sample001` |          9 |          32 |    24 |    0 |      1 |
| `sample002` |          9 |          41 |    25 |    0 |      1 |
| `sample003` |          9 |          52 |    28 |    0 |      1 |
| `sample004` |          9 |          80 |    32 |    0 |      1 |
| `sample005` |          9 |          73 |    73 |    0 |      1 |

## Dataset 05

`datasets/dataset05.ts` uses the attached Rockchip RK3588 V1.1 ball-assignment
data as its checked-in source of truth. It preserves the exact 34×34 published
orientation, all 1,088 populated ball coordinates and names, and all 68
unpopulated positions. Every generated connection and pad obstacle carries its
complete source assignment as `rk3588BallAssignment` metadata.

The six-layer sample dedicates `inner1` to the 422 ground balls and `inner2` to
the 167 power balls. Those 589 connections end at unique 0.25/0.15 mm local
dogbone vias. The remaining 499 signal balls are divided into short,
direction-consistent geometric buses and escape to the shared boundary on
`top`, `inner3`, `inner4`, and `bottom`. All copper uses the same 0.10 mm trace
and clearance values as the JLCPCB regressions.

| Sample      | Package      | Balls | Plane terminations | Boundary signals | Layers |
| ----------- | ------------ | ----: | -----------------: | ---------------: | -----: |
| `sample001` | FCBGA1088L   |  1088 |                589 |              499 |      6 |

## Development

```sh
bun install
bun run typecheck
bun test
bun run benchmark
bun run render:dataset
bun run start
```

The benchmark runs every sample in all datasets and reports footprint, pad,
connection, routing, and layer-assignment metrics. `bun run start` opens the
datasets in the standard tscircuit solver debugger. `bun run
render:dataset` writes `graphics-debug` PNGs under one subdirectory per dataset,
with a red shared boundary, gray component courtyards, and green fanout-exit
markers.

## Scope

This package owns the BGA pad-to-breakout prefix. It does not replace the
board-level autorouter, length-match buses, or route arbitrary obstacles between
the breakout boundary and the final destination.

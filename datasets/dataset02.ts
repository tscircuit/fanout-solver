import { createFootprinterBenchmarkProblem } from "./create-footprinter-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

const PITCH = 0.4
const PAD_DIAMETER = 0.2
const VIA_DIAMETER = 0.15
const VIA_HOLE_DIAMETER = 0.1
const TRACE_WIDTH = 0.1
const CLEARANCE = 0.1
const BOUNDARY_MARGIN = 4
const ROW_COUNT = 20
const COLUMN_COUNT = 20
const LAYER_COUNT = 10
const MAX_CONNECTIONS_PER_BUS = 20

const problem = createFootprinterBenchmarkProblem({
  boundaryMargin: BOUNDARY_MARGIN,
  clearance: CLEARANCE,
  footprints: [
    {
      componentId: "bga400",
      center: { x: 0, y: 0 },
      gridSize: ROW_COUNT,
      rowCount: ROW_COUNT,
      columnCount: COLUMN_COUNT,
      pitch: PITCH,
      padDiameter: PAD_DIAMETER,
    },
  ],
  layerCount: LAYER_COUNT,
  busDirectionMode: "vertical-split",
  maxConnectionsPerBus: MAX_CONNECTIONS_PER_BUS,
  traceWidth: TRACE_WIDTH,
  viaDiameter: VIA_DIAMETER,
  viaHoleDiameter: VIA_HOLE_DIAMETER,
})

export const fanoutDataset02: FanoutDatasetSample[] = [
  {
    id: "sample001",
    name: "Complete 20×20 BGA400 breakout",
    description:
      "Routes all 400 balls as twenty atomic 20-trace row buses. The two perimeter buses stay on top; each successively deeper north/south bus pair escapes on the next copper layer through four-pad corner interstices.",
    footprintCount: 1,
    footprinterStrings: problem.footprinterStrings,
    simpleRouteJson: problem.simpleRouteJson,
    solverOptions: {
      compactBusTracks: true,
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    },
    componentBounds: problem.componentBounds,
    sharedBoundary: problem.sharedBoundary,
  },
]

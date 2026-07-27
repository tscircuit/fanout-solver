import { createFootprinterBenchmarkProblem } from "./create-footprinter-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

const PITCH = 0.8
const PAD_DIAMETER = 0.3
const VIA_DIAMETER = 0.25
const VIA_HOLE_DIAMETER = 0.15
const TRACE_WIDTH = 0.1
const CLEARANCE = 0.1
const BOUNDARY_MARGIN = 4
const ROW_COUNT = 20
const COLUMN_COUNT = 20
const LAYER_COUNT = 4
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
  busDirectionMode: "four-side",
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
      "Routes exactly 100 balls toward each package edge on four copper layers. Forty nearest-edge buses cycle through top, inner1, inner2, and bottom while clearing earlier via rows and columns.",
    footprintCount: 1,
    footprinterStrings: problem.footprinterStrings,
    simpleRouteJson: problem.simpleRouteJson,
    solverOptions: {
      compactBusTracks: false,
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    },
    componentBounds: problem.componentBounds,
    sharedBoundary: problem.sharedBoundary,
  },
]

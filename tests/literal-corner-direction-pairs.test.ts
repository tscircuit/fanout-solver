import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type {
  FanoutBorderTarget,
  FanoutBusSpec,
  FanoutDirection,
  FanoutEdge,
  Point2D,
} from "lib/types"

const pitch = 0.7
const coordinates = Array.from(
  { length: 4 },
  (_, index) => (index - 1.5) * pitch,
)
const sharedBoundary = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
const cases: Array<{
  direction: FanoutDirection
  corner: FanoutBorderTarget
  exitEdge: FanoutEdge
  sources: Array<{ column: number; row: number }>
  singleLayerPushAndShove?: boolean
}> = [
  {
    direction: "up",
    corner: "top-left",
    exitEdge: "left",
    singleLayerPushAndShove: true,
    sources: [
      { column: 0, row: 3 },
      { column: 1, row: 3 },
    ],
  },
  {
    direction: "up",
    corner: "top-right",
    exitEdge: "right",
    sources: [
      { column: 2, row: 3 },
      { column: 3, row: 3 },
    ],
  },
  {
    direction: "right",
    corner: "top-right",
    exitEdge: "top",
    sources: [
      { column: 3, row: 2 },
      { column: 3, row: 3 },
    ],
  },
  {
    direction: "right",
    corner: "bottom-right",
    exitEdge: "bottom",
    sources: [
      { column: 3, row: 0 },
      { column: 3, row: 1 },
    ],
  },
  {
    direction: "down",
    corner: "bottom-left",
    exitEdge: "left",
    sources: [
      { column: 0, row: 0 },
      { column: 1, row: 0 },
    ],
  },
  {
    direction: "down",
    corner: "bottom-right",
    exitEdge: "right",
    sources: [
      { column: 2, row: 0 },
      { column: 3, row: 0 },
    ],
  },
  {
    direction: "left",
    corner: "top-left",
    exitEdge: "top",
    sources: [
      { column: 0, row: 2 },
      { column: 0, row: 3 },
    ],
  },
  {
    direction: "left",
    corner: "bottom-left",
    exitEdge: "bottom",
    sources: [
      { column: 0, row: 0 },
      { column: 0, row: 1 },
    ],
  },
]

function getTargetPoint(source: Point2D, direction: FanoutDirection): Point2D {
  switch (direction) {
    case "up":
      return { x: source.x, y: 4 }
    case "right":
      return { x: 4, y: source.y }
    case "down":
      return { x: source.x, y: -4 }
    case "left":
      return { x: -4, y: source.y }
  }
}

function getPerimeterChannelAxis(
  trace: SimplifiedPcbTrace,
  direction: FanoutDirection,
): number {
  const wires = trace.route.filter((point) => point.route_type === "wire")
  for (let index = 1; index < wires.length; index++) {
    const previous = wires[index - 1]!
    const current = wires[index]!
    const isPerimeterRail =
      direction === "up" || direction === "down"
        ? Math.abs(current.y - previous.y) < 1e-9 &&
          Math.abs(current.x - previous.x) > 0.4
        : Math.abs(current.x - previous.x) < 1e-9 &&
          Math.abs(current.y - previous.y) > 0.4
    if (isPerimeterRail) {
      return direction === "up" || direction === "down" ? current.y : current.x
    }
  }
  throw new Error(`No perimeter rail found for ${trace.connection_name}`)
}

test("literal corner exits support every compatible direction and corner", () => {
  for (const testCase of cases) {
    const connectionNames = testCase.sources.map(
      (_, index) => `SIGNAL_${index}`,
    )
    const bus: FanoutBusSpec = {
      busId: "BUS",
      connectionNames,
      sourceComponentId: "soc",
      direction: testCase.direction,
      preferredExit: testCase.corner,
      exitEdge: testCase.exitEdge,
      allowedLayers: [testCase.singleLayerPushAndShove ? "top" : "inner1"],
    }
    const connections = testCase.sources.map(({ column, row }, index) => {
      const source = { x: coordinates[column]!, y: coordinates[row]! }
      return {
        name: connectionNames[index]!,
        pointsToConnect: [
          {
            ...source,
            layer: "top" as const,
            pointId: `soc-pad-${column}-${row}`,
          },
          {
            ...getTargetPoint(source, testCase.direction),
            layer: testCase.singleLayerPushAndShove ? "top" : "inner1",
          },
        ],
      }
    })
    const obstacles: Obstacle[] = coordinates.flatMap((x, column) =>
      coordinates.map((y, row) => {
        const pointId = `soc-pad-${column}-${row}`
        return {
          obstacleId: pointId,
          componentId: "soc",
          type: "rect" as const,
          center: { x, y },
          width: 0.3,
          height: 0.3,
          layers: ["top"],
          connectedTo: [
            pointId,
            ...connections
              .filter((connection) =>
                connection.pointsToConnect.some(
                  (point) => "pointId" in point && point.pointId === pointId,
                ),
              )
              .map((connection) => connection.name),
          ],
        }
      }),
    )
    const simpleRouteJson: SimpleRouteJson = {
      layerCount: 4,
      minTraceWidth: 0.1,
      nominalTraceWidth: 0.1,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minTraceToPadEdgeClearance: 0.1,
      minViaEdgeToPadEdgeClearance: 0.1,
      defaultObstacleMargin: 0.1,
      bounds: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
      obstacles,
      connections,
      buses: [bus],
    }
    const solver = new FanoutSolver(simpleRouteJson, {
      buses: [bus],
      sharedBoundary,
      escapeLayers: [testCase.singleLayerPushAndShove ? "top" : "inner1"],
      singleLayerPushAndShove: testCase.singleLayerPushAndShove,
      traceWidth: 0.1,
      viaDiameter: 0.3,
      viaHoleDiameter: 0.15,
      clearance: 0.1,
      compactBusTracks: true,
    })

    solver.solve()

    if (solver.failed) {
      throw new Error(
        `${testCase.direction}/${testCase.corner}: ${solver.error ?? "failed"}`,
      )
    }
    const output = solver.getOutput()
    expect(output.validation.valid).toBe(true)
    const exits = output.fanoutTraces.map((trace) => trace.route.at(-1)!)
    expect(exits).toHaveLength(2)
    for (const exit of exits) {
      expect(exit.route_type).toBe("wire")
      if (exit.route_type !== "wire") continue
      switch (testCase.exitEdge) {
        case "top":
          expect(exit.y).toBe(sharedBoundary.maxY)
          break
        case "right":
          expect(exit.x).toBe(sharedBoundary.maxX)
          break
        case "bottom":
          expect(exit.y).toBe(sharedBoundary.minY)
          break
        case "left":
          expect(exit.x).toBe(sharedBoundary.minX)
          break
      }
      if (testCase.corner.endsWith("-left")) expect(exit.x).toBeLessThan(0)
      if (testCase.corner.endsWith("-right")) expect(exit.x).toBeGreaterThan(0)
      if (testCase.corner.startsWith("top-")) expect(exit.y).toBeGreaterThan(0)
      if (testCase.corner.startsWith("bottom-")) expect(exit.y).toBeLessThan(0)
    }

    const exitTrackCoordinates = exits
      .flatMap((exit) =>
        exit.route_type !== "wire"
          ? []
          : testCase.exitEdge === "top" || testCase.exitEdge === "bottom"
            ? [exit.x]
            : [exit.y],
      )
      .toSorted((first, second) => first - second)
    const usesMinimumCornerSide =
      testCase.exitEdge === "top" || testCase.exitEdge === "bottom"
        ? testCase.corner.endsWith("-left")
        : testCase.corner.startsWith("bottom-")
    for (let index = 0; index < exitTrackCoordinates.length; index++) {
      expect(exitTrackCoordinates[index]).toBeCloseTo(
        (usesMinimumCornerSide ? -1.7 : 1.3) + index * 0.4,
      )
    }

    const channelAxes = output.fanoutTraces
      .map((trace) => getPerimeterChannelAxis(trace, testCase.direction))
      .toSorted((first, second) => first - second)
    const positiveDirection =
      testCase.direction === "up" || testCase.direction === "right"
    for (let index = 0; index < channelAxes.length; index++) {
      expect(channelAxes[index]).toBeCloseTo(
        (positiveDirection ? 2.5 : -2.7) + index * 0.2,
      )
    }
  }
})

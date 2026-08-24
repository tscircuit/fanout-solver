import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const pitch = 0.7
const coordinates = Array.from(
  { length: 4 },
  (_, index) => (index - 1.5) * pitch,
)
const sourceColumnsByBus = {
  FIRST: [2, 3],
  SECOND: [0, 1],
} as const

function getPerimeterRailY(trace: SimplifiedPcbTrace): number {
  const wires = trace.route.filter((point) => point.route_type === "wire")
  for (let index = 1; index < wires.length; index++) {
    const previous = wires[index - 1]!
    const current = wires[index]!
    if (
      Math.abs(current.y - previous.y) < 1e-9 &&
      Math.abs(current.x - previous.x) > 0.4
    ) {
      return current.y
    }
  }
  throw new Error(`No perimeter rail found for ${trace.connection_name}`)
}

function getBoundaryRailX(trace: SimplifiedPcbTrace): number {
  const wires = trace.route.filter((point) => point.route_type === "wire")
  const candidates: number[] = []
  for (let index = 1; index < wires.length; index++) {
    const previous = wires[index - 1]!
    const current = wires[index]!
    if (
      Math.abs(current.x - previous.x) < 1e-9 &&
      Math.abs(current.y - previous.y) > 1e-9
    ) {
      candidates.push(current.x)
    }
  }
  if (candidates.length > 0) return Math.max(...candidates)
  throw new Error(`No boundary rail found for ${trace.connection_name}`)
}

test("same-band buses reserve distinct right-edge slots and rails", () => {
  const sharedBoundary = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const buses: FanoutBusSpec[] = [
    {
      busId: "FIRST",
      connectionNames: ["FIRST_0", "FIRST_1"],
      sourceComponentId: "soc",
      direction: "up",
      preferredExit: "top-right",
      exitEdge: "right",
      allowedLayers: ["inner1"],
    },
    {
      busId: "SECOND",
      connectionNames: ["SECOND_0", "SECOND_1"],
      sourceComponentId: "soc",
      direction: "up",
      preferredExit: "top-right",
      exitEdge: "right",
      allowedLayers: ["bottom"],
    },
  ]
  const connections = Object.entries(sourceColumnsByBus).flatMap(
    ([busId, columns]) =>
      columns.map((column, index) => ({
        name: `${busId}_${index}`,
        pointsToConnect: [
          {
            x: coordinates[column]!,
            y: coordinates[3]!,
            layer: "top" as const,
            pointId: `soc-pad-${column}-3`,
          },
          {
            x: coordinates[column]!,
            y: 4,
            layer: busId === "FIRST" ? "inner1" : "bottom",
          },
        ],
      })),
  )
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
                (point) => point.pointId === pointId,
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
    buses,
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    buses,
    sharedBoundary,
    escapeLayers: ["inner1", "bottom"],
    traceWidth: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    clearance: 0.1,
    compactBusTracks: true,
  })

  solver.solve()

  if (solver.failed) {
    throw new Error(solver.error ?? "Expected boundary-edge buses to solve")
  }
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)
  expect(output.busLayerAssignments).toEqual({
    FIRST: "inner1",
    SECOND: "bottom",
  })

  const exits = output.fanoutTraces.map((trace) => trace.route.at(-1)!)
  expect(
    exits.every((exit) => exit.route_type === "wire" && exit.x === 3),
  ).toBe(true)
  const exitYCoordinates = exits
    .flatMap((exit) => (exit.route_type === "wire" ? [exit.y] : []))
    .toSorted((first, second) => first - second)
  expect(exitYCoordinates).toHaveLength(4)
  for (let index = 0; index < exitYCoordinates.length; index++) {
    expect(exitYCoordinates[index]).toBeCloseTo(0.9 + index * 0.4)
  }

  const perimeterRailYCoordinates = output.fanoutTraces
    .map(getPerimeterRailY)
    .toSorted((first, second) => first - second)
  expect(perimeterRailYCoordinates).toHaveLength(4)
  for (let index = 0; index < perimeterRailYCoordinates.length; index++) {
    expect(perimeterRailYCoordinates[index]).toBeCloseTo(2.1 + index * 0.2)
  }

  const boundaryRailXCoordinates = output.fanoutTraces
    .map(getBoundaryRailX)
    .toSorted((first, second) => first - second)
  expect(boundaryRailXCoordinates).toHaveLength(4)
  for (let index = 0; index < boundaryRailXCoordinates.length; index++) {
    expect(boundaryRailXCoordinates[index]).toBeCloseTo(2.1 + index * 0.2)
  }

  const routedWithTerminalVias: SimpleRouteJson = {
    ...output.simpleRouteJson,
    traces: output.simpleRouteJson.traces?.map((trace) => {
      const exit = trace.route.at(-1)
      if (exit?.route_type !== "wire") return trace
      const terminalLayer = exit.layer === "top" ? "bottom" : "top"
      return {
        ...trace,
        route: [
          ...trace.route,
          {
            route_type: "via" as const,
            x: exit.x,
            y: exit.y,
            from_layer: exit.layer,
            to_layer: terminalLayer,
            via_diameter: 0.3,
            via_hole_diameter: 0.15,
          },
          {
            route_type: "wire" as const,
            x: exit.x,
            y: exit.y,
            width: 0.1,
            layer: terminalLayer,
          },
        ],
      }
    }),
  }
  const terminalViaDrc = validateRoutedCopperDrc({
    inputSrj: simpleRouteJson,
    routedSrj: routedWithTerminalVias,
    clearance: 0.1,
  })
  expect(
    terminalViaDrc.issues.filter(
      (issue) =>
        issue.code === "different-net-trace-via-clearance" ||
        issue.code === "different-net-via-clearance",
    ),
  ).toEqual([])
})

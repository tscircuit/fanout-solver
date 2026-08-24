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

test("upper and lower bands safely reuse right-edge rail depths", () => {
  const sharedBoundary = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const busInputs = [
    {
      busId: "UPPER",
      corner: "top-right" as const,
      direction: "up" as const,
      columns: [2, 3] as const,
      row: 3,
      layer: "inner1",
    },
    {
      busId: "LOWER",
      corner: "bottom-right" as const,
      direction: "down" as const,
      columns: [0, 1] as const,
      row: 0,
      layer: "bottom",
    },
  ]
  const buses: FanoutBusSpec[] = busInputs.map((input) => ({
    busId: input.busId,
    connectionNames: input.columns.map(
      (_, connectionIndex) => `${input.busId}_${connectionIndex}`,
    ),
    sourceComponentId: "soc",
    direction: input.direction,
    preferredExit: input.corner,
    exitEdge: "right",
    allowedLayers: [input.layer],
  }))
  const connections = busInputs.flatMap((input) =>
    input.columns.map((column, connectionIndex) => ({
      name: `${input.busId}_${connectionIndex}`,
      pointsToConnect: [
        {
          x: coordinates[column]!,
          y: coordinates[input.row]!,
          layer: "top" as const,
          pointId: `soc-pad-${column}-${input.row}`,
        },
        {
          x: coordinates[column]!,
          y: input.direction === "up" ? 4 : -4,
          layer: input.layer,
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
    throw new Error(solver.error ?? "Expected opposite-band buses to solve")
  }
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)

  const exitsByBus = Object.fromEntries(
    busInputs.map((input) => [
      input.busId,
      output.fanoutTraces
        .filter((trace) => trace.connection_name.startsWith(input.busId))
        .map((trace) => trace.route.at(-1)!),
    ]),
  )
  for (const [busId, expectedYCoordinates] of [
    ["UPPER", [1.3, 1.7]],
    ["LOWER", [-1.7, -1.3]],
  ] as const) {
    expect(
      exitsByBus[busId].every(
        (exit) => exit.route_type === "wire" && exit.x === 3,
      ),
    ).toBe(true)
    const actualYCoordinates = exitsByBus[busId]
      .flatMap((exit) => (exit.route_type === "wire" ? [exit.y] : []))
      .toSorted((first, second) => first - second)
    for (let index = 0; index < expectedYCoordinates.length; index++) {
      expect(actualYCoordinates[index]).toBeCloseTo(
        expectedYCoordinates[index]!,
      )
    }
  }

  for (const input of busInputs) {
    const busTraces = output.fanoutTraces.filter((trace) =>
      trace.connection_name.startsWith(input.busId),
    )
    const localRails = busTraces
      .map(getPerimeterRailY)
      .toSorted((first, second) => first - second)
    expect(localRails).toEqual(
      input.direction === "up" ? [2.5, 2.7] : [-2.7, -2.5],
    )
    expect(
      busTraces
        .map(getBoundaryRailX)
        .toSorted((first, second) => first - second),
    ).toEqual([2.5, 2.7])
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
        issue.code === "different-net-via-clearance" ||
        issue.code === "different-net-trace-clearance",
    ),
  ).toEqual([])
})

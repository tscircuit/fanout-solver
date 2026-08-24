import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const pitch = 0.7
const padSize = 0.3
const gridCoordinates = Array.from(
  { length: 8 },
  (_, index) => (index - 3.5) * pitch,
)

const obstacles: Obstacle[] = gridCoordinates.flatMap((x, column) =>
  gridCoordinates.map((y, row) => {
    const pointId = `soc-pad-${column}-${row}`
    return {
      obstacleId: pointId,
      componentId: "soc",
      type: "rect" as const,
      center: { x, y },
      width: padSize,
      height: padSize,
      layers: ["top"],
      connectedTo: [pointId],
    }
  }),
)

const upperSources = gridCoordinates.map((_, column) => ({ column, row: 7 }))
const lowerSources = gridCoordinates.map((_, column) => ({ column, row: 0 }))
const targetY = [-1.4, 1.4, -0.2, 0.6, -0.6, 1, -1, 0.2]

const buses: FanoutBusSpec[] = [
  {
    busId: "UPPER_BYTE",
    connectionNames: upperSources.map((_, index) => `UPPER_${index}`),
    sourceComponentId: "soc",
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
    allowedLayers: ["inner1"],
    connectionExitTargets: Object.fromEntries(
      upperSources.map((_, index) => [
        `UPPER_${index}`,
        { x: 10, y: targetY[index]! },
      ]),
    ),
  },
  {
    busId: "LOWER_BYTE",
    connectionNames: lowerSources.map((_, index) => `LOWER_${index}`),
    sourceComponentId: "soc",
    direction: "down",
    preferredExit: "bottom-right",
    exitEdge: "right",
    allowedLayers: ["bottom"],
    connectionExitTargets: Object.fromEntries(
      lowerSources.map((_, index) => [
        `LOWER_${index}`,
        { x: 10, y: targetY.at(-index - 1)! },
      ]),
    ),
  },
]

const connections = [
  ...upperSources.map(({ column, row }, index) => ({
    name: `UPPER_${index}`,
    pointsToConnect: [
      {
        x: gridCoordinates[column]!,
        y: gridCoordinates[row]!,
        layer: "top" as const,
        pointId: `soc-pad-${column}-${row}`,
      },
      { x: 5, y: targetY[index]!, layer: "inner1" as const },
    ],
  })),
  ...lowerSources.map(({ column, row }, index) => ({
    name: `LOWER_${index}`,
    pointsToConnect: [
      {
        x: gridCoordinates[column]!,
        y: gridCoordinates[row]!,
        layer: "top" as const,
        pointId: `soc-pad-${column}-${row}`,
      },
      { x: 5, y: targetY.at(-index - 1)!, layer: "bottom" as const },
    ],
  })),
]

test("up/down escapes terminate in quarter-centered bands on the right edge", async () => {
  const sharedBoundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: sharedBoundary,
    obstacles: obstacles.map((obstacle) => ({
      ...obstacle,
      connectedTo: [
        ...(obstacle.connectedTo ?? []),
        ...connections
          .filter((connection) =>
            connection.pointsToConnect.some(
              (point) => point.pointId === obstacle.obstacleId,
            ),
          )
          .map((connection) => connection.name),
      ],
    })),
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
    throw new Error(solver.error ?? "Expected corner-channel fanout to solve")
  }
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)
  expect(output.busLayerAssignments).toEqual({
    UPPER_BYTE: "inner1",
    LOWER_BYTE: "bottom",
  })

  for (const [prefix, expectedBandCenter, escapeSign] of [
    ["UPPER", 2.5, 1],
    ["LOWER", -2.5, -1],
  ] as const) {
    const traces = output.fanoutTraces.filter((trace) =>
      trace.connection_name.startsWith(prefix),
    )
    const exits = traces.map((trace) => trace.route.at(-1)!)
    expect(exits).toHaveLength(8)
    expect(
      exits.every(
        (exit) =>
          exit.route_type === "wire" &&
          Math.abs(exit.x - sharedBoundary.maxX) < 1e-6 &&
          Math.abs(exit.y) < sharedBoundary.maxY - 1,
      ),
    ).toBe(true)

    const exitYCoordinates = exits
      .flatMap((exit) => (exit.route_type === "wire" ? [exit.y] : []))
      .toSorted((first, second) => first - second)
    expect(
      exitYCoordinates.reduce((sum, coordinate) => sum + coordinate, 0) /
        exitYCoordinates.length,
    ).toBeCloseTo(expectedBandCenter)
    for (let index = 1; index < exitYCoordinates.length; index++) {
      expect(
        exitYCoordinates[index]! - exitYCoordinates[index - 1]!,
      ).toBeCloseTo(0.4)
    }

    for (const trace of traces) {
      const wires = trace.route.filter((point) => point.route_type === "wire")
      const source = wires[0]!
      const localEscape = wires[1]!
      const penultimate = wires.at(-2)!
      const exit = wires.at(-1)!
      expect(localEscape.x).toBeCloseTo(source.x)
      expect(Math.sign(localEscape.y - source.y)).toBe(escapeSign)
      expect(exit.x).toBeGreaterThan(penultimate.x)
      expect(exit.y).toBeCloseTo(penultimate.y)
    }
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

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})

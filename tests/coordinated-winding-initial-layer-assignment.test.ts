import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type {
  FanoutBorderTarget,
  FanoutBusSpec,
  FanoutDirection,
  FanoutEdge,
  Point2D,
} from "lib/types"
import eastOrbitFixtureJson from "./fixtures/am62l-east-orbit-all-signals-repro.json"
import northOrbitFixtureJson from "./fixtures/am62l-north-orbit-search-explosion.json"

const coordinates = [-1.05, -0.35, 0.35, 1.05]
const sourceSites = Array.from({ length: 8 }, (_, index) => ({
  column: index % 4,
  row: 2 + Math.floor(index / 4),
}))

const rotateCounterclockwise = (point: Point2D): Point2D => ({
  x: -point.y,
  y: point.x,
})

function createSolver(orientation: "east" | "north"): FanoutSolver {
  const rotate =
    orientation === "east" ? (point: Point2D) => point : rotateCounterclockwise
  const direction: FanoutDirection = orientation === "east" ? "up" : "left"
  const exitEdge: FanoutEdge = orientation === "east" ? "right" : "top"
  const preferredExit: FanoutBorderTarget =
    orientation === "east" ? "top-right" : "top-left"
  const connectionNames = sourceSites.map((_, index) => `BYTE_${index}`)
  const explicitTargets = connectionNames.map((connectionName, index) => {
    const targetTrack = index < 4 ? 1.2 + index * 0.2 : -1.8 + index * 0.2
    return [
      connectionName,
      {
        ...rotate({ x: 6, y: targetTrack }),
        layer: index < 4 ? "top" : "inner1",
      },
    ] as const
  })
  const bus: FanoutBusSpec = {
    busId: "BYTE",
    connectionNames,
    sourceComponentId: "soc",
    direction,
    exitEdge,
    preferredExit,
    allowedLayers: ["top", "inner1"],
    connectionExitTargets: Object.fromEntries(explicitTargets),
  }
  const connections: SimpleRouteJson["connections"] = sourceSites.map(
    ({ column, row }, index) => {
      const source = rotate({ x: coordinates[column]!, y: coordinates[row]! })
      const target = rotate({ x: 8, y: index - 3.5 })
      return {
        name: connectionNames[index]!,
        pointsToConnect: [
          {
            ...source,
            layer: "top",
            pointId: `soc-pad-${column}-${row}`,
          },
          { ...target, layer: "inner1" },
        ],
      }
    },
  )
  const obstacles: Obstacle[] = coordinates.flatMap((x, column) =>
    coordinates.map((y, row) => {
      const obstacleId = `soc-pad-${column}-${row}`
      return {
        obstacleId,
        componentId: "soc",
        type: "rect",
        center: rotate({ x, y }),
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [
          obstacleId,
          ...connections
            .filter((connection) =>
              connection.pointsToConnect.some(
                (point) => point.pointId === obstacleId,
              ),
            )
            .map((connection) => connection.name),
        ],
      }
    }),
  )
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles,
    connections,
    buses: [bus],
  }
  return new FanoutSolver(input, {
    buses: [bus],
    sharedBoundary: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    escapeLayers: ["top", "inner1"],
    maxLayerCombinations: 1,
    allowBlindAndBuriedVias: false,
  })
}

for (const orientation of ["east", "north"] as const) {
  test(`keeps a coordinated ${orientation} winding off its source layer when explicit target layers tie`, () => {
    const solver = createSolver(orientation)
    const bus = solver.preparedBuses[0]
    const targetLayer = solver.layerAssignments[0]?.BYTE

    expect(
      bus?.connections.map((connection) => connection.sourceLayer),
    ).toEqual(Array.from({ length: 8 }, () => "top"))
    expect(
      bus?.connections.every(
        (connection) => connection.hasExplicitLayeredExitTarget,
      ),
    ).toBe(true)
    expect(targetLayer).toBe("inner1")
    expect(
      bus?.connections.every(
        (connection) => connection.sourceLayer !== targetLayer,
      ),
    ).toBe(true)
  })
}

test("aligns vertical target-only windings without changing the horizontal released choice", () => {
  const eastFixture = eastOrbitFixtureJson as unknown as {
    inputSrj: SimpleRouteJson
    options: ConstructorParameters<typeof FanoutSolver>[1]
  }
  const northFixture = northOrbitFixtureJson as unknown as {
    input: SimpleRouteJson
    options: ConstructorParameters<typeof FanoutSolver>[1]
  }
  const eastSolver = new FanoutSolver(eastFixture.inputSrj, eastFixture.options)
  const northSolver = new FanoutSolver(northFixture.input, northFixture.options)

  expect(eastSolver.layerAssignments[0]).toMatchObject({
    // Source + non-source targets still choose the non-source winding layer.
    DDR_BYTE0: "inner4",
    // Horizontal targets that are already off the source layer retain the
    // released depth/round-robin choice.
    DDR_BYTE1: "bottom",
  })
  expect(northSolver.layerAssignments[0]).toMatchObject({
    // Vertical target lanes stay aligned to their nearest supported
    // through-layer instead of taking the opposing-depth fallback.
    DDR_BYTE0: "inner4",
    DDR_BYTE1: "inner5",
  })
})

import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

const boundaryBusWidths = [4, 1, 1, 1, 1, 1, 1, 1, 1] as const

function createDenseAssignmentSolver(busIds: readonly string[]): FanoutSolver {
  if (busIds.length !== boundaryBusWidths.length) {
    throw new Error("expected one id for every boundary bus")
  }

  const connections: SimpleRouteJson["connections"] = []
  const obstacles: Obstacle[] = []
  const buses: FanoutBusSpec[] = []
  let nextConnectionIndex = 0

  for (const [busIndex, width] of boundaryBusWidths.entries()) {
    const busId = busIds[busIndex]!
    // Only the first and third buses share a source component and exit edge.
    // Their layer collision is therefore the only narrow/wide penalty in this
    // synthetic field; all other buses merely activate the dense 9-bus path.
    const sourceComponentId =
      busIndex === 0 || busIndex === 2
        ? "shared-component"
        : `component-${busIndex}`
    const connectionNames: string[] = []
    const connectionExitTargets: Record<
      string,
      { x: number; y: number; layer: string }
    > = {}
    const explicitTargetLayer = busIndex === 1 ? "top" : "inner1"

    for (let lane = 0; lane < width; lane++) {
      const connectionName = `signal-${nextConnectionIndex}`
      const pointId = `pad-${nextConnectionIndex}`
      const sourcePoint = {
        x: -2 + busIndex * 0.35,
        y: -2 + lane * 0.35,
      }
      connectionNames.push(connectionName)
      connectionExitTargets[connectionName] = {
        x: -8,
        y: -3 + nextConnectionIndex * 0.25,
        layer: explicitTargetLayer,
      }
      connections.push({
        name: connectionName,
        pointsToConnect: [
          { ...sourcePoint, layer: "top", pointId },
          { x: -9, y: sourcePoint.y, layer: explicitTargetLayer },
        ],
      })
      obstacles.push({
        obstacleId: pointId,
        componentId: sourceComponentId,
        type: "rect",
        center: sourcePoint,
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: [pointId, connectionName],
      })
      nextConnectionIndex++
    }

    buses.push({
      busId,
      connectionNames,
      connectionExitTargets,
      sourceComponentId,
      direction: "left",
      exitEdge: "left",
      preferredExit: "left",
      allowedLayers: busIndex === 1 ? ["top", "inner1"] : ["inner1", "inner2"],
    })
  }

  const planeConnectionName = "plane-signal"
  const planePointId = "plane-pad"
  connections.push({
    name: planeConnectionName,
    pointsToConnect: [{ x: 2, y: 2, layer: "top", pointId: planePointId }],
  })
  obstacles.push({
    obstacleId: planePointId,
    componentId: "plane-component",
    type: "rect",
    center: { x: 2, y: 2 },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [planePointId, planeConnectionName],
  })
  buses.push({
    busId: "fixed-plane",
    connectionNames: [planeConnectionName],
    sourceComponentId: "plane-component",
    direction: "right",
    termination: { type: "plane", layer: "inner3" },
  })

  const input: SimpleRouteJson = {
    layerCount: 6,
    minTraceWidth: 0.08,
    nominalTraceWidth: 0.08,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.05,
    minViaEdgeToPadEdgeClearance: 0.05,
    defaultObstacleMargin: 0.05,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    connections,
    obstacles,
    buses,
  }

  return new FanoutSolver(input, {
    buses,
    sharedBoundary: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
    escapeLayers: ["top", "inner1", "inner2"],
    maxLayerCombinations: 16,
    allowBlindAndBuriedVias: false,
  })
}

test("dense assignment demotes source-layer and wide/narrow collisions without semantic ids", () => {
  const firstIds = [
    "z-wide",
    "filler-a",
    "a-neighbor",
    "filler-b",
    "filler-c",
    "filler-d",
    "filler-e",
    "filler-f",
    "filler-g",
  ]
  const renamedIds = firstIds.map((_, index) => `opaque-${index}`)

  for (const ids of [firstIds, renamedIds]) {
    const solver = createDenseAssignmentSolver(ids)
    const assignment = solver.layerAssignments[0]
    expect(assignment).toBeDefined()
    expect(assignment?.[ids[0]!]).not.toBe(assignment?.[ids[2]!])
    expect(assignment?.[ids[0]!]).not.toBe("top")
    expect(assignment?.[ids[1]!]).not.toBe("top")
    expect(assignment?.[ids[2]!]).not.toBe("top")
    expect(assignment?.["fixed-plane"]).toBe("inner3")
    expect(
      solver.layerAssignments.findIndex(
        (candidate) =>
          candidate[ids[0]!] === candidate[ids[2]!] &&
          candidate[ids[1]!] === "top",
      ),
    ).toBeGreaterThan(0)
  }
})

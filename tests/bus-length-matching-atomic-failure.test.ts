import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec, Point2D } from "lib/types"

const signalPadIndices = [5, 6, 9, 10]

function createBgaObstacles(componentId: string, centerX: number): Obstacle[] {
  return Array.from({ length: 16 }, (_, padIndex) => {
    const pointId = `${componentId}-pad-${padIndex + 1}`
    return {
      obstacleId: pointId,
      componentId,
      type: "rect" as const,
      center: {
        x: centerX + (padIndex % 4) * 0.8 - 1.2,
        y: Math.floor(padIndex / 4) * 0.8 - 1.2,
      },
      width: 0.35,
      height: 0.35,
      layers: ["top"],
      connectedTo: [pointId, `DATA${signalPadIndices.indexOf(padIndex)}`],
    }
  })
}

function getTraceLength(trace: SimplifiedPcbTrace): number {
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined
  let length = 0
  for (const routePoint of trace.route) {
    if (routePoint.route_type !== "wire") {
      previousWire = undefined
      continue
    }
    if (previousWire?.layer === routePoint.layer) {
      length += Math.hypot(
        routePoint.x - previousWire.x,
        routePoint.y - previousWire.y,
      )
    }
    previousWire = routePoint
  }
  return length
}

test("rejects a complete fanout atomically when its corridor cannot fit length matching", () => {
  const leftPads = createBgaObstacles("left-bga", -4)
  const rightPads = createBgaObstacles("right-bga", 4)
  const desiredExitTargets: Record<string, Point2D> = {
    DATA0: { x: 1, y: -0.6 },
    DATA1: { x: 1, y: -0.2 },
    DATA2: { x: 1, y: 0.4 },
    DATA3: { x: 1, y: 0.6 },
  }
  const baselineBus: FanoutBusSpec = {
    busId: "DATA_BUS",
    connectionNames: Object.keys(desiredExitTargets),
    sourceComponentId: "left-bga",
    direction: "right",
    connectionExitTargets: desiredExitTargets,
  }
  const matchedBus: FanoutBusSpec = {
    ...baselineBus,
    maxLengthSkew: 0.25,
  }
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -8, maxX: 6, minY: -4, maxY: 4 },
    obstacles: [...leftPads, ...rightPads],
    connections: signalPadIndices.map((padIndex, connectionIndex) => {
      const sourcePad = leftPads[padIndex]!
      const targetPad = rightPads[padIndex]!
      return {
        name: `DATA${connectionIndex}`,
        pointsToConnect: [
          {
            ...sourcePad.center,
            layer: "top",
            pointId: sourcePad.obstacleId,
          },
          {
            ...targetPad.center,
            layer: "top",
            pointId: targetPad.obstacleId,
          },
        ],
      }
    }),
  }
  // This is exactly the pad-array envelope. The ordinary fanout can escape to
  // its right edge, but there is no copper-free area outside the dense bounds
  // in which the post-route matcher may place a meander.
  const sharedBoundary = {
    minX: -5.375,
    maxX: -2.625,
    minY: -1.375,
    maxY: 1.375,
  }
  const createSolver = (bus: FanoutBusSpec) =>
    new FanoutSolver(
      { ...simpleRouteJson, buses: [bus] },
      {
        buses: [bus],
        sharedBoundary,
        escapeLayers: ["top", "bottom"],
        compactBusTracks: true,
        borderDistribution: "even",
      },
    )

  const baselineSolver = createSolver(baselineBus)
  baselineSolver.solve()
  expect(baselineSolver.failed).toBe(false)
  const baselineLengths = baselineSolver
    .getOutput()
    .fanoutTraces.map(getTraceLength)
  expect(
    Math.max(...baselineLengths) - Math.min(...baselineLengths),
  ).toBeGreaterThan(0.25)

  const matchedSolver = createSolver(matchedBus)
  matchedSolver.solve()
  expect(matchedSolver.solved).toBe(false)
  expect(matchedSolver.failed).toBe(true)
  expect(matchedSolver.error).toContain(
    "Bus DATA_BUS could not satisfy its 0.250000mm routed-length skew within the fanout boundary",
  )
  expect(matchedSolver.attempts).not.toContainEqual(
    expect.objectContaining({
      routedConnectionCount: simpleRouteJson.connections.length,
    }),
  )
  expect(matchedSolver.attempts).toContainEqual(
    expect.objectContaining({
      validationIssues: expect.arrayContaining([
        expect.objectContaining({
          code: "bus-length-skew",
          busId: "DATA_BUS",
        }),
      ]),
    }),
  )
  expect(() => matchedSolver.getOutput()).toThrow(
    "getOutput() called before a complete fanout was solved",
  )
})

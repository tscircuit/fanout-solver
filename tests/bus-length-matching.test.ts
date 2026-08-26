import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
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

test("matches fanout bus lengths after the dense pad escape", async () => {
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
    buses: [matchedBus],
  }
  const sharedBoundary = { minX: -7, maxX: -1, minY: -3, maxY: 3 }
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
  const matchedSolver = createSolver(matchedBus)
  matchedSolver.solve()
  expect(matchedSolver.failed).toBe(false)

  const baselineOutput = baselineSolver.getOutput()
  const matchedOutput = matchedSolver.getOutput()
  expect(matchedOutput.validation).toMatchObject({ valid: true, issues: [] })
  const baselineLengthByConnection = Object.fromEntries(
    baselineOutput.fanoutTraces.map((trace) => [
      trace.connection_name,
      getTraceLength(trace),
    ]),
  )
  const matchedLengths = matchedOutput.fanoutTraces.map(getTraceLength)
  expect(
    Math.max(...matchedLengths) - Math.min(...matchedLengths),
  ).toBeLessThanOrEqual(0.250001)
  expect(
    matchedOutput.fanoutTraces.some(
      (trace) =>
        getTraceLength(trace) -
          (baselineLengthByConnection[trace.connection_name] ?? 0) >
        0.5,
    ),
  ).toBe(true)

  const baselineTraceByConnection = new Map(
    baselineOutput.fanoutTraces.map((trace) => [trace.connection_name, trace]),
  )
  for (const trace of matchedOutput.fanoutTraces) {
    const baselineTrace = baselineTraceByConnection.get(trace.connection_name)!
    expect(trace.route.at(-1)).toEqual(baselineTrace.route.at(-1))
    expect(trace.route.filter((point) => point.route_type === "via")).toEqual(
      baselineTrace.route.filter((point) => point.route_type === "via"),
    )
    expect(
      trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(1)
    for (const point of trace.route) {
      if (!("x" in point)) continue
      expect(point.x).toBeGreaterThanOrEqual(sharedBoundary.minX)
      expect(point.x).toBeLessThanOrEqual(sharedBoundary.maxX)
      expect(point.y).toBeGreaterThanOrEqual(sharedBoundary.minY)
      expect(point.y).toBeLessThanOrEqual(sharedBoundary.maxY)
    }
  }

  await expect(
    getSvgFromGraphicsObject(matchedSolver.visualize()),
  ).toMatchSvgSnapshot(import.meta.path)
})

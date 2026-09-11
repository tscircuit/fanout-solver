import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec, Point2D } from "lib/types"

const signalPadIndices = [5, 10]

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

test("matches complete bus lengths including existing connection prefixes", async () => {
  const leftPads = createBgaObstacles("left-bga", -4)
  const rightPads = createBgaObstacles("right-bga", 4)
  const desiredExitTargets: Record<string, Point2D> = {
    DATA0: { x: 1, y: -0.6 },
    DATA1: { x: 1, y: 0.6 },
  }
  const connectionLengthOffsets: Record<string, number> = {
    DATA0: 2,
    DATA1: 0,
  }
  const bus = {
    busId: "DATA_BUS",
    connectionNames: Object.keys(desiredExitTargets),
    sourceComponentId: "left-bga",
    direction: "right",
    connectionExitTargets: desiredExitTargets,
    connectionLengthOffsets,
    maxLengthSkew: 0.25,
  } satisfies FanoutBusSpec
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -11, maxX: 6, minY: -6, maxY: 6 },
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
    buses: [bus],
  }
  expect(
    () =>
      new FanoutSolver(simpleRouteJson, {
        buses: [
          {
            ...bus,
            connectionLengthOffsets: { NOT_IN_BUS: 1 },
          },
        ],
      }),
  ).toThrow(
    'FanoutSolver: connectionLengthOffsets contains connection "NOT_IN_BUS" outside bus "DATA_BUS"',
  )
  for (const invalidOffset of [-1, Number.NaN, Infinity, -Infinity]) {
    expect(
      () =>
        new FanoutSolver(simpleRouteJson, {
          buses: [
            {
              ...bus,
              connectionLengthOffsets: { DATA0: invalidOffset },
            },
          ],
        }),
    ).toThrow(
      'FanoutSolver: connectionLengthOffsets for connection "DATA0" must be a finite non-negative number',
    )
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary: { minX: -10, maxX: -1, minY: -5, maxY: 5 },
    escapeLayers: ["top", "bottom"],
    compactBusTracks: true,
    borderDistribution: "even",
  })
  solver.solve()
  expect(solver.failed, solver.error ?? undefined).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )

  const completeLengths = output.fanoutTraces.map(
    (trace) =>
      getTraceLength(trace) +
      (connectionLengthOffsets[trace.connection_name] ?? 0),
  )
  expect(
    Math.max(...completeLengths) - Math.min(...completeLengths),
  ).toBeLessThanOrEqual(0.250001)
})

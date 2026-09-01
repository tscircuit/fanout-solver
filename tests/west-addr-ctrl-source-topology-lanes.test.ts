import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutPlansAreClear, routeBusAlternatives } from "lib/route-bus"
import type { FanoutSolverOptions, Point2D } from "lib/types"

const capturedConnectionIndexOffset = 122
const sourcePoints: Point2D[] = [
  { x: -4.5, y: 0.5 },
  { x: -5.5, y: 1 },
  { x: -3.5, y: 0.5 },
  { x: -3, y: 2 },
  { x: -3.5, y: 2 },
  { x: -5.5, y: 1.5 },
  { x: -5, y: 1 },
  { x: -3, y: 0.5 },
]
const targetYs = [
  -2.2915878787878787, -1.7890278787878788, -1.2864678787878787,
  -0.7839078787878786, -0.28134787878787865, 0.22121212121212125,
  0.7237721212121215, 1.2263321212121214,
]
const fixedViaPoints = new Map<number, Point2D>([
  [0, { x: -4.75, y: 0.25 }],
  [1, { x: -5.75, y: 0.75 }],
  [2, { x: -3.75, y: 0.25 }],
  [3, { x: -3.25, y: 1.75 }],
  [4, { x: -3.75, y: 1.75 }],
  [5, { x: -5.75, y: 1.25 }],
  [6, { x: -5.25, y: 0.75 }],
  [7, { x: -3.25, y: 0.25 }],
])
const connectionOrder = [2, 3, 7, 6, 5, 4, 0, 1]

function createFixture(): {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
} {
  const connections = sourcePoints.map((sourcePoint, connectionIndex) => {
    const capturedConnectionIndex =
      connectionIndex + capturedConnectionIndexOffset
    const name = `ADDR_CTRL_${capturedConnectionIndex}`
    const sourceTraceId = `trace-${capturedConnectionIndex}`
    return {
      name,
      source_trace_id: sourceTraceId,
      pointsToConnect: [
        {
          ...sourcePoint,
          layer: "top",
          pointId: `pad-${capturedConnectionIndex}`,
        },
        {
          x: -8.62798,
          y: targetYs[connectionIndex]!,
          layer: "inner6",
          pointId: `exit-${capturedConnectionIndex}`,
        },
      ],
      nominalTraceWidth: 0.08128,
      width: 0.08128,
    }
  })
  const connectionNames = connectionOrder.map(
    (connectionIndex) => connections[connectionIndex]!.name,
  )
  const connectionExitTargets = Object.fromEntries(
    connections.map((connection, connectionIndex) => [
      connection.name,
      { x: -20.0151, y: targetYs[connectionIndex]!, layer: "inner6" },
    ]),
  )
  const inputBus = {
    busId: "DDR_ADDR_CTRL",
    name: "DDR_ADDR_CTRL",
    connectionNames,
    maxLengthSkew: 15,
    preferredLayers: ["inner6"],
    connectionExitTargets,
  }
  const sharedBoundary = {
    minX: -8.62808,
    maxX: 8.62808,
    minY: -8.62808,
    maxY: 8.62808,
  }
  const inputSrj = {
    bounds: sharedBoundary,
    layerCount: 8,
    minTraceWidth: 0.08128,
    nominalTraceWidth: 0.08128,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.05,
    minViaEdgeToPadEdgeClearance: 0.08128,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1016,
    minBoardEdgeClearance: 0.2,
    allowBlindAndBuriedVias: false,
    obstacles: connections.map((connection, connectionIndex) => ({
      obstacleId: connection.pointsToConnect[0]!.pointId,
      componentId: "soc",
      type: "rect" as const,
      shape: "circle" as const,
      layers: ["top"],
      center: sourcePoints[connectionIndex]!,
      width: 0.25616,
      height: 0.25616,
      connectedTo: [
        connection.pointsToConnect[0]!.pointId,
        connection.name,
        connection.source_trace_id,
      ],
    })),
    connections,
    buses: [inputBus],
  } as unknown as SimpleRouteJson
  const options: FanoutSolverOptions = {
    buses: [
      {
        ...inputBus,
        exitPosition: "leftside_center",
        allowedLayers: ["inner6"],
      },
    ],
    sharedBoundary,
    borderDistribution: "even",
    compactBusTracks: true,
    escapeLayers: ["top", "inner4", "inner5", "inner6", "bottom"],
    allowBlindAndBuriedVias: false,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.15,
    maxLayerCombinations: 1,
  }
  return { inputSrj, options }
}

test("routes unbanded west ADDR_CTRL with source-topology lanes", () => {
  const { inputSrj, options } = createFixture()
  const solver = new FanoutSolver(inputSrj, options)
  const addrBus = solver.preparedBuses[0]
  expect(addrBus).toBeDefined()
  if (!addrBus) throw new Error("DDR_ADDR_CTRL was not prepared")
  expect(
    addrBus.connections.map(({ connectionIndex }) => connectionIndex),
  ).toEqual(connectionOrder)
  expect(solver.layerAssignments[0]?.[addrBus.busId]).toBe("inner6")

  const requestedTargets = addrBus.connections.map(
    ({ connectionIndex, exitTargetPoint }) => ({
      connectionIndex,
      exitTargetPoint: exitTargetPoint ? { ...exitTargetPoint } : undefined,
    }),
  )
  const plans = routeBusAlternatives(
    {
      srj: inputSrj,
      bus: addrBus,
      targetLayer: "inner6",
      acceptedPlans: [],
      layerNames: solver.config.layerNames,
      traceWidth: solver.config.traceWidth,
      viaDiameter: solver.config.viaDiameter,
      viaHoleDiameter: solver.config.viaHoleDiameter,
      clearance: solver.config.clearance,
      compactBusTracks: true,
      allowBlindAndBuriedVias: false,
      fixedViaPointsByConnectionIndex: fixedViaPoints,
      reservedVias: [],
      viaMinimalOnly: true,
      fixedViaWindingOnly: true,
      expandedStateBudget: { remaining: 1_500_000 },
    },
    1,
  )[0]

  expect(plans).toHaveLength(8)
  if (!plans) throw new Error("west ADDR_CTRL did not route")
  expect(
    addrBus.connections.map(({ connectionIndex, exitTargetPoint }) => ({
      connectionIndex,
      exitTargetPoint: exitTargetPoint ? { ...exitTargetPoint } : undefined,
    })),
  ).toEqual(requestedTargets)
  for (const plan of plans) {
    expect(plan.via?.center).toEqual(fixedViaPoints.get(plan.connectionIndex))
  }

  const capturedExitLaneOrder = plans
    .toSorted((first, second) => first.exitPoint.y - second.exitPoint.y)
    .map(
      ({ connectionIndex }) => connectionIndex + capturedConnectionIndexOffset,
    )
  expect(capturedExitLaneOrder).toEqual([
    125, 126, 127, 128, 123, 129, 124, 122,
  ])
  expect(plans.every((plan) => (plan.additionalVias ?? []).length === 0)).toBe(
    true,
  )
  expect(
    fanoutPlansAreClear({
      plans,
      srj: inputSrj,
      sharedBoundary: addrBus.sharedBoundary,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: solver.config.allowSameNetMerges,
    }),
  ).toBe(true)
}, 10_000)

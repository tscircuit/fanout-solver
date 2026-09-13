import { expect, test } from "bun:test"
import {
  getBoundaryHandoffReport,
  requestedExitsFromPreparedBuses,
} from "lib/get-boundary-handoff-report"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutRoutePlan, PreparedBus } from "lib/types"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

function boundaryPlan(
  overrides: Partial<FanoutRoutePlan> &
    Pick<FanoutRoutePlan, "connectionName" | "exitPoint">,
): FanoutRoutePlan {
  const exitPoint = overrides.exitPoint
  return {
    busId: "BUS",
    connectionIndex: 0,
    sourcePointIndex: 0,
    sourcePoint: { x: 0, y: 0, layer: "top" },
    sourceObstacle: {
      obstacleId: "pad",
      type: "rect",
      layers: ["top"],
      center: { x: 0, y: 0 },
      width: 0.3,
      height: 0.3,
      connectedTo: [],
    },
    sourceLayer: "top",
    targetPoint: { x: 4, y: exitPoint.y, layer: "top" },
    targetLayer: "top",
    termination: { type: "boundary" },
    direction: "right",
    trace: { type: "pcb_trace", pcb_trace_id: "t", route: [] },
    segments: [
      {
        start: { x: 0, y: 0 },
        end: exitPoint,
        width: 0.1,
        layer: overrides.targetLayer ?? "top",
      },
    ],
    length: 1,
    ...overrides,
  }
}

test("groups boundary exits by physical layer and reports pitch", () => {
  const report = getBoundaryHandoffReport({
    plans: [
      boundaryPlan({
        connectionName: "A",
        exitPoint: { x: 2, y: -0.4 },
        targetLayer: "top",
      }),
      boundaryPlan({
        connectionName: "B",
        exitPoint: { x: 2, y: 0.4 },
        targetLayer: "top",
      }),
      boundaryPlan({
        connectionName: "C",
        exitPoint: { x: 2, y: 0 },
        targetLayer: "inner1",
        segments: [
          {
            start: { x: 0, y: 0 },
            end: { x: 2, y: 0 },
            width: 0.1,
            layer: "inner1",
          },
        ],
      }),
      {
        ...boundaryPlan({
          connectionName: "PLANE",
          exitPoint: { x: 0, y: 0 },
        }),
        termination: { type: "plane", layer: "inner1" },
      },
    ],
  })

  expect(report.endpointCount).toBe(3)
  expect(report.layers.map((layer) => layer.layer)).toEqual(["inner1", "top"])
  expect(report.layers[1]?.actualOrder).toEqual(["A", "B"])
  expect(report.layers[1]?.minimumPitchMm).toBeCloseTo(0.8)
  expect(report.layers[0]?.minimumPitchMm).toBeNull()
  expect(report.minimumPitchMm).toBeCloseTo(0.8)
})

test("counts pairwise inversions against requested layered exits", () => {
  const report = getBoundaryHandoffReport({
    requestedExits: {
      BYTE0: { x: 3, y: -0.6 },
      BYTE1: { x: 3, y: 0 },
      DQS: { x: 3, y: 0.6 },
    },
    plans: [
      boundaryPlan({ connectionName: "BYTE0", exitPoint: { x: 3, y: 0.6 } }),
      boundaryPlan({ connectionName: "BYTE1", exitPoint: { x: 3, y: 0 } }),
      boundaryPlan({ connectionName: "DQS", exitPoint: { x: 3, y: -0.6 } }),
    ],
  })

  expect(report.layers).toHaveLength(1)
  expect(report.layers[0]?.requestedOrder).toEqual(["BYTE0", "BYTE1", "DQS"])
  expect(report.layers[0]?.actualOrder).toEqual(["DQS", "BYTE1", "BYTE0"])
  expect(report.inversionCount).toBe(3)
  expect(report.layers[0]?.endpoints[0]?.deviationMm).toBeCloseTo(1.2)
})

test("requestedExitsFromPreparedBuses keeps only explicit layered targets", () => {
  const buses = [
    {
      connections: [
        {
          connection: { name: "LANE0" },
          hasExplicitLayeredExitTarget: true,
          exitTargetPoint: { x: 2, y: 1, layer: "top" },
          targetPoint: { x: 9, y: 9, layer: "top" },
        },
        {
          connection: { name: "LANE1" },
          hasExplicitLayeredExitTarget: false,
          targetPoint: { x: 9, y: -9, layer: "top" },
        },
      ],
    },
  ] as unknown as PreparedBus[]

  expect(requestedExitsFromPreparedBuses(buses)).toEqual({
    LANE0: { x: 2, y: 1 },
  })
})

test("FanoutSolver output includes a boundary handoff report", () => {
  const fixture = createSingleSignalFanoutFixture({
    direction: "right",
    termination: { type: "boundary" },
  })
  const solver = new FanoutSolver(fixture.simpleRouteJson, {
    buses: [fixture.bus],
  })
  solver.solve()
  expect(solver.solved).toBe(true)

  const output = solver.getOutput()
  expect(output.boundaryHandoff.endpointCount).toBeGreaterThanOrEqual(1)
  expect(output.boundaryHandoff.layers.length).toBeGreaterThanOrEqual(1)
  expect(output.boundaryHandoff.layers[0]?.actualOrder).toContain("SIGNAL")
})

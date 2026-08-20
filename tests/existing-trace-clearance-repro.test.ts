import type {
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

test("visual repro: fanout can cross an existing different-net trace", async () => {
  const preRoutedConnection: SimpleRouteConnection = {
    name: "PRE_ROUTED",
    pointsToConnect: [
      { x: 1, y: -0.75, layer: "top", pointId: "pre-routed-start" },
      { x: 1, y: 0.75, layer: "top", pointId: "pre-routed-end" },
    ],
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 1,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -0.5, maxX: 4.5, minY: -1, maxY: 1 },
    obstacles: [
      {
        obstacleId: "signal-pad",
        componentId: "signal-component",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["SIGNAL", "signal-pad"],
      },
    ],
    connections: [
      {
        name: "SIGNAL",
        pointsToConnect: [
          {
            x: 0,
            y: 0,
            layer: "top",
            pointId: "signal-pad",
            pcb_port_id: "signal-pad",
          },
          { x: 4, y: 0, layer: "top", pointId: "signal-target" },
        ],
      },
    ],
    buses: [
      {
        busId: "signal-bus",
        connectionNames: ["SIGNAL"],
        sourceComponentId: "signal-component",
        direction: "right",
      },
    ] as FanoutBusSpec[],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "pre-routed-trace",
        connection_name: "PRE_ROUTED",
        route: [
          {
            route_type: "wire",
            x: 1,
            y: -0.75,
            width: 0.1,
            layer: "top",
          },
          {
            route_type: "wire",
            x: 1,
            y: 0.75,
            width: 0.1,
            layer: "top",
          },
        ],
      },
    ],
  }

  // A staged caller only passes the active connection to the fanout solver.
  // The final board audit still knows the identity of the earlier trace.
  const auditInputSrj: SimpleRouteJson = {
    ...inputSrj,
    connections: [...inputSrj.connections, preRoutedConnection],
  }
  const cleanInputReport = validateRoutedCopperDrc({
    inputSrj: auditInputSrj,
    routedSrj: auditInputSrj,
    clearance: 0.1,
  })
  expect(cleanInputReport).toMatchObject({ valid: true, issues: [] })

  const solver = new FanoutSolver(inputSrj, {
    sharedBoundary: { minX: -0.25, maxX: 3, minY: -0.75, maxY: 0.75 },
    escapeLayers: ["top"],
  })
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().validation).toMatchObject({
    valid: true,
    issues: [],
  })

  const outputSrj = solver.getOutputSimpleRouteJson()
  expect(outputSrj.traces).toHaveLength(2)

  // The independent emitted-copper audit catches the collision that the
  // solver's plan validation misses.
  const outputReport = validateRoutedCopperDrc({
    inputSrj: auditInputSrj,
    routedSrj: {
      ...outputSrj,
      connections: [...outputSrj.connections, preRoutedConnection],
    },
    clearance: 0.1,
  })
  expect(outputReport.valid).toBe(false)
  expect(outputReport.issues).toHaveLength(1)
  expect(outputReport.issues).toContainEqual(
    expect.objectContaining({
      code: "different-net-trace-clearance",
      traceId: "pre-routed-trace",
      connectionName: "PRE_ROUTED",
      otherConnectionName: "SIGNAL",
      layer: "top",
    }),
  )

  await expect(getPcbSvgFromSrj(inputSrj, outputSrj)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

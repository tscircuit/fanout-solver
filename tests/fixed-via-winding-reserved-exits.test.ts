import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeBus, fanoutPlansAreClear } from "lib/route-bus"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import type { PreparedBus } from "lib/types"

test("fixed-via single-layer winding retries with future exits reserved", async () => {
  const traceWidth = 0.08128
  const clearance = 0.08128
  const sharedBoundary = {
    minX: -8.627,
    maxX: 8.627,
    minY: -8.627,
    maxY: 8.627,
  }
  // An earlier winding lane can close the gap needed by a future terminal.
  const lanes = [
    [-4, -3, -3.75, -3.25, -4.468325454545454],
    [-4.5, -2, -4.25, -2.25, -7.483685454545454],
    [-5.5, -2, -5.25, -2.25, -6.981125454545454],
    [-5.5, -2.5, -5.25, -2.75, -6.478565454545454],
    [-4, -2.5, -3.75, -2.75, -6.057285454545454],
    [-3.5, -3, -3.25, -3.25, -4.970885454545455],
    [-5, -2.5, -4.75, -2.75, -5.894725454545454],
    [-5.5, -3.5, -5.25, -3.75, -5.473445454545454],
  ]
  const obstacles: Obstacle[] = lanes.map(([x, y], index) => ({
    type: "rect",
    shape: "circle",
    obstacleId: `pad:${index}`,
    componentId: "component",
    center: { x, y },
    width: 0.254,
    height: 0.254,
    layers: ["top"],
    connectedTo: [`lane:${index}`, `pad:${index}`],
  }))
  const connections = lanes.map(([x, y, , , exitX], index) => ({
    name: `lane:${index}`,
    pointsToConnect: [
      {
        x,
        y,
        layer: "top",
        pointId: `pad:${index}`,
        pcb_port_id: `pad:${index}`,
      },
      { x: exitX, y: 8.626999999999999, layer: "bottom" },
    ],
  }))
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.1,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: sharedBoundary,
    obstacles,
    connections,
  }
  const prepared = connections.map((connection, index) => ({
    connection,
    connectionIndex: index,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: obstacles[index]!,
    targetPoint: connection.pointsToConnect[1]!,
    exitTargetPoint: connection.pointsToConnect[1]!,
    hasExplicitLayeredExitTarget: true,
  }))
  const bus: PreparedBus = {
    busId: "WIDE",
    direction: "up",
    exitEdge: "top",
    preferredExit: "top",
    termination: { type: "boundary" },
    connections: prepared,
    componentId: "component",
    componentObstacles: obstacles,
    componentBounds: { minX: -6.752, maxX: 6.752, minY: -6.752, maxY: 6.752 },
    sharedBoundary,
    xCoordinates: Array.from({ length: 23 }, (_, i) => -5.5 + i * 0.5),
    yCoordinates: Array.from({ length: 23 }, (_, i) => -5.5 + i * 0.5),
    pitchX: 0.5,
    pitchY: 0.5,
    routableEscapeLayers: ["bottom"],
  }
  const params = {
    srj: inputSrj,
    bus,
    targetLayer: "bottom",
    acceptedPlans: [],
    layerNames: ["top", "bottom"],
    traceWidth,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
    alignWindingGridToPads: true,
    viaMinimalOnly: true,
    fixedViaFallbackRouteOrderAttempts: 1,
    fixedViaPointsByConnectionIndex: new Map(
      lanes.map(([, , x, y], i) => [i, { x, y }]),
    ),
  }
  expect(routeBus(params)).toBeNull()
  const plans = routeBus({
    ...params,
    allowFixedViaReservedExitFallback: true,
  })
  expect(plans).toHaveLength(8)
  if (!plans) throw new Error("Expected every lane to reach its reserved exit")
  expect(fanoutPlansAreClear({ ...params, plans, sharedBoundary })).toBe(true)
  for (const plan of plans) {
    expect(plan.via?.center).toEqual(
      params.fixedViaPointsByConnectionIndex.get(plan.connectionIndex),
    )
    expect(plan.additionalVias ?? []).toHaveLength(0)
    expect(plan.exitPoint).toEqual({
      x: lanes[plan.connectionIndex]![4]!,
      y: sharedBoundary.maxY,
    })
  }
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...inputSrj,
        connections: [],
        traces: plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

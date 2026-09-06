import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeReservedNarrowBusesSteps } from "lib/route-reserved-narrow-buses"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import type { PreparedBus, PreparedConnection } from "lib/types"

test("moves a blocked pair within its corner band while retaining original targets and fixed vias", async () => {
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const pads = [-1, -2].map((x, i) => ({
    type: "rect" as const,
    center: { x, y: 1 },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: [`pair-${i}`],
    componentId: "U1",
  }))
  const connections = pads.map((pad, i) => ({
    name: `pair-${i}`,
    pointsToConnect: [
      { ...pad.center, layer: "top", pointId: `source-${i}` },
      { x: 7, y: 3 + i / 2, layer: "inner1", pointId: `target-${i}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: 0.1,
    bounds: boundary,
    connections,
    obstacles: [
      ...pads,
      {
        type: "rect",
        center: { x: 3, y: 0.75 },
        width: 4,
        height: 8.5,
        layers: ["inner1"],
        connectedTo: [],
      },
    ],
  }
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePoint: connection.pointsToConnect[0]!,
    sourcePointIndex: 0,
    sourceLayer: "top",
    sourceObstacle: pads[i]!,
    targetPoint: connection.pointsToConnect[1]!,
    exitTargetPoint: connection.pointsToConnect[1]!,
    hasExplicitExitTarget: true,
    hasExplicitLayeredExitTarget: true,
  }))
  const bus: PreparedBus = {
    busId: "pair",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -2.15, maxX: -0.85, minY: 0.85, maxY: 1.15 },
    sharedBoundary: boundary,
    xCoordinates: [-2, -1],
    yCoordinates: [1],
    pitchX: 1,
    pitchY: 1,
    termination: { type: "boundary" },
    direction: "right",
    exitEdge: "right",
    preferredExit: "bottom-right",
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    connections: prepared,
  }
  const layerNames = ["top", "inner1", "bottom"]
  const vias = new Map(
    prepared.map((connection) => [
      connection.connectionIndex,
      { x: connection.sourcePoint.x + 0.5, y: 0.5 },
    ]),
  )
  const steps = routeReservedNarrowBusesSteps({
    srj,
    buses: [bus],
    targetLayer: "inner1",
    acceptedPlans: [],
    layerNames,
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    compactBusTracks: false,
    fixedViaPointsByConnectionIndex: vias,
  })
  let result = steps.next()
  while (!result.done) result = steps.next()
  expect(result.value).toHaveLength(2)
  const plans = result.value!
  for (const plan of plans) {
    expect(plan.targetPoint).toEqual(
      prepared[plan.connectionIndex]!.targetPoint,
    )
    expect(plan.via!.center).toEqual(vias.get(plan.connectionIndex)!)
    expect(plan.via!.spanLayers).toEqual(layerNames)
    expect(plan.additionalVias ?? []).toHaveLength(0)
    expect(plan.exitPoint.x).toBe(5)
    expect(plan.exitPoint.y).toBeLessThan(-3.65)
    expect(plan.cornerBandSide).toBe("minimum")
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  const validation = validateFanoutSolution({
    inputSrj: srj,
    outputSrj: output,
    plans,
    preparedBuses: [bus],
    sharedBoundary: boundary,
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  })
  expect(validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 2,
    brokenOutConnectionCount: 2,
    issues: [],
  })
  const svg = getSvgFromGraphicsObject(visualizeSimpleRouteJson(output))
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})

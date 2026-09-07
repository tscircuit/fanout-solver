import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import type { PreparedBus, PreparedConnection } from "lib/types"

test("ordinary wide buses can finish beyond the initial work cap without moving their fixed sources", async () => {
  const layerNames = ["top", "inner1", "bottom"]
  const bounds = { minX: -1, maxX: 47.9, minY: -2, maxY: 9 }
  const rules = {
    traceWidth: 0.05,
    clearance: 0.05,
    viaDiameter: 0.14,
    viaHoleDiameter: 0.07,
  }
  const pads: Obstacle[] = [0, 3, 6].map((y, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: -0.3, y },
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`data-${i}`],
  }))
  const connections: PreparedConnection[] = pads.map((pad, connectionIndex) => {
    const sourcePoint = {
      ...pad.center,
      layer: "top",
      pointId: `pad-${connectionIndex}`,
    }
    const targetPoint = { x: 49, y: pad.center.y, layer: "bottom" }
    return {
      connection: {
        name: `data-${connectionIndex}`,
        pointsToConnect: [sourcePoint, targetPoint],
      },
      connectionIndex,
      sourcePointIndex: 0,
      sourcePoint,
      sourceLayer: "top",
      sourceObstacle: pad,
      targetPoint,
    }
  })
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -0.34, maxX: -0.26, minY: -0.04, maxY: 6.04 },
    sharedBoundary: bounds,
    pitchX: 0.65,
    pitchY: 3,
    xCoordinates: [-0.3],
    yCoordinates: [0, 3, 6],
    termination: { type: "boundary" },
    allowedLayers: ["top", "bottom"],
    routableEscapeLayers: ["top", "bottom"],
    maxLengthSkew: 0.1,
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 3,
    bounds,
    minTraceWidth: rules.traceWidth,
    connections: connections.map((c) => c.connection),
    obstacles: [
      ...pads,
      ...[-0.12, 0.12].map((y) => ({
        type: "rect" as const,
        center: { x: 21.75, y },
        width: 43.1,
        height: 0.05,
        layers: ["bottom"],
        connectedTo: ["channel-wall"],
      })),
    ],
  }
  const plans = connections.map((connection, index) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y },
      exitPoint = { x: bounds.maxX, y: viaPoint.y }
    return buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      allowBlindAndBuriedVias: false,
      targetLayerPoints:
        index === 0
          ? [
              viaPoint,
              ...Array.from({ length: 9 }, (_, i) => ({
                x: (i + 1) * 4.8,
                y: 0,
              })),
              exitPoint,
            ]
          : [
              viaPoint,
              { x: 1, y: viaPoint.y },
              { x: 2, y: viaPoint.y + 1 },
              { x: bounds.maxX - 1, y: viaPoint.y + 1 },
              exitPoint,
            ],
    })
  })
  const original = structuredClone(plans)
  const params = {
    inputSrj,
    plans,
    preparedBuses: [bus],
    sharedBoundary: bounds,
    clearance: rules.clearance,
    allowBlindAndBuriedVias: false,
  }
  // The long spans run through a narrow channel. The shorter final span is
  // the first physically usable tuning site, after the initial work budget.
  expect(matchBusPlanLengths({ ...params, maximumWorkUnits: 1000 })).toEqual({
    plans: null,
    failedBus: bus,
  })
  expect(plans).toEqual(original)
  const result = matchBusPlanLengths(params).plans
  expect(result).not.toBeNull()
  expect(plans).toEqual(original)
  expect(result![1]).toBe(plans[1])
  expect(result![2]).toBe(plans[2])
  expect(result![0]!.length).toBeGreaterThan(plans[0]!.length + 0.7)
  expect(result![0]!.segments.slice(0, 10)).toEqual(
    plans[0]!.segments.slice(0, 10),
  )
  for (const [index, plan] of result!.entries()) {
    expect(plan.via).toEqual(plans[index]!.via)
    expect(plan.additionalVias).toEqual(plans[index]!.additionalVias)
    expect(plan.segments[0]).toEqual(plans[index]!.segments[0])
    expect(plan.exitPoint).toEqual(plans[index]!.exitPoint)
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result!,
    layerNames,
  })
  expect(
    validateFanoutSolution({ ...params, outputSrj, plans: result! }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 3,
    checkedViaCount: 3,
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

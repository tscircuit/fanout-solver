import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("grows a retained transit-layer fold atomically inside a narrow tuning window", async () => {
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const bounds = { minX: -3, maxX: 8, minY: -1, maxY: 3 }
  const rules = {
    traceWidth: 0.05,
    clearance: 0.05,
    viaDiameter: 0.14,
    viaHoleDiameter: 0.07,
  }
  const pads: Obstacle[] = [
    { x: -0.3, y: 0 },
    { x: -2, y: 2 },
  ].map((center, i) => ({
    type: "rect",
    shape: "circle",
    center,
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`D${i}`],
  }))
  const connections: PreparedConnection[] = pads.map(
    (sourceObstacle, connectionIndex) => {
      const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `P${connectionIndex}`,
      }
      const targetPoint = { x: 9, y: sourcePoint.y, layer: "bottom" }
      return {
        connection: {
          name: `D${connectionIndex}`,
          pointsToConnect: [sourcePoint, targetPoint],
        },
        connectionIndex,
        sourcePointIndex: 0,
        sourcePoint,
        sourceLayer: "top",
        sourceObstacle,
        targetPoint,
      }
    },
  )
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -2.04, maxX: -0.26, minY: -0.04, maxY: 2.04 },
    sharedBoundary: bounds,
    pitchX: 1.7,
    pitchY: 2,
    xCoordinates: [-2, -0.3],
    yCoordinates: [0, 2],
    termination: { type: "boundary" },
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    maxLengthSkew: 0.05,
    connections,
  }
  const walls: Obstacle[] = [
    { x: 0.3, y: 0.18, width: 1.3, height: 0.1 },
    { x: 4.8, y: 0.18, width: 6.5, height: 0.1 },
    { x: 4, y: -0.18, width: 8.7, height: 0.1 },
  ].map(({ x, y, width, height }) => ({
    type: "rect",
    center: { x, y },
    width,
    height,
    layers: ["inner1", "bottom"],
    connectedTo: ["wall"],
  }))
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    bounds,
    minTraceWidth: rules.traceWidth,
    connections: connections.map((c) => c.connection),
    obstacles: [
      ...pads,
      ...walls,
      ...[-1, 1].map((sign) => ({
        type: "rect" as const,
        center: { x: 5.2, y: sign * 0.13 },
        width: 5.6,
        height: 0.1,
        layers: ["bottom"],
        connectedTo: ["tail-wall"],
      })),
    ],
  }
  const plans = connections.map((connection, index) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y },
      exitPoint = { x: 8, y: viaPoint.y }
    const plan = buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: index ? "bottom" : "inner1",
      allowBlindAndBuriedVias: false,
      targetLayerPoints: index
        ? [viaPoint, exitPoint]
        : [
            viaPoint,
            { x: 1, y: 0 },
            { x: 1.1, y: 0.1 },
            { x: 1.1, y: 0.4 },
            { x: 1.2, y: 0.5 },
            { x: 1.3, y: 0.5 },
            { x: 1.4, y: 0.4 },
            { x: 1.4, y: 0.1 },
            { x: 1.5, y: 0 },
            { x: 2, y: 0 },
            exitPoint,
          ],
    })
    if (index) return plan
    const returnPoint = { x: 2, y: 0 }
    return {
      ...plan,
      targetLayer: "bottom",
      additionalVias: [
        {
          center: returnPoint,
          fromLayer: "inner1",
          toLayer: "bottom",
          diameter: rules.viaDiameter,
          holeDiameter: rules.viaHoleDiameter,
          spanLayers: layerNames,
        },
      ],
      segments: plan.segments.map((segment, i) =>
        i === plan.segments.length - 1
          ? { ...segment, layer: "bottom" }
          : segment,
      ),
      trace: {
        ...plan.trace,
        route: [
          ...plan.trace.route.slice(0, -1),
          {
            route_type: "via" as const,
            ...returnPoint,
            from_layer: "inner1",
            to_layer: "bottom",
            via_diameter: rules.viaDiameter,
            via_hole_diameter: rules.viaHoleDiameter,
          },
          {
            route_type: "wire" as const,
            ...returnPoint,
            layer: "bottom",
            width: rules.traceWidth,
          },
          {
            route_type: "wire" as const,
            ...exitPoint,
            layer: "bottom",
            width: rules.traceWidth,
          },
        ],
      },
    }
  })
  const original = structuredClone({ inputSrj, plans })
  const params = {
    ...rules,
    plans,
    preparedBuses: [bus],
    inputSrj,
    sharedBoundary: bounds,
    allowBlindAndBuriedVias: false,
    maximumWorkUnits: 1000,
  }
  expect(matchBusPlanLengths(params).plans === null).toBe(true)
  expect(
    matchBusPlanLengths({ ...params, allowDistributedMatching: true }).plans,
  ).toBeNull()
  const result = matchBusPlanLengths({
    ...params,
    allowTransitLayerMatching: true,
    allowDistributedMatching: true,
  }).plans
  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected the entire pair to match")
  expect({ inputSrj, plans }).toEqual(original)
  expect(result[1]).toBe(plans[1])
  expect(result[0]!.segments).toHaveLength(plans[0]!.segments.length)
  for (const [i, plan] of result.entries()) {
    expect(plan.via).toEqual(plans[i]!.via)
    expect(plan.additionalVias).toEqual(plans[i]!.additionalVias)
    expect(plan.segments[0]).toEqual(plans[i]!.segments[0])
    expect(plan.exitPoint).toEqual(plans[i]!.exitPoint)
    for (const [index, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.abs(dx) < 1e-7 ||
          Math.abs(dy) < 1e-7 ||
          Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-7,
      ).toBe(true)
      const previous = plan.segments[index - 1]
      if (!previous || previous.layer !== segment.layer) continue
      const px = previous.end.x - previous.start.x
      const py = previous.end.y - previous.start.y
      expect(
        (px * dx + py * dy) / Math.hypot(px, py) / Math.hypot(dx, dy),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result,
    layerNames,
  })
  expect(
    validateFanoutSolution({ ...params, plans: result, outputSrj }),
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
    checkedTraceCount: 2,
    checkedViaCount: 3,
  })
  const forbidden = {
    ...bus,
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
  }
  expect(
    matchBusPlanLengths({
      ...params,
      preparedBuses: [forbidden],
      allowTransitLayerMatching: true,
      allowDistributedMatching: true,
    }).plans,
  ).toBeNull()
  expect(
    matchBusPlanLengths({
      ...params,
      allowTransitLayerMatching: true,
      allowDistributedMatching: true,
      maximumWorkUnits: 0,
    }).plans,
  ).toBeNull()
  expect({ inputSrj, plans }).toEqual(original)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

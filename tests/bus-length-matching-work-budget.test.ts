import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { rerouteOverlongBusLanesSteps } from "lib/reroute-overlong-bus-lanes"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "lib/types"

test("matching work exhaustion is atomic and lets bounded lane cleanup finish a physically valid bus", async () => {
  const layerNames = ["top", "inner1", "bottom"],
    bounds = { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    rules = {
      traceWidth: 0.05,
      clearance: 0.05,
      viaDiameter: 0.14,
      viaHoleDiameter: 0.07,
    }
  const sources = [
    { x: -1.5, y: -0.5 },
    { x: -1.5, y: 0.5 },
    { x: -0.85, y: 0.9 },
  ]
  const pads: Obstacle[] = sources.map((center, index) => ({
    type: "rect",
    shape: "circle",
    center,
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`net-${index}`],
  }))
  const connections: PreparedConnection[] = sources.map(
    (source, connectionIndex) => {
      const sourcePoint = {
          ...source,
          layer: "top",
          pointId: `pad-${connectionIndex}`,
        },
        targetPoint = { x: 3, y: source.y, layer: "bottom" }
      return {
        connection: {
          name: `net-${connectionIndex}`,
          pointsToConnect: [
            sourcePoint,
            ...(connectionIndex < 2 ? [targetPoint] : []),
          ],
        },
        connectionIndex,
        sourcePointIndex: 0,
        sourcePoint,
        sourceLayer: "top",
        sourceObstacle: pads[connectionIndex]!,
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
    componentBounds: { minX: -1.54, maxX: -0.81, minY: -0.54, maxY: 0.94 },
    sharedBoundary: bounds,
    pitchX: 0.65,
    pitchY: 1,
    xCoordinates: [-1.5, -0.85],
    yCoordinates: [-0.5, 0.5, 0.9],
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    maxLengthSkew: 0.4,
    connections: connections.slice(0, 2),
  }
  const plane: PreparedBus = {
    ...bus,
    busId: "PLANE",
    exitEdge: undefined,
    preferredExit: undefined,
    connections: [connections[2]!],
    termination: { type: "plane", layer: "inner1" },
    allowedLayers: ["inner1"],
    maxLengthSkew: undefined,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 3,
    bounds,
    minTraceWidth: rules.traceWidth,
    connections: connections.map((connection) => connection.connection),
    obstacles: [
      ...pads,
      {
        type: "rect",
        center: { x: -0.3, y: 0.5 },
        width: 0.4,
        height: 0.4,
        layers: ["bottom"],
        connectedTo: ["blocker"],
      },
    ],
  }
  const plans = connections.map((connection, i) => {
    const viaPoint = {
        x: connection.sourcePoint.x + 0.25,
        y: connection.sourcePoint.y,
      },
      exitPoint = i === 2 ? viaPoint : { x: 2, y: viaPoint.y }
    return buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus: i === 2 ? plane : bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: i === 2 ? "inner1" : "bottom",
      allowBlindAndBuriedVias: false,
      targetLayerPoints:
        i === 1
          ? [
              viaPoint,
              { x: -1.25, y: 1.3 },
              { x: -1.05, y: 1.5 },
              { x: 1.25, y: 1.5 },
              { x: 1.5, y: 1.25 },
              { x: 1.5, y: 1 },
              exitPoint,
            ]
          : [viaPoint, exitPoint],
    })
  })
  const original = structuredClone(plans),
    params = {
      ...rules,
      layerNames,
      inputSrj,
      plans,
      preparedBuses: [bus, plane],
      selectedBusIds: new Set(["DATA"]),
    }
  const run = (maximumSearchStates?: number) => {
    const steps = rerouteOverlongBusLanesSteps({
      ...params,
      ...(maximumSearchStates === undefined ? {} : { maximumSearchStates }),
    })
    let next = steps.next()
    while (!next.done) next = steps.next()
    return next.value
  }
  const matchingParams = {
    plans,
    preparedBuses: [bus, plane],
    inputSrj,
    sharedBoundary: bounds,
    clearance: rules.clearance,
    allowBlindAndBuriedVias: false,
  }
  // Decline the initial tuning pass without committing any partial meander.
  expect(
    matchBusPlanLengths({ ...matchingParams, maximumWorkUnits: 1 }),
  ).toEqual({ plans: null, failedBus: bus })
  expect(plans).toEqual(original)
  const shortened = run()!
  expect(shortened).not.toBeNull()
  const matched = matchBusPlanLengths({ ...matchingParams, plans: shortened })
  expect(matched.plans).not.toBeNull()
  const result = matched.plans!
  expect(result).not.toBeNull()
  expect(result[1]!.length).toBeLessThan(plans[1]!.length - 0.5)
  expect(result[0]).toBe(plans[0])
  expect(result[2]).toBe(plans[2])
  for (const [index, plan] of result.entries()) {
    expect(plan.via).toEqual(plans[index]!.via)
    expect(plan.exitPoint).toEqual(plans[index]!.exitPoint)
    const oldViaIndex = plans[index]!.trace.route.findIndex(
        (point) => point.route_type === "via",
      ),
      newViaIndex = plan.trace.route.findIndex(
        (point) => point.route_type === "via",
      )
    expect(plan.trace.route.slice(0, newViaIndex + 1)).toEqual(
      plans[index]!.trace.route.slice(0, oldViaIndex + 1),
    )
    expect(plan.additionalVias).toEqual(plans[index]!.additionalVias)
    expect(plan.sourceLayer).toBe(plans[index]!.sourceLayer)
    expect(plan.targetLayer).toBe(plans[index]!.targetLayer)
  }
  expect(plans).toEqual(original)
  const output = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj: output,
      plans: result,
      preparedBuses: [bus, plane],
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 3,
    checkedViaCount: 3,
  })
  expect(
    matchBusPlanLengths({
      ...matchingParams,
      plans: result,
      maximumWorkUnits: 0,
    }).plans,
  ).toEqual(result)
  expect(() =>
    matchBusPlanLengths({ ...matchingParams, maximumWorkUnits: -1 }),
  ).toThrow("maximumWorkUnits must be a non-negative safe integer")
  const graphics = visualizeSimpleRouteJson({ ...output, connections: [] })
  for (const segment of plans[1]!.segments.filter(
    (segment) => segment.layer === "bottom",
  )) {
    graphics.lines ??= []
    graphics.lines.push({
      points: [segment.start, segment.end],
      strokeColor: "#94a3b8",
      strokeWidth: 0.02,
      strokeDash: "0.05 0.05",
    } as NonNullable<typeof graphics.lines>[number])
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

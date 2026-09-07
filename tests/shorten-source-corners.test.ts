import "bun-match-svg"
import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { distance } from "../lib/geometry"
import type { PeripheralSourceEscape } from "../lib/route-peripheral-source-escapes"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import { shortenSourceEscapeCorners } from "../lib/shorten-source-corners"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
} from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("shortens a source corner around reserved copper without moving its vias or bridge", async () => {
  const boundary = { minX: -1, maxX: 6, minY: -2, maxY: 5 }
  const layerNames = ["top", "inner1", "bottom"]
  const traceWidth = 0.1
  const clearance = 0.1
  const definitions = [
    { name: "LONG", source: { x: 0, y: 0 }, target: { x: 7, y: 4 } },
    { name: "SHORT", source: { x: 0, y: -1 }, target: { x: 7, y: -0.7 } },
    {
      name: "RESERVED",
      source: { x: 1.675, y: 1.475 },
      target: { x: 1.675, y: 1.475 },
    },
  ]
  const obstacles = definitions.map(({ name, source }) => ({
    type: "rect" as const,
    shape: "circle" as const,
    componentId: name,
    center: source,
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [name],
  }))
  const connections = definitions.map(({ name, source, target }, index) => ({
    name,
    pointsToConnect: [
      {
        ...source,
        layer: "top",
        pointId: `source-${index}`,
        pcb_port_id: `port-${index}`,
      },
      { ...target, layer: "bottom", pointId: `target-${index}` },
    ],
  }))
  const prepared: PreparedConnection[] = connections.map(
    (connection, index) => ({
      connection,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0],
      sourceLayer: "top",
      sourceObstacle: obstacles[index],
      targetPoint: connection.pointsToConnect[1],
    }),
  )
  const buses: PreparedBus[] = [[0, 1], [2]].map((indices, index) => ({
    busId: index === 0 ? "DATA" : "PLANE",
    direction: "right",
    ...(index === 0
      ? {
          exitEdge: "right" as const,
          preferredExit: "right" as const,
          maxLengthSkew: 5,
        }
      : {}),
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    termination:
      index === 0 ? { type: "boundary" } : { type: "plane", layer: "inner1" },
    componentId: index === 0 ? "DATA" : "RESERVED",
    componentObstacles: indices.map((i) => obstacles[i]),
    componentBounds: boundary,
    sharedBoundary: boundary,
    connections: indices.map((i) => prepared[i]),
    xCoordinates: [0],
    yCoordinates: [-1, 0],
    pitchX: 1,
    pitchY: 1,
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: traceWidth,
    bounds: boundary,
    obstacles,
    connections,
  }
  const paths: Point2D[][] = [
    [
      prepared[0].sourcePoint,
      { x: 3.8, y: 0 },
      { x: 4, y: 0.2 },
      { x: 4, y: 4 },
    ],
    [prepared[1].sourcePoint, { x: 0.3, y: -0.7 }],
    [prepared[2].sourcePoint, { x: 2, y: 1.8 }],
  ]
  const makePlan = (index: number, sourceOnly = false): FanoutRoutePlan => {
    const plane = index === 2 || sourceOnly
    const bus = buses[index === 2 ? 1 : 0]
    const path = paths[index]
    const viaPoint = path.at(-1)!
    const bridge = { x: 5, y: viaPoint.y }
    const exit = { x: boundary.maxX, y: viaPoint.y }
    const plan = buildViaMinimalWindingPlan({
      bus: plane
        ? { ...bus, termination: { type: "plane", layer: "inner1" } }
        : bus,
      terminal: {
        connection: prepared[index],
        viaPoint,
        exitPoint: plane ? viaPoint : bridge,
      },
      targetLayer: "inner1",
      targetLayerPoints: plane ? [viaPoint] : [viaPoint, bridge],
      sourceEscapePoints: path,
      layerNames,
      traceWidth,
      viaDiameter: 0.3,
      viaHoleDiameter: 0.15,
      allowBlindAndBuriedVias: false,
    })
    if (plane) return plan
    const extraVia = {
      center: bridge,
      diameter: 0.3,
      holeDiameter: 0.15,
      fromLayer: "inner1",
      toLayer: "bottom",
      spanLayers: layerNames,
    }
    return {
      ...plan,
      targetLayer: "bottom",
      exitPoint: exit,
      additionalVias: [extraVia],
      segments: [
        ...plan.segments,
        { start: bridge, end: exit, width: traceWidth, layer: "bottom" },
      ],
      length: plan.length + distance(bridge, exit),
      trace: {
        ...plan.trace,
        route: [
          ...plan.trace.route,
          {
            route_type: "via",
            ...bridge,
            from_layer: "inner1",
            to_layer: "bottom",
            via_diameter: 0.3,
            via_hole_diameter: 0.15,
          },
          { route_type: "wire", ...bridge, width: traceWidth, layer: "bottom" },
          {
            route_type: "wire",
            ...exit,
            width: traceWidth,
            layer: "bottom",
            end_pcb_port_id: `end-${index}`,
          },
        ],
      },
    }
  }
  const plans = definitions.map((_, index) => makePlan(index))
  const sourceEscapes: PeripheralSourceEscape[] = plans.map((plan, index) => ({
    connectionIndex: index,
    connectionName: plan.connectionName,
    segments: plan.segments.slice(0, paths[index].length - 1),
    // Nominal landing metadata can differ from the actual bridge landing.
    via: { ...plan.via!, toLayer: index === 2 ? "inner1" : "bottom" },
  }))
  const params = {
    srj,
    layerNames,
    traceWidth,
    clearance,
    allowBlindAndBuriedVias: false,
    preparedBuses: buses,
    sourceEscapes,
  }
  const snapshot = JSON.stringify({ plans, sourceEscapes })
  const limited = shortenSourceEscapeCorners({
    ...params,
    plans,
    maximumCandidates: 1,
  })
  expect(limited.candidateCount).toBe(1)
  expect(limited.changedCornerCount).toBe(0)
  const result = shortenSourceEscapeCorners({ ...params, plans })
  expect(result.changedCornerCount).toBeGreaterThan(0)
  expect(result.candidateCount).toBeLessThanOrEqual(8192)
  expect(plans[0].length - result.plans[0].length).toBeGreaterThan(1)
  expect(result.plans[0].segments[0].end.x).toBeGreaterThan(0.5)
  expect(JSON.stringify({ plans, sourceEscapes })).toBe(snapshot)
  for (const [index, plan] of result.plans.entries()) {
    const original = plans[index]
    expect(plan.sourcePoint).toBe(original.sourcePoint)
    expect(plan.targetPoint).toBe(original.targetPoint)
    expect(plan.exitPoint).toBe(original.exitPoint)
    expect(plan.via).toBe(original.via)
    expect(plan.additionalVias).toBe(original.additionalVias)
    expect(result.sourceEscapes[index].via).toBe(sourceEscapes[index].via)
    expect(plan.sourceEscapeSegmentCount).toBe(
      original.sourceEscapeSegmentCount,
    )
    const suffix = (p: FanoutRoutePlan) =>
      p.trace.route.slice(
        p.trace.route.findIndex((point) => point.route_type === "via"),
      )
    expect(suffix(plan)).toEqual(suffix(original))
    expect(plan.trace.route[0]).toEqual(original.trace.route[0])
    expect(plan.segments.slice(paths[index].length - 1)).toEqual(
      original.segments.slice(paths[index].length - 1),
    )
  }
  expect(result.plans[0].via!.toLayer).toBe("inner1")
  expect(result.sourceEscapes[0].via.toLayer).toBe("bottom")
  const sourceOnly = shortenSourceEscapeCorners({
    ...params,
    plans: [plans[2]],
  })
  expect(sourceOnly.plans).toEqual([plans[2]])
  expect(sourceOnly.sourceEscapes).toEqual(result.sourceEscapes)
  const sourcesAlone = shortenSourceEscapeCorners({ ...params, plans: [] })
  expect(sourcesAlone.plans).toEqual([])
  expect(sourcesAlone.sourceEscapes).toEqual(result.sourceEscapes)
  const stubs = definitions.map((_, index) => makePlan(index, true))
  const shortenedStubs = shortenSourceEscapeCorners({ ...params, plans: stubs })
  expect(shortenedStubs.plans[0].trace.route.slice(-2)).toEqual(
    stubs[0].trace.route.slice(-2),
  )
  expect(shortenedStubs.sourceEscapes).toEqual(result.sourceEscapes)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: result.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: result.plans,
      preparedBuses: buses,
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 3,
    brokenOutConnectionCount: 3,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const graphics = visualizeSimpleRouteJson({ ...output, connections: [] })
  graphics.lines!.unshift(
    ...plans[0].segments.slice(0, 3).map((segment) => ({
      points: [segment.start, segment.end],
      strokeColor: "#888888",
      strokeWidth: 0.035,
      strokeDash: [0.12, 0.12],
    })),
  )
  graphics.texts = [
    {
      x: 1.8,
      y: -0.4,
      text: "Before: dashed source corner",
      color: "#777777",
      fontSize: 0.2,
    },
    {
      x: 1.2,
      y: 2.4,
      text: "Reserved through-via",
      color: "#222222",
      fontSize: 0.2,
    },
    {
      x: 4.75,
      y: 4.5,
      text: "Unchanged vias and bridge",
      color: "#222222",
      fontSize: 0.2,
    },
  ]
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

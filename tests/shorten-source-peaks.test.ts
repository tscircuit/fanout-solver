import "bun-match-svg"
import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { distance } from "../lib/geometry"
import {
  createOrthogonalFanoutView,
  ORTHOGONAL_MATRICES,
} from "../lib/orthogonal-fanout-view"
import type { PeripheralSourceEscape } from "../lib/route-peripheral-source-escapes"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import { shortenSourceEscapePeaks } from "../lib/shorten-source-peaks"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
} from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("moves a source peak inward while preserving the complete via suffix and a pending source rail", async () => {
  const boundary = { minX: -1, maxX: 8, minY: -2, maxY: 4 }
  const layerNames = ["top", "inner1", "bottom"]
  const traceWidth = 0.1
  const clearance = 0.1
  const definitions = [
    { name: "LONG", source: { x: 0, y: 0 }, target: { x: 9, y: 0 } },
    { name: "SHORT", source: { x: 0, y: -1 }, target: { x: 9, y: -0.7 } },
    {
      name: "RESERVED",
      source: { x: 3, y: 0 },
      target: { x: 3, y: 0 },
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
          maxLengthSkew: 20,
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
      { x: 0, y: 1 },
      { x: 2, y: 3 },
      { x: 4, y: 3 },
      { x: 6, y: 1 },
      { x: 6, y: 0 },
    ],
    [
      prepared[1].sourcePoint,
      { x: 0.8, y: -1 },
      { x: 1, y: -0.8 },
      { x: 1, y: -0.5 },
    ],
    [prepared[2].sourcePoint, { x: 3, y: 2 }],
  ]
  const makePlan = (index: number, sourceOnly = false): FanoutRoutePlan => {
    const plane = index === 2 || sourceOnly
    const bus = buses[index === 2 ? 1 : 0]
    const path = paths[index]
    const viaPoint = path.at(-1)!
    const bridge = { x: 7, y: viaPoint.y }
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
  const result = shortenSourceEscapePeaks({ ...params, plans })
  expect(result.changedCornerCount).toBe(1)
  expect(result.candidateCount).toBeLessThan(64)
  expect(result.plans[0].length).toBeLessThan(plans[0].length - 0.4)
  expect(
    Math.max(...result.sourceEscapes[0].segments.map((s) => s.end.y)),
  ).toBeGreaterThan(2.25)
  expect(result.plans[1]).toBe(plans[1])
  expect(result.sourceEscapes[1]).toBe(sourceEscapes[1])
  expect(result.plans[2]).toBe(plans[2])
  const pending = shortenSourceEscapePeaks({
    ...params,
    plans: plans.slice(0, 2),
  })
  expect(pending.plans).toEqual(result.plans.slice(0, 2))
  expect(pending.sourceEscapes).toEqual(result.sourceEscapes)
  const floor = plans[0].length - 0.2
  const floored = shortenSourceEscapePeaks({
    ...params,
    plans,
    minimumRetainedLengthByConnectionIndex: new Map([[0, floor]]),
  })
  expect(floored.plans[0].length).toBeGreaterThanOrEqual(floor - 1e-7)
  expect(floored.plans[1]).toBe(plans[1])
  const stub = makePlan(0, true)
  const stubbed = shortenSourceEscapePeaks({
    ...params,
    plans: [stub, plans[1], plans[2]],
  })
  expect(stubbed.sourceEscapes[0]).toEqual(result.sourceEscapes[0])
  expect(stubbed.plans[0].trace.route.slice(-2)).toEqual(
    stub.trace.route.slice(-2),
  )
  expect(stubbed.plans[0].via).toBe(stub.via)
  expect(() =>
    shortenSourceEscapePeaks({ ...params, plans, maximumCandidates: 0 }),
  ).toThrow()
  expect(() =>
    shortenSourceEscapePeaks({
      ...params,
      plans: [
        { ...plans[0], sourceEscapeSegmentCount: 100 },
        plans[1],
        plans[2],
      ],
    }),
  ).toThrow()
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
  }
  const matched = result.plans
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: matched,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: matched,
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
  for (const matrix of Object.values(ORTHOGONAL_MATRICES)) {
    const view = createOrthogonalFanoutView(matrix)
    const transformed = view.toCanonical({ ...params, plans })
    const rotated = shortenSourceEscapePeaks(transformed)
    expect(rotated.plans[0].length).toBeCloseTo(result.plans[0].length, 8)
    expect(rotated.plans[0].via).toBe(transformed.plans[0].via)
    expect(rotated.plans[0].additionalVias).toBe(
      transformed.plans[0].additionalVias,
    )
    expect(rotated.sourceEscapes[2]).toBe(transformed.sourceEscapes[2])
    const rotatedOutput = buildOutputSimpleRouteJson({
      inputSrj: transformed.srj,
      plans: rotated.plans,
      layerNames,
    })
    expect(
      validateRoutedCopperDrc({
        inputSrj: transformed.srj,
        routedSrj: rotatedOutput,
        clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({ valid: true, issues: [] })
  }
  const graphics = visualizeSimpleRouteJson({ ...output, connections: [] })
  graphics.lines!.unshift(
    ...plans[0].segments
      .slice(0, plans[0].sourceEscapeSegmentCount)
      .map((segment) => ({
        points: [segment.start, segment.end],
        strokeColor: "#888888",
        strokeWidth: 0.035,
        strokeDash: [0.12, 0.12],
      })),
  )
  graphics.texts = [
    {
      x: 2.5,
      y: -1.45,
      text: "Short source prefix preserved",
      color: "#222222",
      fontSize: 0.2,
    },
    {
      x: 3,
      y: 3.35,
      text: "Original source detour",
      color: "#777777",
      fontSize: 0.2,
    },
    {
      x: 4.35,
      y: 1.15,
      text: "Reserved through-via",
      color: "#222222",
      fontSize: 0.2,
    },
    {
      x: 6.65,
      y: -0.3,
      text: "Unchanged vias and bridge",
      color: "#222222",
      fontSize: 0.2,
    },
  ]
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

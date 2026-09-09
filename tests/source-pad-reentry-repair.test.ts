import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { repairSourcePadReentries } from "lib/repair-source-pad-reentries"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { getSourcePadReentries } from "lib/source-pad-reentry"
import type { Point2D } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

function fixture(rotated = false, repetitions = 1) {
  const rotate = (p: Point2D): Point2D => (rotated ? { x: -p.y, y: p.x } : p)
  const bounds = { minX: -4, maxX: 4, minY: -4, maxY: 4 }
  const rules = {
    layerNames: ["top", "bottom"],
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
  }
  const source = { x: 0, y: 0 },
    viaPoint = rotate({ x: 0, y: 2 }),
    exitPoint = rotate({ x: 4, y: 2 })
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: rules.traceWidth,
    connections: [
      {
        name: "lead",
        pointsToConnect: [
          { ...source, layer: "top" },
          { ...exitPoint, layer: "bottom" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: source,
        width: 1.4,
        height: 0.3,
        ccwRotationDegrees: rotated ? 90 : 0,
        layers: ["top"],
        componentId: "U1",
        connectedTo: ["lead"],
      },
      {
        type: "rect",
        center: rotate({ x: 0, y: 0.8 }),
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "lead-bus",
        sourceComponentId: "U1",
        connectionNames: ["lead"],
        direction: rotated ? "up" : "right",
        preferredExit: rotated ? "top" : "right",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const bus = preparedBuses[0]!
  const plan = buildViaMinimalWindingPlan({
    ...rules,
    bus,
    terminal: { connection: bus.connections[0]!, viaPoint, exitPoint },
    targetLayer: "bottom",
    targetLayerPoints: [viaPoint, exitPoint],
    sourceEscapePoints: [
      source,
      ...Array.from({ length: repetitions }, () => [
        { x: 1, y: 0 },
        { x: 1, y: 1.5 },
        { x: -1, y: 1.5 },
        { x: -1, y: 0 },
        source,
      ]).flat(),
      { x: 1, y: 0 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ].map(rotate),
    allowBlindAndBuriedVias: false,
  })
  return { ...rules, inputSrj, plans: [plan], preparedBuses, rotate }
}

test("repairs own-pad reentry through a clear pad end while retaining the first via and target copper", async () => {
  const params = fixture()
  const before = JSON.stringify(params)
  const original = params.plans[0]!
  const validate = (plans: typeof params.plans) =>
    validateFanoutSolution({
      inputSrj: params.inputSrj,
      outputSrj: buildOutputSimpleRouteJson({
        inputSrj: params.inputSrj,
        plans,
        layerNames: params.layerNames,
      }),
      plans,
      preparedBuses: params.preparedBuses,
      sharedBoundary: params.preparedBuses[0]!.sharedBoundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    })
  expect(
    validate(params.plans).issues.some(
      (issue) => issue.code === "source-pad-reentry",
    ),
  ).toBe(true)
  expect(
    new Set(
      getSourcePadReentries(original, params.clearance).map((i) => i.kind),
    ),
  ).toEqual(new Set(["outline", "copper", "clearance"]))
  const repaired = repairSourcePadReentries(params)
  expect(repaired).not.toBeNull()
  const result = repaired![0]!
  expect(validate(repaired!).valid).toBe(true)
  expect(getSourcePadReentries(result, params.clearance)).toEqual([])
  expect(result.length).toBeLessThan(original.length)
  expect(result.via).toBe(original.via)
  expect(result.targetLayer).toBe(original.targetLayer)
  expect(result.exitPoint).toBe(original.exitPoint)
  expect(result.sourcePoint).toBe(original.sourcePoint)
  expect(result.segments.slice(result.sourceEscapeSegmentCount)).toEqual(
    original.segments.slice(original.sourceEscapeSegmentCount),
  )
  expect(
    result.trace.route.slice(
      result.trace.route.findIndex((p) => p.route_type === "via"),
    ),
  ).toEqual(
    original.trace.route.slice(
      original.trace.route.findIndex((p) => p.route_type === "via"),
    ),
  )
  expect(JSON.stringify(params)).toBe(before)
  const routedSrj = {
    ...params.inputSrj,
    traces: repaired!.map((p) => p.trace),
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: params.inputSrj,
      routedSrj,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const turned = fixture(true)
  const turnedResult = repairSourcePadReentries(turned)![0]!
  expect(turnedResult).toBeDefined()
  expect(getSourcePadReentries(turnedResult, turned.clearance)).toEqual([])
  expect(turnedResult.segments).toHaveLength(result.segments.length)
  for (const [i, segment] of result.segments.entries()) {
    for (const end of ["start", "end"] as const) {
      expect(turnedResult.segments[i]![end].x).toBeCloseTo(
        turned.rotate(segment[end]).x,
        7,
      )
      expect(turnedResult.segments[i]![end].y).toBeCloseTo(
        turned.rotate(segment[end]).y,
        7,
      )
    }
  }
  // A strict later source-layer return cannot be repaired by moving the prefix.
  const returned = {
    ...result,
    segments: [
      ...result.segments,
      {
        start: { x: 2, y: 0 },
        end: { x: 0, y: 0 },
        layer: "top",
        width: params.traceWidth,
      },
    ],
  }
  expect(
    getSourcePadReentries(returned, params.clearance).length,
  ).toBeGreaterThan(0)
  expect(repairSourcePadReentries({ ...params, plans: [returned] })).toBeNull()
  // A barrier across every pad-end approach must leave the original untouched.
  const blocked = {
    ...params,
    inputSrj: {
      ...params.inputSrj,
      obstacles: [
        ...params.inputSrj.obstacles,
        {
          type: "rect" as const,
          center: { x: 0, y: 0.4 },
          width: 7.99,
          height: 0.1,
          layers: ["top"],
          connectedTo: [],
        },
      ],
    },
  }
  expect(repairSourcePadReentries(blocked)).toBeNull()
  expect(repairSourcePadReentries({ ...params, plans: repaired! })![0]).toBe(
    result,
  )
  // The actual first via remains a candidate beyond the bounded early anchors.
  const longPrefix = fixture(false, 15)
  expect(longPrefix.plans[0]!.sourceEscapeSegmentCount).toBeGreaterThan(64)
  expect(repairSourcePadReentries(longPrefix)![0]!.segments).toEqual(
    result.segments,
  )
  const nearPad = (y: number) => ({
    ...result,
    segments: [
      {
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        layer: "top",
        width: params.traceWidth,
      },
      {
        start: { x: 1, y: 0 },
        end: { x: 1, y },
        layer: "top",
        width: params.traceWidth,
      },
      {
        start: { x: 1, y },
        end: { x: -1, y },
        layer: "top",
        width: params.traceWidth,
      },
    ],
  })
  expect(
    getSourcePadReentries(nearPad(0.25), params.clearance).map((i) => i.kind),
  ).toEqual(["clearance"])
  expect(
    getSourcePadReentries(nearPad(0.18), params.clearance).map((i) => i.kind),
  ).toEqual(["copper", "clearance"])
  expect(
    getSourcePadReentries(nearPad(0.15 - 5e-8), params.clearance).map(
      (i) => i.kind,
    ),
  ).toEqual(["outline", "copper", "clearance"])
  expect(getSourcePadReentries(nearPad(0.3), params.clearance)).toEqual([])
  const supplied = {
    type: "pcb_trace" as const,
    pcb_trace_id: "held-source-corridor",
    connection_name: "guard",
    route: [
      {
        route_type: "wire" as const,
        x: -1,
        y: -0.3,
        width: params.traceWidth,
        layer: "top",
      },
      {
        route_type: "wire" as const,
        x: -1,
        y: 2.5,
        width: params.traceWidth,
        layer: "top",
      },
    ],
  }
  const guarded = {
    ...params,
    inputSrj: {
      ...params.inputSrj,
      connections: [
        ...params.inputSrj.connections,
        {
          name: "guard",
          pointsToConnect: [
            { x: -1, y: -0.3, layer: "top" },
            { x: -1, y: 2.5, layer: "top" },
          ],
        },
      ],
      traces: [supplied],
    },
  }
  const guardedResult = repairSourcePadReentries(guarded)![0]!
  expect(guardedResult.segments[0]!.end.x).toBeGreaterThan(0)
  expect(getSourcePadReentries(guardedResult, params.clearance)).toEqual([])
  expect(guarded.inputSrj.traces[0]).toBe(supplied)
  expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

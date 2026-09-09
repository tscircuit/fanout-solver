import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { prepareFanoutBuses } from "lib/prepare-buses"
import {
  createFanoutPlanClearanceValidator,
  fanoutPlansAreClear,
} from "lib/route-bus"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { getSourcePadReentries } from "lib/source-pad-reentry"
import type { FanoutBusSpec } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

function fixture(
  options: {
    obstacleNet?: "same" | "foreign" | "unknown"
    secondTermination?: "plane" | "boundary"
    sourceReentry?: boolean
  } = {},
) {
  const bounds = { minX: -1, maxX: 1.5, minY: -1, maxY: 1.2 }
  const rules = {
    layerNames: ["top", "inner1", "inner2", "bottom"],
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const sources = [
    { x: 0, y: 0 },
    { x: 0.45, y: -0.6 },
  ]
  const viaPoints = [
    { x: 0.72928, y: 0.25 },
    { x: 0.45, y: 0.8 },
  ]
  const secondIsBoundary = options.secondTermination === "boundary"
  const exitPoints = [
    viaPoints[0]!,
    secondIsBoundary ? { x: 0.45, y: bounds.maxY } : viaPoints[1]!,
  ]
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((source, i) => ({
      name: `GND_${i}`,
      netConnectionName: "GND",
      pointsToConnect: [
        { ...source, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i === 1 && secondIsBoundary
          ? [{ ...exitPoints[i]!, layer: "inner1" }]
          : []),
      ],
    })),
    obstacles: [
      ...sources.map((source, i) => ({
        type: "rect" as const,
        shape: "circle",
        center: source,
        width: 0.254,
        height: 0.254,
        layers: ["top"],
        componentId: `U${i}`,
        obstacleId: `P${i}`,
        connectedTo: [`GND_${i}`, `P${i}`],
      })),
      {
        type: "rect",
        shape: "circle",
        center: { x: 0.45, y: 0.25 },
        width: 0.24,
        height: 0.24,
        layers: rules.layerNames,
        componentId: "C1",
        obstacleId: "existing-decoupler-via",
        connectedTo:
          options.obstacleNet === "unknown"
            ? []
            : options.obstacleNet === "foreign"
              ? ["VCC"]
              : ["GND_0"],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "existing-decoupler-trace",
        connection_name: "existing-decoupler-connection",
        connectsTo: ["GND_0"],
        route: [
          {
            route_type: "wire",
            x: 0.45,
            y: 0.25,
            layer: "top",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: 0.6,
            y: 0.25,
            layer: "top",
            width: rules.traceWidth,
          },
        ],
      },
    ],
  }
  const buses: FanoutBusSpec[] = sources.map((_, i) => ({
    busId: `bus${i}`,
    sourceComponentId: `U${i}`,
    connectionNames: [`GND_${i}`],
    direction: "up",
    ...(i === 1 && secondIsBoundary
      ? { preferredExit: "top", allowedLayers: ["inner1"] }
      : { termination: { type: "plane", layer: "inner1" } }),
  }))
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses,
  })
  const paths = [
    [
      sources[0]!,
      ...(options.sourceReentry
        ? [
            { x: 0.5, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: -0.5, y: 0.5 },
            { x: -0.5, y: 0 },
            sources[0]!,
          ]
        : []),
      { x: 0.32928, y: 0.25 },
      viaPoints[0]!,
    ],
    [sources[1]!, viaPoints[1]!],
  ]
  const plans = preparedBuses.map((bus, i) =>
    buildViaMinimalWindingPlan({
      ...rules,
      bus,
      terminal: {
        connection: bus.connections[0]!,
        viaPoint: viaPoints[i]!,
        exitPoint: exitPoints[i]!,
      },
      targetLayer: "inner1",
      targetLayerPoints:
        i === 1 && secondIsBoundary
          ? [viaPoints[i]!, exitPoints[i]!]
          : [viaPoints[i]!],
      sourceEscapePoints: paths[i]!,
      allowBlindAndBuriedVias: false,
    }),
  )
  return {
    ...rules,
    inputSrj,
    preparedBuses,
    plans,
    repairPlaneSourceCorners: true,
  }
}

test("normalizes plane sources through existing and emitted same-net copper without merging signal branches", async () => {
  const params = fixture()
  const before = JSON.stringify(params)
  const normalized = normalizeFanoutPlanCorners(params)
  expect(normalized).not.toBeNull()
  expect(JSON.stringify(params)).toBe(before)
  expect(normalized![0]!.segments).not.toEqual(params.plans[0]!.segments)
  expect(normalized![1]).toBe(params.plans[1])
  for (const [i, plan] of normalized!.entries()) {
    expect(plan.via).toBe(params.plans[i]!.via)
    expect(plan.exitPoint).toBe(params.plans[i]!.exitPoint)
    expect(plan.trace.route[0]).toBe(params.plans[i]!.trace.route[0])
    expect(getSourcePadReentries(plan, params.clearance)).toEqual([])
    for (const [index, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const next = plan.segments[index + 1]
      if (!next || next.layer !== segment.layer) continue
      const nx = next.end.x - next.start.x
      const ny = next.end.y - next.start.y
      expect(
        (dx * nx + dy * ny) / Math.hypot(dx, dy) / Math.hypot(nx, ny),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: params.inputSrj,
    plans: normalized!,
    layerNames: params.layerNames,
  })
  expect(outputSrj.traces).toContainEqual(params.inputSrj.traces![0]!)
  const checkClearance = (
    input: ReturnType<typeof fixture>,
    plans: typeof params.plans,
    allowSameNetPlaneMerges: boolean,
    expected: boolean,
  ) => {
    const rules = {
      srj: input.inputSrj,
      sharedBoundary: input.inputSrj.bounds,
      clearance: input.clearance,
      allowBlindAndBuriedVias: false,
      ...(allowSameNetPlaneMerges ? { allowSameNetPlaneMerges: true } : {}),
    }
    expect(fanoutPlansAreClear({ ...rules, plans })).toBe(expected)
    expect(createFanoutPlanClearanceValidator(rules)(plans)).toBe(expected)
  }
  checkClearance(params, normalized!, true, true)
  checkClearance(params, normalized!, false, false)
  // Reusing immutable geometry must not reuse another termination's permission.
  // This small pad touches a segment and is clear of every physical via.
  const cacheInput: SimpleRouteJson = {
    ...params.inputSrj,
    traces: [],
    obstacles: [
      ...params.inputSrj.obstacles.filter(
        (obstacle) => obstacle.obstacleId !== "existing-decoupler-via",
      ),
      {
        type: "rect",
        center: { x: 0.32928, y: 0.25 },
        width: 0.1,
        height: 0.1,
        layers: ["top"],
        connectedTo: ["GND"],
      },
    ],
  }
  const plane = normalized![0]!
  const signal = { ...plane, termination: { type: "boundary" as const } }
  for (const candidates of [
    [plane, signal],
    [signal, plane],
  ]) {
    const clear = createFanoutPlanClearanceValidator({
      srj: cacheInput,
      sharedBoundary: cacheInput.bounds,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetPlaneMerges: true,
    })
    for (const candidate of candidates) {
      expect(clear([candidate])).toBe(candidate === plane)
    }
  }
  expect(
    validateFanoutSolution({
      inputSrj: params.inputSrj,
      outputSrj,
      plans: normalized!,
      preparedBuses: params.preparedBuses,
      sharedBoundary: params.inputSrj.bounds,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 2, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: params.inputSrj,
      routedSrj: {
        ...params.inputSrj,
        traces: normalized!.map((plan) => plan.trace),
      },
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })

  // An electrical name must resolve to the plane net; unknown copper stays hard.
  for (const obstacleNet of ["foreign", "unknown"] as const) {
    const blocked = fixture({ obstacleNet })
    expect(normalizeFanoutPlanCorners(blocked)).toBeNull()
    checkClearance(blocked, blocked.plans, true, false)
  }
  const unknownTrace = fixture()
  unknownTrace.inputSrj = {
    ...unknownTrace.inputSrj,
    traces: unknownTrace.inputSrj.traces!.map((trace) => ({
      ...trace,
      connectsTo: [],
    })),
  }
  expect(normalizeFanoutPlanCorners(unknownTrace)).toBeNull()
  checkClearance(unknownTrace, unknownTrace.plans, true, false)
  // Sharing a net does not authorize joining ordinary boundary signal branches.
  const boundary = fixture({ secondTermination: "boundary" })
  boundary.inputSrj = {
    ...boundary.inputSrj,
    obstacles: boundary.inputSrj.obstacles.filter(
      (obstacle) => obstacle.obstacleId !== "existing-decoupler-via",
    ),
    traces: [],
  }
  expect(normalizeFanoutPlanCorners(boundary)).toBeNull()
  checkClearance(boundary, boundary.plans, true, false)
  const returned = fixture({ sourceReentry: true })
  expect(
    getSourcePadReentries(returned.plans[0]!, returned.clearance).some(
      (issue) => issue.kind === "outline",
    ),
  ).toBe(true)
  expect(normalizeFanoutPlanCorners(returned)).toBeNull()

  const graphics = visualizeSimpleRouteJson({ ...outputSrj, connections: [] })
  graphics.lines ??= []
  for (const line of graphics.lines) line.strokeColor = "#2563eb"
  for (const segment of params.plans[0]!.segments) {
    graphics.lines.push({
      points: [segment.start, segment.end],
      strokeColor: "#ef4444",
      strokeWidth: 0.012,
    })
  }
  graphics.texts ??= []
  graphics.texts.push({
    x: 0.25,
    y: 1.03,
    text: "Shared plane copper: original red, normalized blue",
    fontSize: 0.09,
    anchorSide: "bottom_left",
  })
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

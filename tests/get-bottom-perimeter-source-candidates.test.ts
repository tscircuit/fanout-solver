import { expect, test } from "bun:test"
import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { getBottomPerimeterSourceCandidates } from "../lib/get-bottom-perimeter-source-candidates"
import { fanoutPlansAreClear } from "../lib/route-bus"
import type { PeripheralSourceEscape } from "../lib/route-peripheral-source-escapes"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("clears an outer source barrier and a blocked projected via without changing the exit", async () => {
  const width = 0.08
  const clearance = 0.08
  const boundary = { minX: -3, maxX: 3, minY: -1.85, maxY: 3 }
  const sourceBoundary = { minX: -1, maxX: 1, minY: -1, maxY: 1 }
  const sourcePoint = { x: 0, y: 0.5, layer: "top" }
  const targetPoint = { x: 0, y: -2.5, layer: "inner1" }
  const sourceObstacle = {
    type: "rect" as const,
    shape: "circle" as const,
    center: sourcePoint,
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: ["signal"],
    componentId: "BGA",
  }
  const connection = {
    name: "signal",
    pointsToConnect: [sourcePoint, targetPoint],
  }
  const prepared: PreparedConnection = {
    connection,
    connectionIndex: 0,
    sourcePointIndex: 0,
    sourcePoint,
    targetPoint,
    sourceObstacle,
    sourceLayer: "top",
  }
  const bus: PreparedBus = {
    busId: "signal",
    componentId: "BGA",
    componentObstacles: [sourceObstacle],
    componentBounds: sourceBoundary,
    xCoordinates: [-0.65, 0, 0.65],
    yCoordinates: [-0.15, 0.5, 1.15],
    pitchX: 0.65,
    pitchY: 0.65,
    sharedBoundary: boundary,
    direction: "down",
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    connections: [prepared],
    termination: { type: "boundary" },
    exitEdge: "bottom",
    preferredExit: "bottom",
  }
  const viaBlocker = {
    type: "rect" as const,
    shape: "circle" as const,
    center: { x: 0, y: -1.64002 },
    width: 0.12,
    height: 0.12,
    layers: ["inner1"],
    connectedTo: [],
  }
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: width,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    connections: [connection],
    obstacles: [
      sourceObstacle,
      ...[-1.5, 1.5].map((x) => ({
        type: "rect" as const,
        center: { x, y: -0.5 },
        width: 1.2,
        height: 2,
        layers: ["top"],
        connectedTo: [],
      })),
      viaBlocker,
    ],
  }
  const params = {
    srj,
    bus,
    sourceBoundary,
    connection: prepared,
    traceWidth: width,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "bottom"],
    targetLayer: "inner1",
    allowBlindAndBuriedVias: false,
  }
  const sourceEscape: PeripheralSourceEscape = {
    connectionIndex: 0,
    connectionName: "signal",
    segments: [
      { start: sourcePoint, end: { x: -0.325, y: 0.175 }, width, layer: "top" },
    ],
    via: {
      center: { x: -0.325, y: 0.175 },
      diameter: 0.24,
      holeDiameter: 0.1,
      fromLayer: "top",
      toLayer: "inner1",
      spanLayers: params.layerNames,
    },
  }
  const before = JSON.stringify({ params, sourceEscape })
  const planFor = (candidate: PeripheralSourceEscape) =>
    buildViaMinimalWindingPlan({
      ...params,
      terminal: {
        connection: prepared,
        viaPoint: candidate.via.center,
        exitPoint: candidate.via.center,
      },
      sourceEscapePoints: [
        candidate.segments[0]!.start,
        ...candidate.segments.map((s) => s.end),
      ],
      targetLayerPoints: [candidate.via.center, candidate.via.center],
    })
  const clear = (candidate: PeripheralSourceEscape) =>
    fanoutPlansAreClear({
      ...params,
      sharedBoundary: boundary,
      plans: [planFor(candidate)],
    })
  const legacy = [
    ...getBottomPerimeterSourceCandidates({
      ...params,
      sourceEscape,
      maximumCandidates: 128,
    }),
  ]
  expect(legacy.some(clear)).toBe(false)
  const expanded = [
    ...getBottomPerimeterSourceCandidates({
      ...params,
      sourceEscape,
      maximumCandidates: 2048,
    }),
  ]
  expect(expanded.slice(0, legacy.length)).toEqual(legacy)
  const selected = expanded.find(clear)
  expect(selected).toBeDefined()
  if (!selected)
    throw Error("Expected a bounded outer-column and via-offset escape")
  const viaPitch = params.viaDiameter + clearance + 1e-5
  expect(Math.abs(selected.via.center.x)).toBeCloseTo(viaPitch, 8)
  expect(
    Math.min(...selected.segments.flatMap((s) => [s.start.x, s.end.x])),
  ).toBeLessThan(sourceBoundary.minX - 3 * viaPitch)
  const via = selected.via.center
  const exit = { x: targetPoint.x, y: boundary.minY }
  const bend = {
    x: via.x + Math.sign(exit.x - via.x) * (via.y - exit.y),
    y: exit.y,
  }
  const plan = buildViaMinimalWindingPlan({
    ...params,
    terminal: { connection: prepared, viaPoint: via, exitPoint: exit },
    sourceEscapePoints: [
      selected.segments[0]!.start,
      ...selected.segments.map((s) => s.end),
    ],
    targetLayerPoints: [via, bend, exit],
  })
  expect(
    fanoutPlansAreClear({ ...params, sharedBoundary: boundary, plans: [plan] }),
  ).toBe(true)
  expect(plan.targetPoint).toEqual(targetPoint)
  expect(plan.sourcePoint).toEqual(sourcePoint)
  expect(plan.exitEdge).toBe("bottom")
  expect(plan.via?.spanLayers).toEqual(sourceEscape.via.spanLayers)
  expect(JSON.stringify({ params, sourceEscape })).toBe(before)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: [plan],
    layerNames: params.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 1, issues: [] })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: [plan],
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 1, issues: [] })
  await expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(output)),
  ).toMatchSvgSnapshot(import.meta.path)
})

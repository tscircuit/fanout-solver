import { expect, test } from "bun:test"
import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { repairSourceViaChain } from "../lib/repair-source-via-chain"
import { fanoutPlansAreClear } from "../lib/route-bus"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

function fixture() {
  const traceWidth = 0.08128
  const clearance = 0.08128
  const layerNames = ["top", "bottom"]
  const boundary = { minX: -2.4, maxX: 2.4, minY: -1.5, maxY: 1.5 }
  const xs = [-1.3, -0.65, 0, 0.65, 1.3]
  const ys = [-0.975, -0.325, 0.325, 0.975]
  const definitions = [
    { name: "A", x: 0.65, y: 0.325, viaX: 0.975 },
    { name: "B", x: 0, y: 0.325, viaX: 0.325 },
    { name: "C", x: -0.65, y: 0.325, viaX: -0.325 },
    { name: "D", x: -1.3, y: -0.325, viaX: -0.975 },
  ]
  const pads = xs.flatMap((x) =>
    ys.map((y) => ({
      type: "rect" as const,
      shape: "circle" as const,
      center: { x, y },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [
        definitions.find((d) => d.x === x && d.y === y)?.name ??
          `dummy-${x}-${y}`,
      ],
    })),
  )
  const blockers = [
    [-1.625, 0],
    [-1.625, -0.65],
    [-0.975, -0.65],
  ].map(([x, y]) => ({
    type: "rect" as const,
    center: { x: x!, y: y! },
    width: 0.05,
    height: 0.05,
    layers: layerNames,
    connectedTo: [],
  }))
  const connections = definitions.map((d) => ({
    name: d.name,
    pointsToConnect: [
      { x: d.x, y: d.y, layer: "top", pointId: `source-${d.name}` },
      { x: d.x, y: -2, layer: "bottom", pointId: `plane-${d.name}` },
    ],
  }))
  const railConnection = {
    name: "PROTECTED_RAIL",
    pointsToConnect: [
      { x: -2.3, y: 0.65, layer: "top", pointId: "rail-source" },
      { x: 2.7, y: 0.65, layer: "top", pointId: "rail-target" },
    ],
  }
  const railPad = {
    type: "rect" as const,
    center: { x: -2.3, y: 0.65 },
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    connectedTo: ["PROTECTED_RAIL"],
  }
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    bounds: boundary,
    obstacles: [...pads, ...blockers, railPad],
    connections: [...connections, railConnection],
  }
  const prepared: PreparedConnection[] = connections.map(
    (connection, connectionIndex) => ({
      connection,
      connectionIndex,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceLayer: "top",
      sourceObstacle: pads.find(
        (p) =>
          p.center.x === definitions[connectionIndex]!.x &&
          p.center.y === definitions[connectionIndex]!.y,
      )!,
      targetPoint: connection.pointsToConnect[1]!,
    }),
  )
  const bus: PreparedBus = {
    busId: "SOURCE_DROPS",
    connections: prepared,
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -1.45, maxX: 1.45, minY: -1.125, maxY: 1.125 },
    xCoordinates: xs,
    yCoordinates: ys,
    pitchX: 0.65,
    pitchY: 0.65,
    sharedBoundary: boundary,
    direction: "left",
    termination: { type: "plane", layer: "bottom" },
    allowedLayers: ["bottom"],
  }
  const railPrepared: PreparedConnection = {
    connection: railConnection,
    connectionIndex: 4,
    sourcePointIndex: 0,
    sourcePoint: railConnection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: railPad,
    targetPoint: railConnection.pointsToConnect[1]!,
  }
  const railBus: PreparedBus = {
    ...bus,
    busId: "PROTECTED_RAIL",
    componentId: "U2",
    componentObstacles: [],
    componentBounds: { minX: -2.3, maxX: -2.3, minY: 0.65, maxY: 0.65 },
    connections: [railPrepared],
    xCoordinates: [-2.3],
    yCoordinates: [0.65],
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    termination: { type: "boundary" },
    allowedLayers: ["top"],
  }
  const rail: FanoutRoutePlan = {
    ...railPrepared,
    busId: railBus.busId,
    connectionName: railConnection.name,
    targetLayer: "top",
    direction: "right",
    exitEdge: "right",
    termination: { type: "boundary" },
    exitPoint: { x: boundary.maxX, y: 0.65 },
    length: 4.7,
    segments: [
      {
        start: railPrepared.sourcePoint,
        end: { x: boundary.maxX, y: 0.65 },
        layer: "top",
        width: traceWidth,
      },
    ],
    trace: {
      type: "pcb_trace",
      pcb_trace_id: "protected-rail",
      connection_name: railConnection.name,
      route: [railPrepared.sourcePoint, { x: boundary.maxX, y: 0.65 }].map(
        (p) => ({
          route_type: "wire" as const,
          ...p,
          layer: "top",
          width: traceWidth,
        }),
      ),
    },
  }
  const sourceEscapes = definitions.map((d, connectionIndex) => ({
    connectionIndex,
    connectionName: d.name,
    segments: [
      {
        start: prepared[connectionIndex]!.sourcePoint,
        end: { x: d.viaX, y: 0 },
        width: traceWidth,
        layer: "top",
      },
    ],
    via: {
      center: { x: d.viaX, y: 0 },
      diameter: 0.24,
      holeDiameter: 0.1,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: layerNames,
    },
  }))
  const params = {
    srj,
    buses: [bus],
    acceptedPlans: [rail],
    sourceEscapes,
    requestedEscape: {
      ...sourceEscapes[0]!,
      via: { ...sourceEscapes[0]!.via, center: { x: 0.325, y: 0 } },
      segments: [
        { ...sourceEscapes[0]!.segments[0]!, end: { x: 0.325, y: 0 } },
      ],
    },
    traceWidth,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames,
    allowBlindAndBuriedVias: false,
  }
  return {
    params,
    sourceEscapes,
    srj,
    bus,
    railBus,
    rail,
    boundary,
    layerNames,
    clearance,
  }
}

test("repairs a three-source displacement chain with a short outer escape and protects an existing rail", async () => {
  const f = fixture()
  const before = JSON.stringify(f.params)
  expect(
    repairSourceViaChain({ ...f.params, maximumMovedConnections: 2 }),
  ).toBeNull()
  const result = repairSourceViaChain({
    ...f.params,
    maximumMovedConnections: 3,
  })
  expect(result).not.toBeNull()
  if (!result) throw Error("Expected source-chain recovery")
  expect(result.changedConnectionIndices).toEqual([0, 1, 2, 3])
  for (const [i, point] of [
    { x: 0.325, y: 0 },
    { x: -0.325, y: 0 },
    { x: -0.975, y: 0 },
    { x: -1.66144, y: -0.325 },
  ].entries()) {
    expect(result.sourceEscapes[i]!.via.center.x).toBeCloseTo(point.x, 9)
    expect(result.sourceEscapes[i]!.via.center.y).toBeCloseTo(point.y, 9)
  }
  expect(result.retainedPlans).toEqual([f.rail])
  expect(result.retainedPlans[0]).toBe(f.rail)
  expect(result.sourcePlans.find((p) => p.connectionIndex === 4)).toBe(f.rail)
  expect(JSON.stringify(f.params)).toBe(before)
  for (const p of result.sourcePlans.filter((p) => p.connectionIndex < 4)) {
    const original = f.bus.connections.find(
      (c) => c.connectionIndex === p.connectionIndex,
    )!
    expect(p.sourceObstacle).toBe(original.sourceObstacle)
    expect(p.sourcePoint).toEqual(original.sourcePoint)
    expect(p.targetPoint).toEqual(original.targetPoint)
    expect(p.via?.spanLayers).toEqual(f.layerNames)
  }
  expect(
    fanoutPlansAreClear({
      ...f.params,
      plans: result.sourcePlans,
      sharedBoundary: f.boundary,
    }),
  ).toBe(true)
  const output = buildOutputSimpleRouteJson({
    inputSrj: f.srj,
    plans: result.sourcePlans,
    layerNames: f.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: f.srj,
      routedSrj: output,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 5 })
  expect(
    validateFanoutSolution({
      inputSrj: f.srj,
      outputSrj: output,
      plans: result.sourcePlans,
      preparedBuses: [f.bus, f.railBus],
      sharedBoundary: f.boundary,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...f.srj,
        connections: [],
        traces: result.sourcePlans.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

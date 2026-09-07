import { expect, test } from "bun:test"
import "bun-match-svg"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { fanoutPlansAreClear } from "../lib/route-bus"
import { routeShortDeclaredLayerBridgeSteps as routeDeclaredLayerBridgeSteps } from "../lib/route-declared-layer-bridge"
import {
  buildViaMinimalWindingPlan,
  routeViaMinimalWindingAlternativesSteps,
} from "../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"
import { makeDeclaredLayerBridgeFixture } from "./fixtures/declared-layer-bridge-fixture"

function finish<T>(steps: Generator<unknown, T, void>): T {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

test("defers a blocked first lane while preserving the three reachable lanes before its declared bridge", async () => {
  const f = makeDeclaredLayerBridgeFixture()
  const definitions = [
    { name: "BRIDGED", x: 1, y: -1, track: 0.6 },
    { name: "LOW", x: -2, y: 1, track: 1.3 },
    { name: "MIDDLE", x: 0, y: 1, track: 2.2 },
    { name: "HIGH", x: 2, y: 1, track: 3.1 },
  ]
  const pads = definitions.map((d) => ({
    type: "rect" as const,
    center: { x: d.x, y: d.y },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [d.name],
  }))
  const connections = definitions.map((d, i) => ({
    name: d.name,
    pointsToConnect: [
      { ...pads[i]!.center, layer: "top", pointId: `source-${i}` },
      { x: -5, y: d.track, layer: "bottom", pointId: `target-${i}` },
    ],
  }))
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: pads[i]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    ...f.bus,
    connections: prepared,
    componentObstacles: pads,
    componentBounds: { minX: -2.15, maxX: 2.15, minY: -1.15, maxY: 1.15 },
    xCoordinates: [-2, 0, 1, 2],
    yCoordinates: [-1, 1],
    maxLengthSkew: undefined,
  }
  const wallConnection = { ...f.wallBus.connections[0]!, connectionIndex: 4 }
  const wallBus: PreparedBus = { ...f.wallBus, connections: [wallConnection] }
  const wall = { ...f.wall, connectionIndex: 4 }
  const srj = {
    ...f.srj,
    obstacles: [...pads, f.wallBus.componentObstacles[0]!],
    connections: [...connections, wallConnection.connection],
  }
  const sourceEscapes = prepared.map((connection) => ({
    connectionIndex: connection.connectionIndex,
    connectionName: connection.connection.name,
    segments: [
      {
        start: connection.sourcePoint,
        end: {
          x: connection.sourcePoint.x + 0.35,
          y: connection.sourcePoint.y + 0.35,
        },
        width: f.width,
        layer: "top",
      },
    ],
    via: {
      center: {
        x: connection.sourcePoint.x + 0.35,
        y: connection.sourcePoint.y + 0.35,
      },
      diameter: 0.24,
      holeDiameter: 0.1,
      spanLayers: f.layerNames,
      fromLayer: "top",
      toLayer: "bottom",
    },
  }))
  const terminals = prepared.map((connection, i) => ({
    connection,
    viaPoint: sourceEscapes[i]!.via.center,
    exitPoint: { x: -4, y: definitions[i]!.track },
  }))
  const params = {
    ...f.params,
    srj,
    bus,
    terminals,
    sourceEscapes,
    acceptedPlans: [wall],
    maximumDirectOrders: 1,
  }
  const sourcePlans = terminals.map((terminal, i) =>
    buildViaMinimalWindingPlan({
      ...params,
      terminal: { ...terminal, exitPoint: terminal.viaPoint },
      sourceEscapePoints: [
        sourceEscapes[i]!.segments[0]!.start,
        terminal.viaPoint,
      ],
      targetLayerPoints: [terminal.viaPoint, terminal.viaPoint],
    }),
  )
  const before = JSON.stringify({ params, sourcePlans })
  expect(
    finish(
      routeViaMinimalWindingAlternativesSteps(
        {
          ...params,
          sourceEscapePaths: new Map(
            sourceEscapes.map((source) => [
              source.connectionIndex,
              [source.segments[0]!.start, source.via.center],
            ]),
          ),
          reservedVias: sourceEscapes.map((source) => ({
            connectionName: source.connectionName,
            via: source.via,
          })),
          gridStep: f.width,
          maximumRouteOrderAttempts: 1,
        },
        1,
        false,
      ),
    ),
  ).toHaveLength(0)
  const result = finish(
    routeDeclaredLayerBridgeSteps({ ...params, sourcePlans }),
  )
  expect(result?.plans).toHaveLength(4)
  if (!result) throw Error("Expected deferred bridge completion")
  expect(result.searchCount).toBeLessThan(100)
  expect(JSON.stringify({ params, sourcePlans })).toBe(before)
  const plans = [wall, ...result.plans]
  for (const plan of result.plans) {
    const original = prepared[plan.connectionIndex]!
    const source = sourceEscapes[plan.connectionIndex]!
    expect(plan.sourcePoint).toEqual(original.sourcePoint)
    expect(plan.targetPoint).toEqual(original.targetPoint)
    expect(plan.sourceObstacle).toBe(original.sourceObstacle)
    expect(plan.segments.slice(0, plan.sourceEscapeSegmentCount)).toEqual(
      source.segments,
    )
    expect(plan.via?.center).toEqual(source.via.center)
    expect(plan.via?.spanLayers).toEqual(f.layerNames)
    expect(plan.exitPoint).toEqual(terminals[plan.connectionIndex]!.exitPoint)
    expect(plan.cornerBandSide).toBe("maximum")
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.additionalVias).toHaveLength(
      plan.connectionName === "BRIDGED" ? 1 : 0,
    )
  }
  expect(
    fanoutPlansAreClear({ ...params, plans, sharedBoundary: f.boundary }),
  ).toBe(true)
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames: f.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: outputSrj,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj,
      plans,
      preparedBuses: [bus, wallBus],
      sharedBoundary: f.boundary,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 5, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

import { expect, test } from "bun:test"
import "bun-match-svg"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { plansPreserveSourcesAndCorners } from "../lib/plans-preserve-sources-and-corners"
import { fanoutPlansAreClear } from "../lib/route-bus"
import { routeExtendedDeclaredLayerBridgeSteps } from "../lib/route-declared-layer-bridge"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
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

test("replaces a full partial portfolio with one alternate blocked lane while preserving original exits", async () => {
  const f = makeDeclaredLayerBridgeFixture()
  // Reversed source and exit orders require one crossing. The source vias are
  // close enough to the right boundary that the second lane cannot wrap around.
  const definitions = [
    { name: "LOW_EXIT", y: 2, track: 1 },
    { name: "HIGH_EXIT", y: 1, track: 2 },
  ]
  const pads = definitions.map((d) => ({
    type: "rect" as const,
    center: { x: 3.4, y: d.y },
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
    componentBounds: { minX: 3.25, maxX: 3.55, minY: 0.85, maxY: 2.15 },
    xCoordinates: [3.4],
    yCoordinates: [1, 2],
    pitchX: 1,
    pitchY: 1,
    maxLengthSkew: undefined,
  }
  const srj = { ...f.srj, obstacles: pads, connections }
  const sourceEscapes = prepared.map((connection) => ({
    connectionIndex: connection.connectionIndex,
    connectionName: connection.connection.name,
    segments: [
      {
        start: connection.sourcePoint,
        end: { x: 3.75, y: connection.sourcePoint.y + 0.35 },
        width: f.width,
        layer: "top",
      },
    ],
    via: {
      center: { x: 3.75, y: connection.sourcePoint.y + 0.35 },
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
    exitPoint: { x: f.boundary.minX, y: definitions[i]!.track },
  }))
  const params = {
    ...f.params,
    srj,
    bus,
    terminals,
    sourceEscapes,
    sourceBoundary: { minX: -3.8, maxX: 3.8, minY: -3.8, maxY: 3.8 },
    acceptedPlans: [],
    maximumDirectOrders: 3,
    maximumSearches: 32,
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
  const defaultResult = finish(
    routeExtendedDeclaredLayerBridgeSteps({ ...params, sourcePlans }),
  )
  expect(defaultResult?.plans).toHaveLength(2)
  expect(
    finish(
      routeExtendedDeclaredLayerBridgeSteps({
        ...params,
        sourcePlans,
        preferAlternateBlockedLane: false,
      }),
    ),
  ).toEqual(defaultResult)

  for (const maximumPartialCandidates of [1, 2, 3]) {
    const blockedLanes: string[] = []
    const result = finish(
      routeExtendedDeclaredLayerBridgeSteps({
        ...params,
        sourcePlans,
        maximumPartialCandidates,
        preferAlternateBlockedLane: true,
        onPartialCandidate: (_plans, blocked) =>
          blockedLanes.push(blocked.connection.connection.name),
      }),
    )
    expect(blockedLanes.slice(0, 3)).toEqual([
      "HIGH_EXIT",
      "HIGH_EXIT",
      "HIGH_EXIT",
    ])
    expect(blockedLanes.at(-1)).toBe("LOW_EXIT")
    expect(result?.plans).toHaveLength(2)
    if (!result || !defaultResult) throw Error("Expected both bridge choices")
    expect(result.searchCount).toBeLessThanOrEqual(params.maximumSearches)
    expect(result.requiresLengthMatching).toBe(false)
    expect(
      result.plans.find((p) => p.connectionName === "LOW_EXIT")?.additionalVias,
    ).toHaveLength(1)
    expect(
      result.plans.find((p) => p.connectionName === "HIGH_EXIT")
        ?.additionalVias,
    ).toHaveLength(0)
    expect(
      defaultResult.plans.find((p) => p.connectionName === "HIGH_EXIT")
        ?.additionalVias,
    ).toHaveLength(1)

    for (const [name, candidate] of [
      ["default", defaultResult],
      ["alternate", result],
    ] as const) {
      const plans = candidate.plans
      for (const plan of plans) {
        const connection = prepared[plan.connectionIndex]!
        const source = sourceEscapes[plan.connectionIndex]!
        expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
        expect(plan.sourcePoint).toEqual(connection.sourcePoint)
        expect(plan.targetPoint).toEqual(connection.targetPoint)
        expect(plan.exitPoint).toEqual(
          terminals[plan.connectionIndex]!.exitPoint,
        )
        expect(plan.cornerBandSide).toBe("maximum")
        expect(plan.exitPoint.y).toBeGreaterThan(0)
        expect(plan.targetLayer).toBe("bottom")
        expect(plan.via?.center).toEqual(source.via.center)
        expect(plan.via?.spanLayers).toEqual(f.layerNames)
        expect(plan.segments.slice(0, plan.sourceEscapeSegmentCount)).toEqual(
          source.segments,
        )
        expect(plan.via?.toLayer).toBe(
          plan.additionalVias?.length ? "inner1" : "bottom",
        )
      }
      expect(
        plansPreserveSourcesAndCorners({
          plans,
          preparedBuses: [bus],
          sourceEscapes,
        }),
      ).toBe(true)
      expect(
        fanoutPlansAreClear({ ...params, plans, sharedBoundary: f.boundary }),
      ).toBe(true)
      const output = buildOutputSimpleRouteJson({
        inputSrj: srj,
        plans,
        layerNames: f.layerNames,
      })
      expect(
        validateFanoutSolution({
          inputSrj: srj,
          outputSrj: output,
          plans,
          preparedBuses: [bus],
          sharedBoundary: f.boundary,
          clearance: f.clearance,
          allowBlindAndBuriedVias: false,
        }),
      ).toMatchObject({ valid: true, brokenOutConnectionCount: 2, issues: [] })
      expect(
        validateRoutedCopperDrc({
          inputSrj: srj,
          routedSrj: output,
          clearance: f.clearance,
          allowBlindAndBuriedVias: false,
        }),
      ).toMatchObject({ valid: true, issues: [] })
      if (maximumPartialCandidates === 3)
        await expect(
          getSvgFromGraphicsObject(
            visualizeSimpleRouteJson({ ...output, connections: [] }),
          ),
        ).toMatchSvgSnapshot(import.meta.path, name)
    }
  }
  let bridgeAttempts = 0
  expect(
    finish(
      routeExtendedDeclaredLayerBridgeSteps({
        ...params,
        sourcePlans,
        maximumPartialCandidates: 0,
        preferAlternateBlockedLane: true,
        onSearchPhase: (phase) => {
          if (phase === "bridge") bridgeAttempts++
        },
      }),
    ),
  ).toBeNull()
  expect(bridgeAttempts).toBe(0)
  expect(JSON.stringify({ params, sourcePlans })).toBe(before)
})

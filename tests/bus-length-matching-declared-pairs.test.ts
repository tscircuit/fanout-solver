import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import type { FanoutRoutePlan, PreparedBus } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("matches declared pairs within intact buses, including overlapping and pair-only constraints, without tuning outside scope", async () => {
  const bounds = { minX: -1, maxX: 4, minY: -1, maxY: 5 }
  const names = ["DP", "DN", "DATA", "AUX_P", "AUX_N"]
  const pads: Obstacle[] = names.map((name, index) => ({
    type: "rect",
    shape: "circle",
    center: { x: [0, -0.15, -0.2, 0, -0.2][index]!, y: index },
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    componentId: "U1",
    obstacleId: `${name}-pad`,
    connectedTo: [name],
  }))
  const connections = pads.map((pad, index) => ({
    name: names[index]!,
    netConnectionName: `${names[index]}-alias`,
    pointsToConnect: [
      {
        ...pad.center,
        layer: "top",
        pointId: `${names[index]}-source`,
        pcb_port_id: `${names[index]}-port`,
      },
      { x: 5, y: index, layer: "bottom", pointId: `${names[index]}-target` },
    ],
  }))
  const buses: PreparedBus[] = [
    [0, 1, 2],
    [3, 4],
  ].map((indices, index) => ({
    busId: index ? "AUX" : "BYTE",
    direction: "right",
    exitEdge: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -0.25, maxX: 0.05, minY: -0.05, maxY: 4.05 },
    sharedBoundary: bounds,
    xCoordinates: [-0.2, -0.15, 0],
    yCoordinates: [0, 1, 2, 3, 4],
    pitchX: 0.05,
    pitchY: 1,
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    termination: { type: "boundary" },
    ...(index ? {} : { maxLengthSkew: 0.25 }),
    connections: indices.map((connectionIndex) => ({
      connection: connections[connectionIndex]!,
      connectionIndex,
      sourcePointIndex: 0,
      sourcePoint: connections[connectionIndex]!.pointsToConnect[0]!,
      sourceLayer: "top",
      sourceObstacle: pads[connectionIndex]!,
      targetPoint: connections[connectionIndex]!.pointsToConnect[1]!,
    })),
  }))
  const plans: FanoutRoutePlan[] = buses.flatMap((bus) =>
    bus.connections.map((c) => {
      const end = { x: 4, y: c.sourcePoint.y }
      const viaPoint = { x: 0.3, y: c.sourcePoint.y }
      return {
        busId: bus.busId,
        connectionName: c.connection.name,
        connectionIndex: c.connectionIndex,
        sourcePointIndex: 0,
        sourcePoint: c.sourcePoint,
        sourceLayer: "top",
        sourceObstacle: c.sourceObstacle,
        targetPoint: c.targetPoint,
        targetLayer: "bottom",
        termination: { type: "boundary" },
        direction: "right",
        exitEdge: "right",
        exitPoint: end,
        length: 4 - c.sourcePoint.x,
        sourceEscapeSegmentCount: 1,
        via: {
          center: viaPoint,
          fromLayer: "top",
          toLayer: "bottom",
          diameter: 0.15,
          holeDiameter: 0.07,
          spanLayers: ["top", "bottom"],
        },
        segments: [
          { start: c.sourcePoint, end: viaPoint, width: 0.05, layer: "top" },
          { start: viaPoint, end, width: 0.05, layer: "bottom" },
        ],
        trace: {
          type: "pcb_trace",
          pcb_trace_id: `fanout:${c.connection.name}`,
          connection_name: c.connection.name,
          connectsTo: [c.connection.name],
          route: [
            {
              route_type: "wire",
              x: c.sourcePoint.x,
              y: c.sourcePoint.y,
              width: 0.05,
              layer: "top",
              start_pcb_port_id: c.sourcePoint.pcb_port_id,
            },
            { route_type: "wire", ...viaPoint, width: 0.05, layer: "top" },
            {
              route_type: "via",
              ...viaPoint,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.15,
              via_hole_diameter: 0.07,
            },
            { route_type: "wire", ...viaPoint, width: 0.05, layer: "bottom" },
            { route_type: "wire", ...end, width: 0.05, layer: "bottom" },
          ],
        },
      }
    }),
  )
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    bounds,
    minTraceWidth: 0.05,
    connections,
    obstacles: pads,
    differentialPairs: [
      { connectionNames: ["DP", "DN"], lengthTolerance: 0.1 },
      { connectionNames: ["AUX_P", "AUX_N"], lengthTolerance: 0.01 },
    ],
  }
  const params = {
    inputSrj,
    plans,
    preparedBuses: buses,
    sharedBoundary: bounds,
    clearance: 0.05,
    maximumWorkUnits: 10000,
  }
  // Signal stages can finish before unconstrained buses are routed, including
  // buses whose declared pairs will be matched in their own later stage.
  const staged = matchBusPlanLengths({ ...params, plans: plans.slice(0, 3) })
  expect(staged.plans).toHaveLength(3)
  expect(
    Math.abs(staged.plans![0]!.length - staged.plans![1]!.length),
  ).toBeLessThanOrEqual(0.100001)
  const partial = matchBusPlanLengths({ ...params, plans: plans.slice(0, 4) })
  expect(partial.plans).toBeNull()
  expect(partial.failedBus).toBe(buses[1])
  const missingConstrained = matchBusPlanLengths({
    ...params,
    plans: plans.slice(3),
  })
  expect(missingConstrained.plans).toBeNull()
  expect(missingConstrained.failedBus).toBe(buses[0])
  const original = structuredClone({ inputSrj, plans, buses })
  const scoped = matchBusPlanLengths({ ...params, preparedBuses: [buses[0]!] })
    .plans!
  expect(scoped).not.toBeNull()
  expect(Math.abs(scoped[0]!.length - scoped[1]!.length)).toBeLessThanOrEqual(
    0.100001,
  )
  expect(scoped[0]).not.toBe(plans[0])
  expect(scoped[1]).toBe(plans[1])
  expect(scoped[2]).toBe(plans[2])
  expect(scoped[3]).toBe(plans[3])
  expect(scoped[4]).toBe(plans[4])
  // This second bus has no bus-level limit. Its declaration still activates matching.
  const complete = matchBusPlanLengths({ ...params, plans: scoped }).plans!
  expect(complete).not.toBeNull()
  expect(complete[3]).not.toBe(scoped[3])
  expect(complete[4]).toBe(scoped[4])
  const again = matchBusPlanLengths({ ...params, plans: complete }).plans!
  for (const [index, plan] of complete.entries())
    expect(again[index]).toBe(plan)
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: complete,
    layerNames: ["top", "bottom"],
  })
  expect(
    validateFanoutSolution({ ...params, plans: complete, outputSrj }),
  ).toMatchObject({ valid: true, issues: [], brokenOutConnectionCount: 5 })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance: params.clearance,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 5,
    checkedViaCount: 5,
  })
  const overlappingSrj = {
    ...inputSrj,
    differentialPairs: [
      {
        connectionNames: ["DP", "DN"] as [string, string],
        lengthTolerance: 0.01,
      },
      {
        connectionNames: ["DP", "DATA"] as [string, string],
        lengthTolerance: 0.01,
      },
    ],
  }
  const overlap = matchBusPlanLengths({
    ...params,
    inputSrj: overlappingSrj,
    preparedBuses: [buses[0]!],
  }).plans!
  expect(overlap).not.toBeNull()
  for (const pair of overlappingSrj.differentialPairs) {
    const own = overlap.filter((plan) =>
      pair.connectionNames.includes(plan.connectionName),
    )
    expect(Math.abs(own[0]!.length - own[1]!.length)).toBeLessThanOrEqual(
      pair.lengthTolerance + 1e-6,
    )
  }
  expect(
    Math.max(...overlap.slice(0, 3).map((p) => p.length)) -
      Math.min(...overlap.slice(0, 3).map((p) => p.length)),
  ).toBeLessThanOrEqual(0.250001)
  const exhausted = matchBusPlanLengths({
    ...params,
    preparedBuses: [buses[0]!],
    maximumWorkUnits: 0,
  })
  expect(exhausted.plans).toBeNull()
  expect(exhausted.failedBus).toBe(buses[0])
  let sawPrivateFirstPair = false
  const blockedLaterPair = matchBusPlanLengths({
    ...params,
    maximumWorkUnits: 100,
    candidatePlansAreFeasible: (candidate) => {
      sawPrivateFirstPair ||= candidate[0] !== plans[0]
      return candidate[3] === plans[3]
    },
  })
  expect(sawPrivateFirstPair).toBe(true)
  expect(blockedLaterPair.plans).toBeNull()
  expect(blockedLaterPair.failedBus).toBe(buses[1])
  for (const invalid of [
    plans.slice(1),
    [...plans, plans[0]!],
    plans.map((plan, i) => (i ? plan : { ...plan, busId: "wrong-bus" })),
    plans.map((plan, i) =>
      i ? plan : { ...plan, connectionName: "DP-alias" },
    ),
  ]) {
    const rejected = matchBusPlanLengths({ ...params, plans: invalid })
    expect(rejected.plans).toBeNull()
    expect(rejected.failedBus).toBe(buses[0])
  }
  for (const differentialPairs of [
    null,
    {},
    [{ connectionNames: ["DP-alias", "DN"], lengthTolerance: 0.1 }],
    [{ connectionNames: ["DP", "DP"], lengthTolerance: 0.1 }],
    [{ connectionNames: ["DP", "DN"], lengthTolerance: Number.NaN }],
  ]) {
    expect(() =>
      matchBusPlanLengths({
        ...params,
        inputSrj: { ...inputSrj, differentialPairs } as SimpleRouteJson,
      }),
    ).toThrow(/Differential pair/i)
  }
  const malformed = plans.map((plan, i) =>
    i ? plan : { ...plan, length: Number.NaN },
  )
  expect(() =>
    matchBusPlanLengths({
      ...params,
      plans: malformed,
      preparedBuses: [{ ...buses[0]!, maxLengthSkew: undefined }],
    }),
  ).toThrow(/Differential-pair matching/)
  for (const [index, plan] of complete.entries()) {
    expect(plan.busId).toBe(plans[index]!.busId)
    expect(plan.sourcePoint).toEqual(plans[index]!.sourcePoint)
    expect(plan.exitPoint).toEqual(plans[index]!.exitPoint)
    expect(plan.via).toEqual(plans[index]!.via)
    expect(plan.segments[0]).toEqual(plans[index]!.segments[0])
    expect(plan.sourceEscapeSegmentCount).toBe(1)
    expect(plan.targetLayer).toBe("bottom")
    for (const [i, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-8)
      if (i < plan.segments.length - 1)
        expect(segment.end.x).toBeLessThan(bounds.maxX)
      const previous = plan.segments[i - 1]
      if (!previous || previous.layer !== segment.layer) continue
      const px = previous.end.x - previous.start.x
      const py = previous.end.y - previous.start.y
      expect(
        (px * dx + py * dy) / Math.hypot(px, py) / Math.hypot(dx, dy),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-8)
    }
  }
  expect({ inputSrj, plans, buses }).toEqual(original)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

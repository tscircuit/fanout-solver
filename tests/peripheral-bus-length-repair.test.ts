import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distance } from "lib/geometry"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { repairPeripheralBusLengthsSteps } from "lib/repair-peripheral-bus-lengths"
import { fanoutPlansAreClear } from "lib/route-bus"
import type { FanoutRoutePlan, PreparedBus, RoutedSegment } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("reroutes an untunable pair while preserving its vias and neighboring copper", async () => {
  const traceWidth = 0.1,
    clearance = 0.1
  const sharedBoundary = { minX: -5, maxX: 4, minY: -4, maxY: 4 }
  const fixtures = [
    {
      name: "LONG",
      path: [
        [-1, 0.5],
        [-0.5, 0.5],
        [0, 1],
        [2, 1],
        [2.5, 0.5],
        [4, 0.5],
      ],
    },
    {
      name: "SHORT",
      path: [
        [-1, -0.5],
        [-0.5, -0.5],
        [4, -0.5],
      ],
    },
    {
      name: "NEIGHBOR",
      path: [
        [-1, -2],
        [-0.5, -2],
        [4, -2],
      ],
    },
  ]
  const obstacles: Obstacle[] = fixtures.map(({ name, path }) => ({
    obstacleId: `pad:${name}`,
    componentId: "package",
    type: "rect",
    shape: "circle",
    center: { x: path[0]![0]!, y: path[0]![1]! },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [name, `pad:${name}`],
  }))
  // The package occupies the boundary envelope on top. Normal length tuning
  // has no outside-package segment, although the bottom layer is clear.
  for (const x of [-4.8, 3.95])
    for (const y of [-3.95, 3.95])
      obstacles.push({
        type: "rect",
        center: { x, y },
        width: 0.1,
        height: 0.1,
        layers: ["top"],
        connectedTo: [],
        componentId: "package",
      })
  const connections = fixtures.map(({ name, path }) => ({
    name,
    pointsToConnect: [
      {
        x: path[0]![0]!,
        y: path[0]![1]!,
        layer: "top",
        pointId: `pad:${name}`,
        pcb_port_id: `pad:${name}`,
      },
      { x: 6, y: path.at(-1)![1]!, layer: "bottom", pointId: `target:${name}` },
    ],
  }))
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.1,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: { ...sharedBoundary, maxX: 7 },
    obstacles,
    connections,
  }
  const plans: FanoutRoutePlan[] = fixtures.map(
    ({ name, path: coordinates }, connectionIndex) => {
      const path = coordinates.map(([x, y]) => ({ x: x!, y: y! })),
        segments: RoutedSegment[] = path
          .slice(1)
          .map((end, i) => ({
            start: path[i]!,
            end,
            width: traceWidth,
            layer: i === 0 ? "top" : "bottom",
          }))
      return {
        busId: connectionIndex < 2 ? "PAIR" : "NEIGHBOR",
        connectionIndex,
        connectionName: name,
        sourcePointIndex: 0,
        sourcePoint: connections[connectionIndex]!.pointsToConnect[0]!,
        sourceObstacle: obstacles[connectionIndex]!,
        sourceLayer: "top",
        targetPoint: connections[connectionIndex]!.pointsToConnect[1]!,
        targetLayer: "bottom",
        termination: { type: "boundary" },
        direction: "right",
        exitEdge: "right",
        exitPoint: path.at(-1)!,
        segments,
        via: {
          center: path[1]!,
          diameter: 0.24,
          holeDiameter: 0.1,
          fromLayer: "top",
          toLayer: "bottom",
          spanLayers: ["top", "bottom"],
        },
        length: segments.reduce((n, s) => n + distance(s.start, s.end), 0),
        trace: {
          type: "pcb_trace",
          pcb_trace_id: `fanout:${name}`,
          connection_name: name,
          connectsTo: [`pad:${name}`, `exit:${name}`],
          route: [
            {
              route_type: "wire",
              ...path[0]!,
              layer: "top",
              width: traceWidth,
              start_pcb_port_id: `pad:${name}`,
            },
            {
              route_type: "wire",
              ...path[1]!,
              layer: "top",
              width: traceWidth,
            },
            {
              route_type: "via",
              ...path[1]!,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.24,
              via_hole_diameter: 0.1,
            },
            ...path
              .slice(1)
              .map((p, i) => ({
                route_type: "wire" as const,
                ...p,
                layer: "bottom",
                width: traceWidth,
                ...(i === path.length - 2
                  ? { end_pcb_port_id: `exit:${name}` }
                  : {}),
              })),
          ],
        },
      }
    },
  )
  const preparedBuses: PreparedBus[] = ["PAIR", "NEIGHBOR"].map((busId) => ({
    busId,
    ...(busId === "PAIR" ? { maxLengthSkew: 0.1 } : {}),
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    componentId: "package",
    componentObstacles: obstacles,
    componentBounds: { minX: -4.85, maxX: 4, minY: -4, maxY: 4 },
    sharedBoundary,
    xCoordinates: [-1],
    yCoordinates: [-0.5, 0.5],
    pitchX: 1,
    pitchY: 1,
    connections: plans
      .filter((p) => p.busId === busId)
      .map((p) => ({
        connection: connections[p.connectionIndex]!,
        connectionIndex: p.connectionIndex,
        sourcePointIndex: 0,
        sourcePoint: p.sourcePoint,
        sourceLayer: p.sourceLayer,
        sourceObstacle: p.sourceObstacle,
        targetPoint: p.targetPoint,
      })),
  }))
  const options = {
    plans,
    preparedBuses,
    inputSrj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias: false,
  }
  expect(fanoutPlansAreClear({ ...options, srj: inputSrj })).toBe(true)
  expect(matchBusPlanLengths(options).plans).toBeNull()
  const steps = repairPeripheralBusLengthsSteps({
    ...options,
    srj: inputSrj,
    layerNames: ["top", "bottom"],
    traceWidth,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    compactBusTracks: false,
  })
  let step = steps.next()
  while (!step.done) step = steps.next()
  expect(step.value).not.toBeNull()
  if (!step.value) throw new Error("Expected the pair to be repaired")
  const result = step.value
  expect(result.find((p) => p.busId === "NEIGHBOR")).toBe(plans[2])
  for (const plan of result) {
    const original = plans[plan.connectionIndex]!
    expect(plan.via).toEqual(original.via)
    expect(plan.segments[0]).toMatchObject(original.segments[0])
    expect(plan.targetPoint).toEqual(original.targetPoint)
    expect(plan.additionalVias).toBeUndefined()
  }
  expect(result.find((p) => p.connectionName === "LONG")!.length).toBeLessThan(
    plans[0]!.length,
  )
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result,
    layerNames: ["top", "bottom"],
  })
  expect(
    validateFanoutSolution({ ...options, plans: result, outputSrj }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 3, issues: [] })
  await expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(outputSrj)),
  ).toMatchSvgSnapshot(import.meta.path)
})

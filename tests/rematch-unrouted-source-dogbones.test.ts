import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { rematchUnroutedSourceDogbones } from "lib/rematch-unrouted-source-dogbones"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("rematches only unfinished dogbones and rolls back an impossible assignment", async () => {
  const bounds = { minX: -2.4, maxX: 2, minY: -2, maxY: 1.6 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "bottom"],
  }
  const sourcePoints = [
    { x: -1.6, y: 0.8 },
    { x: -1.6, y: -0.8 },
    { x: 0, y: 0 },
    { x: 0, y: -0.8 },
  ]
  const centers = [...sourcePoints]
  for (const x of [-0.8, 0, 0.8])
    for (const y of [-0.8, 0, 0.8])
      if (!centers.some((p) => p.x === x && p.y === y)) centers.push({ x, y })
  const obstacles: Obstacle[] = centers.map((center, i) => ({
    type: "rect",
    shape: "circle",
    center,
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`N${i}`],
  }))
  const connections: PreparedConnection[] = sourcePoints.map((point, i) => {
    const sourcePoint = { ...point, layer: "top" }
    const targetPoint = { x: 3, y: point.y, layer: "bottom" }
    return {
      connection: {
        name: `N${i}`,
        pointsToConnect: [sourcePoint, targetPoint],
      },
      connectionIndex: i,
      sourcePointIndex: 0,
      sourcePoint,
      sourceLayer: "top",
      sourceObstacle: obstacles[i]!,
      targetPoint,
    }
  })
  const common: PreparedBus = {
    busId: "COMPLETE",
    componentId: "U1",
    direction: "right",
    exitEdge: "right",
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    componentObstacles: obstacles,
    componentBounds: { minX: -1.8, maxX: 1, minY: -1, maxY: 1 },
    xCoordinates: [-1.6, -0.8, 0, 0.8],
    yCoordinates: [-0.8, 0, 0.8],
    pitchX: 0.8,
    pitchY: 0.8,
    sharedBoundary: bounds,
    connections: [connections[0]!],
  }
  const plane: PreparedBus = {
    ...common,
    busId: "PLANE",
    termination: { type: "plane", layer: "inner1" },
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    connections: [connections[1]!],
  }
  const future: PreparedBus = {
    ...common,
    busId: "FUTURE_PAIR",
    connections: connections.slice(2),
  }
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 3,
    minTraceWidth: rules.traceWidth,
    obstacles,
    connections: [
      ...connections.map((c) => c.connection),
      {
        name: "SUPPLIED",
        pointsToConnect: [
          { x: -0.4, y: -1.6, layer: "inner1" },
          { x: -0.4, y: 1.2, layer: "inner1" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "supplied-inner-trace",
        connection_name: "SUPPLIED",
        route: [
          {
            route_type: "wire",
            x: -0.4,
            y: -1.6,
            width: rules.traceWidth,
            layer: "inner1",
          },
          {
            route_type: "wire",
            x: -0.4,
            y: 1.2,
            width: rules.traceWidth,
            layer: "inner1",
          },
        ],
      },
    ],
  }
  const viaPoints = [
    { x: -1.2, y: 0.4 },
    { x: -1.2, y: -1.2 },
    { x: 0.4, y: 0.4 },
    { x: 0.4, y: -0.4 },
  ]
  const plans = connections.map((connection, i) => {
    const viaPoint = viaPoints[i]!
    const exitPoint = i === 0 ? { x: bounds.maxX, y: 0.4 } : viaPoint
    return buildViaMinimalWindingPlan({
      ...rules,
      bus: i === 0 ? common : i === 1 ? plane : future,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: i === 1 ? "inner1" : "bottom",
      targetLayerPoints: i === 0 ? [viaPoint, exitPoint] : [viaPoint],
      allowBlindAndBuriedVias: false,
    })
  })
  const before = JSON.stringify({ inputSrj, plans, future })
  // The lower neighbor occupies the only site that clears the tuning trace.
  // Releasing the obstructing source alone cannot yield a valid assignment.
  expect(
    rematchUnroutedSourceDogbones({
      inputSrj,
      plans,
      unroutedSourceBuses: [{ ...future, connections: [connections[2]!] }],
      clearance: rules.clearance,
    }),
  ).toBeNull()
  expect(JSON.stringify({ inputSrj, plans, future })).toBe(before)
  const repaired = rematchUnroutedSourceDogbones({
    inputSrj,
    plans,
    // Passing a plane and a completed bus must never release their copper.
    unroutedSourceBuses: [common, plane, future],
    clearance: rules.clearance,
  })
  expect(repaired).not.toBeNull()
  expect(JSON.stringify({ inputSrj, plans, future })).toBe(before)
  expect(repaired).toHaveLength(plans.length)
  expect(repaired![0]).toBe(plans[0])
  expect(repaired![1]).toBe(plans[1])
  expect(repaired!.slice(0, 2)).toEqual(plans.slice(0, 2))
  expect(repaired![2]!.via!.center).toEqual({ x: 0.4, y: -0.4 })
  expect(repaired![3]!.via!.center.x).toBeCloseTo(0.4)
  expect(repaired![3]!.via!.center.y).toBeCloseTo(-1.2)
  for (const [i, plan] of repaired!.entries()) {
    expect(plan.sourceObstacle).toBe(plans[i]!.sourceObstacle)
    expect(plan.sourcePoint).toEqual(plans[i]!.sourcePoint)
    expect(plan.targetLayer).toBe(plans[i]!.targetLayer)
    expect(plan.termination).toEqual(plans[i]!.termination)
    expect(plan.via!.diameter).toBe(rules.viaDiameter)
    expect(plan.via!.holeDiameter).toBe(rules.viaHoleDiameter)
    expect(plan.via!.spanLayers).toEqual(rules.layerNames)
  }
  const output = {
    ...inputSrj,
    traces: [...inputSrj.traces!, ...repaired!.map((p) => p.trace)],
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])
  const impossibleInput: SimpleRouteJson = {
    ...inputSrj,
    obstacles: [
      ...obstacles,
      {
        type: "rect",
        center: { x: 0.4, y: -0.4 },
        width: 0.3,
        height: 2,
        layers: ["inner1"],
        connectedTo: ["BLOCKED"],
      },
    ],
  }
  const impossibleBefore = JSON.stringify({ inputSrj: impossibleInput, plans })
  expect(
    rematchUnroutedSourceDogbones({
      inputSrj: impossibleInput,
      plans,
      unroutedSourceBuses: [future],
      clearance: rules.clearance,
    }),
  ).toBeNull()
  expect(JSON.stringify({ inputSrj: impossibleInput, plans })).toBe(
    impossibleBefore,
  )
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...output,
        connections: [],
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

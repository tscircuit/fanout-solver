import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import {
  getLayerReservedBusTargets,
  routeLayerReservedBusesSteps,
} from "lib/route-layer-reserved-buses"
import { prepareSourceOriginReservations } from "lib/route-source-origin-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { FanoutBusSpec } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("a whole bus can choose first vias beyond a blocked target layer without moving other sources", async () => {
  const bounds = { minX: -4, maxX: 4, minY: -4, maxY: 4 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: [],
    obstacles: [],
  }
  const buses: FanoutBusSpec[] = [],
    signals: string[] = []
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      const index = row * 4 + column,
        name = `N${index}`,
        port = `P${index}`,
        source = { x: -1.5 + (column - 1.5) * 0.65, y: (row - 1.5) * 0.65 },
        signal = column === 3
      srj.obstacles.push({
        type: "rect",
        shape: "circle",
        obstacleId: port,
        componentId: "U1",
        center: source,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [name, port],
      } as SimpleRouteJson["obstacles"][number])
      srj.connections.push({
        name,
        pointsToConnect: [
          { ...source, layer: "top", pointId: port, pcb_port_id: port },
          ...(signal ? [{ x: 4, y: -source.y, layer: "inner2" }] : []),
        ],
      })
      if (signal) signals.push(name)
      else
        buses.push({
          busId: name,
          connectionNames: [name],
          sourceComponentId: "U1",
          direction: "right",
          termination: { type: "plane", layer: "inner1" },
        })
    }
  srj.obstacles.push({
    type: "rect",
    center: { x: 0, y: 0 },
    width: 0.2,
    height: 8.5,
    layers: ["inner2"],
    connectedTo: ["wall"],
  })
  buses.push({
    busId: "address",
    connectionNames: signals,
    sourceComponentId: "U1",
    direction: "right",
    preferredExit: "right",
    exitEdge: "right",
    allowedLayers: ["inner2"],
    maxLengthSkew: 15,
  })
  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["inner2"],
  })
  const params = { ...rules, srj, buses: prepared, layerNames }
  const initial = prepareSourceOriginReservations(params)!
  expect(initial).not.toBeNull()
  const target = getLayerReservedBusTargets(params)!,
    bus = prepared.find((b) => b.busId === "address")!
  const before = JSON.stringify({
    srj,
    prepared,
    sites: [...initial.fixedViaPointsByConnectionIndex],
  })
  const fixedSteps = routeReservedViaBusesSteps({
    ...params,
    allBuses: prepared,
    buses: [bus],
    targetLayer: "inner2",
    ...initial,
    acceptedPlans: [],
    terminals: bus.connections.map((connection) => ({
      connection,
      viaPoint: initial.fixedViaPointsByConnectionIndex.get(
        connection.connectionIndex,
      )!,
      exitPoint: target.exits.get(connection.connectionIndex)!,
    })),
    maximumIterations: 100_000,
    maximumRipEvents: 1,
    maximumLocalRepairAttempts: 0,
    tightViaChannels: true,
  })
  let fixed = fixedSteps.next()
  while (!fixed.done) fixed = fixedSteps.next()
  expect(fixed.value).toBeNull()
  const steps = routeLayerReservedBusesSteps({
    ...params,
    sourceOriginRouting: true,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  const plans = next.value!
  expect(plans).not.toBeNull()
  expect(plans).toHaveLength(srj.connections.length)
  const address = plans.filter((plan) => plan.busId === "address")
  expect(address).toHaveLength(4)
  expect(
    Math.max(...address.map((p) => p.length)) -
      Math.min(...address.map((p) => p.length)),
  ).toBeLessThanOrEqual(15 + 1e-7)
  for (const plan of plans) {
    expect(plan.via!.spanLayers).toEqual(layerNames)
    if (plan.termination.type === "plane")
      expect(plan.via!.center).toEqual(
        initial.fixedViaPointsByConnectionIndex.get(plan.connectionIndex)!,
      )
    else {
      expect(plan.via!.center.x).toBeGreaterThan(
        0.1 + rules.viaDiameter / 2 + rules.clearance - 1e-7,
      )
      expect(plan.additionalVias ?? []).toHaveLength(0)
      expect(plan.targetLayer).toBe("inner2")
      expect(plan.exitPoint).toEqual(target.exits.get(plan.connectionIndex)!)
      const vias = plan.trace.route.filter(
        (point) => point.route_type === "via",
      )
      expect(vias).toHaveLength(1)
      expect(vias[0]).toMatchObject({ from_layer: "top", to_layer: "inner2" })
      const firstVia = plan.trace.route.findIndex(
        (point) => point.route_type === "via",
      )
      for (const point of plan.trace.route.slice(firstVia + 1))
        if (point.route_type === "wire") expect(point.layer).toBe("inner2")
    }
  }
  expect(
    JSON.stringify({
      srj,
      prepared,
      sites: [...initial.fixedViaPointsByConnectionIndex],
    }),
  ).toBe(before)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: prepared,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 16,
    brokenOutConnectionCount: 16,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 16,
    checkedViaCount: 16,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

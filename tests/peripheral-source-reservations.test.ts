import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { preparePeripheralSourceReservations } from "lib/prepare-peripheral-source-reservations"
import { prepareSourceOriginReservations } from "lib/route-source-origin-buses"
import { fanoutPlansAreClear } from "lib/route-bus"
import type { FanoutBusSpec, FanoutDirection } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("reserves every peripheral lead and exposed plane pad beyond long pad bodies", async () => {
  const bounds = { minX: -4.5, maxX: 4.5, minY: -4.5, maxY: 4.5 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "bottom"],
  }
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 3,
    minTraceWidth: rules.traceWidth,
    connections: [],
    obstacles: [],
  }
  const buses: FanoutBusSpec[] = []
  for (const direction of ["left", "right", "up", "down"] as const) {
    const names: string[] = []
    for (let index = 0; index < 9; index++) {
      const track = (index - 4) * 0.4,
        horizontal = direction === "left" || direction === "right",
        sign = direction === "left" || direction === "down" ? -1 : 1,
        source = horizontal
          ? { x: sign * 2.8, y: track }
          : { x: track, y: sign * 2.8 },
        name = `${direction}-${index}`,
        nc = direction === "right" && index === 8
      srj.obstacles.push({
        type: "rect",
        componentId: "U1",
        center: source,
        width: horizontal ? 1.5 : 0.2,
        height: horizontal ? 0.2 : 1.5,
        layers: ["top"],
        connectedTo: [name],
      })
      if (nc) continue
      names.push(name)
      srj.connections.push({
        name,
        pointsToConnect: [
          { ...source, layer: "top", pointId: name },
          {
            ...(horizontal
              ? { x: sign * 4.5, y: track }
              : { x: track, y: sign * 4.5 }),
            layer: "bottom",
          },
        ],
      })
    }
    buses.push({
      busId: direction,
      connectionNames: names,
      direction,
      sourceComponentId: "U1",
      allowedLayers: ["bottom"],
    })
  }
  srj.obstacles.push({
    type: "rect",
    componentId: "U1",
    center: { x: 0, y: 0 },
    width: 1.2,
    height: 1.2,
    layers: ["top"],
    connectedTo: ["EPAD"],
  })
  srj.connections.push({
    name: "EPAD",
    pointsToConnect: [{ x: 0, y: 0, layer: "top", pointId: "EPAD" }],
  })
  buses.push({
    busId: "EPAD",
    connectionNames: ["EPAD"],
    direction: "right",
    sourceComponentId: "U1",
    termination: { type: "plane", layer: "inner1" },
  })
  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["bottom"],
    allowBlindAndBuriedVias: false,
  })
  const params = { ...rules, srj, buses: prepared }
  const original = JSON.stringify({ srj, prepared })
  expect(prepareSourceOriginReservations(params)).toBeNull()
  const result = preparePeripheralSourceReservations(params)!
  expect(result).not.toBeNull()
  expect(result.sourcePlans).toHaveLength(36)
  expect(result.fixedViaPointsByConnectionIndex.size).toBe(36)
  expect(result.sourceEscapePaths.size).toBe(36)
  for (const plan of result.sourcePlans) {
    expect(plan.segments).toHaveLength(1)
    expect(plan.sourceObstacle).toBe(
      prepared
        .flatMap((b) => b.connections)
        .find((c) => c.connectionIndex === plan.connectionIndex)!
        .sourceObstacle,
    )
    expect(
      result.fixedViaPointsByConnectionIndex.get(plan.connectionIndex),
    ).toEqual(plan.via!.center)
    expect(result.sourceEscapePaths.get(plan.connectionIndex)).toEqual([
      plan.sourcePoint,
      plan.via!.center,
    ])
    expect(plan.via!.spanLayers).toEqual(rules.layerNames)
    expect(
      plan.segments[0]!.start.x === plan.segments[0]!.end.x ||
        plan.segments[0]!.start.y === plan.segments[0]!.end.y,
    ).toBe(true)
    if (plan.termination.type === "plane")
      expect(plan.targetLayer).toBe("inner1")
    else
      expect(
        Math.max(Math.abs(plan.via!.center.x), Math.abs(plan.via!.center.y)),
      ).toBeLessThan(2.8)
  }
  const routedSrj = { ...srj, traces: result.sourcePlans.map((p) => p.trace) }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    fanoutPlansAreClear({
      ...rules,
      srj,
      plans: result.sourcePlans,
      sharedBoundary: bounds,
      allowBlindAndBuriedVias: false,
    }),
  ).toBe(true)
  expect(
    preparePeripheralSourceReservations({
      ...params,
      allowBlindAndBuriedVias: true,
    }),
  ).toBeNull()
  expect(
    preparePeripheralSourceReservations({
      ...params,
      buses: prepared.filter(
        (b) => b.direction !== ("left" as FanoutDirection),
      ),
    }),
  ).toBeNull()
  const blocked = {
    ...srj,
    obstacles: [
      ...srj.obstacles,
      {
        type: "rect" as const,
        center: result.sourcePlans[0]!.via!.center,
        width: 0.3,
        height: 0.3,
        layers: ["bottom"],
        connectedTo: ["blocker"],
      },
    ],
  }
  expect(
    preparePeripheralSourceReservations({ ...params, srj: blocked }),
  ).toBeNull()
  expect(JSON.stringify({ srj, prepared })).toBe(original)
  expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(routedSrj)),
  ).toMatchSvgSnapshot(import.meta.path)
})

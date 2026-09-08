import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routePeripheralBusesSteps } from "lib/route-peripheral-buses"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import type { FanoutBusSpec } from "lib/types"

test("routes every four-sided lead and exposed pad while preserving atomic paired exits", async () => {
  const bounds = { minX: -4.5, maxX: 4.5, minY: -4.5, maxY: 4.5 },
    rules = {
      traceWidth: 0.08128,
      clearance: 0.08128,
      viaDiameter: 0.24,
      viaHoleDiameter: 0.1,
      layerNames: ["top", "inner1", "inner2", "bottom"],
    }
  const srj: SimpleRouteJson = {
      bounds,
      layerCount: 4,
      minTraceWidth: rules.traceWidth,
      connections: [],
      obstacles: [],
    },
    specs: FanoutBusSpec[] = []
  for (const direction of ["left", "right", "up", "down"] as const) {
    const horizontal = direction === "left" || direction === "right",
      sign = direction === "left" || direction === "down" ? -1 : 1,
      names = []
    for (let i = 0; i < 2; i++) {
      const name = `${direction}-${i}`,
        track = (i - 0.5) * 0.5,
        p = horizontal
          ? { x: sign * 2.8, y: track }
          : { x: track, y: sign * 2.8 },
        q = horizontal
          ? { x: sign * 4.5, y: track + 0.4 }
          : { x: track + 0.4, y: sign * 4.5 }
      names.push(name)
      srj.connections.push({
        name,
        pointsToConnect: [
          { ...p, layer: "top", pointId: name },
          { ...q, layer: "bottom" },
        ],
      })
      srj.obstacles.push({
        type: "rect",
        center: p,
        width: horizontal ? 1.5 : 0.2,
        height: horizontal ? 0.2 : 1.5,
        layers: ["top"],
        componentId: "U1",
        connectedTo: [name],
      })
    }
    specs.push({
      busId: direction,
      connectionNames: names,
      sourceComponentId: "U1",
      direction,
      exitEdge:
        direction === "up"
          ? "top"
          : direction === "down"
            ? "bottom"
            : direction,
      preferredExit:
        direction === "up"
          ? "top"
          : direction === "down"
            ? "bottom"
            : direction,
      allowedLayers: ["top", "inner2", "bottom"],
      maxLengthSkew: 0.25,
    })
  }
  srj.obstacles.push({
    type: "rect",
    center: { x: 0, y: 0 },
    width: 1.2,
    height: 1.2,
    layers: ["top"],
    componentId: "U1",
    connectedTo: ["EPAD"],
  })
  srj.connections.push({
    name: "EPAD",
    pointsToConnect: [{ x: 0, y: 0, layer: "top", pointId: "EPAD" }],
  })
  specs.push({
    busId: "EPAD",
    connectionNames: ["EPAD"],
    sourceComponentId: "U1",
    direction: "right",
    termination: { type: "plane", layer: "inner1" },
  })
  const options = {
      buses: specs,
      sharedBoundary: bounds,
      allowBlindAndBuriedVias: false,
      escapeLayers: ["top", "inner2", "bottom"],
      compactBusTracks: true,
      borderDistribution: "even" as const,
    },
    buses = prepareFanoutBuses(srj, options),
    original = JSON.stringify({ srj, buses })
  const g = routePeripheralBusesSteps({ ...rules, srj, buses })
  let n = g.next()
  while (!n.done) n = g.next()
  const plans = n.value!
  expect(plans).toHaveLength(9)
  expect(new Set(plans.map((p) => p.connectionIndex)).size).toBe(9)
  for (const bus of buses) {
    const own = plans.filter((p) => p.busId === bus.busId)
    expect(own).toHaveLength(bus.connections.length)
    expect(new Set(own.map((p) => p.targetLayer)).size).toBe(1)
    if (bus.maxLengthSkew !== undefined)
      expect(
        Math.max(...own.map((p) => p.length)) -
          Math.min(...own.map((p) => p.length)),
      ).toBeLessThanOrEqual(bus.maxLengthSkew + 1e-6)
  }
  for (const plan of plans) {
    expect(plan.via?.spanLayers).toEqual(rules.layerNames)
    for (let i = 0; i < plan.segments.length; i++) {
      const s = plan.segments[i]!,
        dx = s.end.x - s.start.x,
        dy = s.end.y - s.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const t = plan.segments[i + 1]
      if (t?.layer === s.layer)
        expect(
          (dx * (t.end.x - t.start.x) + dy * (t.end.y - t.start.y)) /
            (Math.hypot(dx, dy) *
              Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames: rules.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 9 })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: buses,
      sharedBoundary: bounds,
      ...rules,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const unsupported = routePeripheralBusesSteps({
    ...rules,
    srj,
    buses: buses.map((bus) =>
      bus.termination.type === "boundary"
        ? { ...bus, allowedLayers: ["top"], routableEscapeLayers: ["top"] }
        : bus,
    ),
  })
  let rejected = unsupported.next()
  while (!rejected.done) rejected = unsupported.next()
  expect(rejected.value).toBeNull()
  expect(JSON.stringify({ srj, buses })).toBe(original)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

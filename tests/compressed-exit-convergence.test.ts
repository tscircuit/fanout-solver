import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { hasCompressedExitConvergence } from "lib/compressed-exit-convergence"
import { LayerRoutingAttempts } from "lib/layer-routing-attempts"
import { prepareFanoutBuses } from "lib/prepare-buses"
import {
  getLayerReservedBusTargets,
  routeLayerReservedBusesSteps,
} from "lib/route-layer-reserved-buses"
import { routeLayerReservedSourceEscapesSteps } from "lib/route-layer-reserved-source-escapes"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { FanoutBusSpec } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("compressed perpendicular exits choose first vias for intact competing buses and preserve every other source", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.05,
    clearance: 0.05,
    viaDiameter: 0.18,
    viaHoleDiameter: 0.08,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: [],
    obstacles: [],
  }
  const buses: FanoutBusSpec[] = []
  for (let index = 0; index < 8; index++) {
    const name = `N${index}`,
      port = `P${index}`,
      plane = index === 6,
      constrained = index === 7
    const source = plane
      ? { x: -1.3, y: -1.3 }
      : constrained
        ? { x: -1.3, y: 1.3 }
        : {
            x: 0.65 + (index % 2) * 0.65,
            y: -0.65 + Math.floor(index / 2) * 0.65,
          }
    srj.obstacles.push({
      type: "rect",
      shape: "circle",
      obstacleId: port,
      componentId: "U1",
      center: source,
      width: 0.18,
      height: 0.18,
      layers: ["top"],
      connectedTo: [name, port],
    } as SimpleRouteJson["obstacles"][number])
    srj.connections.push({
      name,
      pointsToConnect: [
        { ...source, pointId: port, pcb_port_id: port, layer: "top" },
        ...(plane
          ? []
          : constrained
            ? [{ x: -3, y: 1.3, layer: "inner2" }]
            : [{ x: 0.8 + index * 0.1, y: -3, layer: "bottom" }]),
      ],
    })
  }
  for (let row = -2; row <= 2; row++)
    for (let column = -2; column <= 2; column++) {
      const center = { x: column * 0.65, y: row * 0.65 }
      if (
        srj.obstacles.some(
          (pad) =>
            Math.hypot(pad.center.x - center.x, pad.center.y - center.y) < 1e-7,
        )
      )
        continue
      srj.obstacles.push({
        type: "rect",
        shape: "circle",
        obstacleId: `unused-${row}-${column}`,
        componentId: "U1",
        center,
        width: 0.18,
        height: 0.18,
        layers: ["top"],
        connectedTo: [],
      } as SimpleRouteJson["obstacles"][number])
    }
  for (let group = 0; group < 2; group++) {
    const names = Array.from({ length: 3 }, (_, lane) => `N${group * 3 + lane}`)
    buses.push({
      busId: `data-${group}`,
      connectionNames: names,
      sourceComponentId: "U1",
      direction: "down",
      preferredExit: "bottom",
      exitEdge: "bottom",
      allowedLayers: ["top", "inner1", "bottom"],
      maxLengthSkew: 4,
      connectionExitTargets: Object.fromEntries(
        names.map((name) => [
          name,
          srj.connections
            .find((connection) => connection.name === name)!
            .pointsToConnect.at(-1)!,
        ]),
      ),
    })
  }
  buses.push({
    busId: "plane",
    connectionNames: ["N6"],
    sourceComponentId: "U1",
    direction: "left",
    termination: { type: "plane", layer: "inner2" },
  })
  buses.push({
    busId: "control",
    connectionNames: ["N7"],
    sourceComponentId: "U1",
    direction: "left",
    preferredExit: "left",
    exitEdge: "left",
    allowedLayers: ["inner2"],
  })
  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: layerNames,
  })
  const params = { ...rules, srj, buses: prepared, layerNames }
  const targets = getLayerReservedBusTargets(params)!
  const group = prepared.filter((bus) => bus.busId.startsWith("data-"))
  const selection = {
    ...params,
    buses: group,
    targetLayer: "bottom",
    exits: targets.exits,
  }
  expect(hasCompressedExitConvergence(selection)).toBe(true)
  expect(
    hasCompressedExitConvergence({
      ...selection,
      buses: group.map((bus) => ({ ...bus, allowedLayers: ["top", "bottom"] })),
    }),
  ).toBe(false)
  expect(
    hasCompressedExitConvergence({
      ...selection,
      exits: new Map(
        [...targets.exits].map(([index, point]) => [
          index,
          { ...point, x: index * 0.3 - 0.75 },
        ]),
      ),
    }),
  ).toBe(false)
  expect(
    hasCompressedExitConvergence({
      ...selection,
      buses: group.map((bus) => ({ ...bus, exitEdge: "right" })),
    }),
  ).toBe(false)
  const rotate = ({ x, y }: { x: number; y: number }) => ({ x: -y, y: x })
  expect(
    hasCompressedExitConvergence({
      ...selection,
      buses: group.map((bus) => ({
        ...bus,
        exitEdge: "right",
        componentBounds: {
          minX: -bus.componentBounds.maxY,
          maxX: -bus.componentBounds.minY,
          minY: bus.componentBounds.minX,
          maxY: bus.componentBounds.maxX,
        },
        connections: bus.connections.map((connection) => ({
          ...connection,
          sourcePoint: {
            ...connection.sourcePoint,
            ...rotate(connection.sourcePoint),
          },
        })),
      })),
      exits: new Map(
        [...targets.exits].map(([index, point]) => [index, rotate(point)]),
      ),
    }),
  ).toBe(true)
  for (const reason of ["routing", "lengths"] as const) {
    const attempts = new LayerRoutingAttempts({
      wideSingleLayer: false,
      firstRipCost: 64,
      transitLayers: ["inner1"],
      allTransitLayers: ["top", "inner1"],
      preferSourceOrigin: true,
    })
    const origin = attempts.next()!
    expect(origin).toEqual({
      routeFromSourcePads: true,
      ripCost: 256,
      shuffleSeed: 1,
      transitLayers: [],
    })
    attempts.failed(origin, reason)
    expect(attempts.next()).toEqual({
      ripCost: 64,
      shuffleSeed: 1,
      transitLayers: ["inner1"],
    })
    expect(attempts.next()).toBeUndefined()
  }
  const before = JSON.stringify({ srj, prepared })
  const sourceSteps = routeLayerReservedSourceEscapesSteps(params)
  let source = sourceSteps.next()
  while (!source.done) source = sourceSteps.next()
  expect(source.value).not.toBeNull()
  const steps = routeLayerReservedBusesSteps(params)
  let next = steps.next()
  while (!next.done) next = steps.next()
  const plans = next.value!
  expect(plans).not.toBeNull()
  expect(plans).toHaveLength(8)
  expect(plans.find((plan) => plan.termination.type === "plane")).toEqual(
    source.value!.sourcePlans.find((plan) => plan.termination.type === "plane"),
  )
  const signals = plans.filter((plan) => plan.busId.startsWith("data-"))
  expect(
    signals.some(
      (plan) =>
        JSON.stringify(plan.via!.center) !==
        JSON.stringify(
          source.value!.fixedViaPointsByConnectionIndex.get(
            plan.connectionIndex,
          ),
        ),
    ),
  ).toBe(true)
  for (const bus of group) {
    const own = signals.filter((plan) => plan.busId === bus.busId)
    expect(own).toHaveLength(3)
    expect(
      Math.max(...own.map((plan) => plan.length)) -
        Math.min(...own.map((plan) => plan.length)),
    ).toBeLessThanOrEqual(bus.maxLengthSkew! + 1e-7)
    for (const plan of own) {
      expect(plan.targetLayer).toBe("bottom")
      expect(plan.exitPoint).toEqual(targets.exits.get(plan.connectionIndex)!)
      expect(plan.via!.spanLayers).toEqual(layerNames)
      expect(plan.additionalVias ?? []).toHaveLength(0)
      expect(
        plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1).at(-1)!.end,
      ).toEqual(plan.via!.center)
      for (const [index, segment] of plan.segments.entries()) {
        const dx = segment.end.x - segment.start.x,
          dy = segment.end.y - segment.start.y
        expect(
          Math.abs(dx) < 1e-7 ||
            Math.abs(dy) < 1e-7 ||
            Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-7,
        ).toBe(true)
        const previous = plan.segments[index - 1]
        if (previous && previous.layer === segment.layer) {
          const px = previous.end.x - previous.start.x,
            py = previous.end.y - previous.start.y
          expect(
            (dx * px + dy * py) / (Math.hypot(dx, dy) * Math.hypot(px, py)),
          ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
        }
        for (const point of [segment.start, segment.end])
          if (Math.abs(point.x) >= 3 - 1e-7 || Math.abs(point.y) >= 3 - 1e-7)
            expect(
              Math.hypot(
                point.x - plan.exitPoint.x,
                point.y - plan.exitPoint.y,
              ),
            ).toBeLessThan(1e-7)
      }
    }
  }
  expect(JSON.stringify({ srj, prepared })).toBe(before)
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
    checkedConnectionCount: 8,
    brokenOutConnectionCount: 8,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

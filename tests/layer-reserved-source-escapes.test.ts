import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { matchComponentDogboneViaSites } from "lib/match-component-dogbone-via-sites"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeLayerReservedSourceEscapesSteps } from "lib/route-layer-reserved-source-escapes"
import type { FanoutBusSpec } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("successive layer groups preserve every source and previously escaped copper", async () => {
  const bounds = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.12,
  }
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    bounds,
    connections: [],
    obstacles: [],
  }
  const buses: FanoutBusSpec[] = [],
    wide: string[] = [],
    narrow = new Map<number, string[]>()
  for (let row = 0; row < 6; row++)
    for (let column = 0; column < 6; column++) {
      const index = row * 6 + column,
        source = { x: (column - 2.5) * 0.65, y: (row - 2.5) * 0.65 }
      const name = `N${index}`,
        port = `pad-${index}`,
        plane = column < 2 || (row + column) % 3 === 0
      const targetLayer = column < 3 ? "inner2" : "bottom"
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
          { ...source, pointId: port, pcb_port_id: port, layer: "top" },
          ...(plane ? [] : [{ x: -5, y: source.y, layer: targetLayer }]),
        ],
      })
      if (plane)
        buses.push({
          busId: name,
          connectionNames: [name],
          sourceComponentId: "U1",
          direction: "right",
          termination: { type: "plane", layer: "inner1" },
        })
      else if (column < 3) wide.push(name)
      else narrow.set(row, [...(narrow.get(row) ?? []), name])
    }
  // Input order deliberately puts the small buses first. Group scheduling
  // must still reserve the wider single-layer bus before the narrow group.
  for (const [row, names] of narrow)
    buses.push({
      busId: `narrow-${row}`,
      connectionNames: names,
      sourceComponentId: "U1",
      direction: "left",
      preferredExit: "left",
      exitEdge: "left",
      allowedLayers: ["bottom"],
    })
  buses.push({
    busId: "wide",
    connectionNames: wide,
    sourceComponentId: "U1",
    direction: "left",
    preferredExit: "left",
    exitEdge: "left",
    allowedLayers: ["inner2"],
  })
  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["inner2", "bottom"],
  })
  const initial = matchComponentDogboneViaSites(
    prepared.map((bus) =>
      bus.termination.type === "plane"
        ? bus
        : { ...bus, direction: "right" as const },
    ),
    {
      ...rules,
      additionalObstacles: srj.obstacles,
    },
  )!
  const before = JSON.stringify({ srj, prepared, initial: [...initial] })
  const steps = routeLayerReservedSourceEscapesSteps({
    srj,
    buses: prepared,
    ...rules,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  const result = next.value!
  expect(result).not.toBeNull()
  const suppliedSteps = routeLayerReservedSourceEscapesSteps({
    srj,
    buses: prepared,
    ...rules,
    layerNames: ["top", "inner1", "inner2", "bottom"],
    initialViaPointsByConnectionIndex: initial,
  })
  let suppliedNext = suppliedSteps.next()
  while (!suppliedNext.done) suppliedNext = suppliedSteps.next()
  expect(suppliedNext.value!.fixedViaPointsByConnectionIndex).toEqual(
    result.fixedViaPointsByConnectionIndex,
  )
  expect(suppliedNext.value!.sourceEscapePaths).toEqual(
    result.sourceEscapePaths,
  )
  expect(result.layerGroups.map((group) => group.layer)).toEqual([
    "inner2",
    "bottom",
  ])
  expect(result.layerGroups.every((group) => group.escapedCount > 0)).toBe(true)
  expect(result.sourcePlans).toHaveLength(36)
  expect(result.fixedViaPointsByConnectionIndex.size).toBe(36)
  expect(result.sourceEscapePaths.size).toBe(36)
  expect(
    new Set(result.sourcePlans.map((plan) => plan.connectionIndex)).size,
  ).toBe(36)
  for (const bus of prepared)
    for (const connection of bus.connections) {
      const index = connection.connectionIndex,
        path = result.sourceEscapePaths.get(index)!
      expect(path[0]).toEqual(connection.sourcePoint)
      expect(path.at(-1)).toEqual(
        result.fixedViaPointsByConnectionIndex.get(index),
      )
      if (bus.termination.type === "plane")
        expect(result.fixedViaPointsByConnectionIndex.get(index)).toEqual(
          initial.get(index),
        )
    }
  for (const prefix of result.prefixPlans) {
    const remote = result.remotePlans.find(
      (plan) => plan.connectionIndex === prefix.connectionIndex,
    )!
    expect(remote.segments.slice(0, prefix.segments.length)).toMatchObject(
      prefix.segments,
    )
    expect(remote.via!.spanLayers).toEqual([
      "top",
      "inner1",
      "inner2",
      "bottom",
    ])
  }
  expect(JSON.stringify({ srj, prepared, initial: [...initial] })).toBe(before)
  const routedSrj = {
    ...srj,
    traces: result.sourcePlans.map((plan) => plan.trace),
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 36,
    checkedViaCount: 36,
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

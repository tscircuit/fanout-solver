import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routePlaneReservedSourceEscapesSteps } from "lib/route-plane-reserved-source-escapes"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import type { FanoutBusSpec } from "lib/types"

test("partial source escapes preserve plane copper and via capacity for every remaining pad", async () => {
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
  const buses: FanoutBusSpec[] = []
  for (let row = 0; row < 6; row++)
    for (let column = 0; column < 6; column++) {
      const index = row * 6 + column
      const source = { x: (column - 2.5) * 0.65, y: (row - 2.5) * 0.65 }
      const name = `N${index}`,
        port = `pad-${index}`,
        plane = (row + column) % 3 === 0
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
          ...(plane ? [] : [{ x: 5, y: source.y, layer: "bottom" }]),
        ],
      })
      buses.push({
        busId: name,
        connectionNames: [name],
        sourceComponentId: "U1",
        direction: "right",
        ...(plane
          ? { termination: { type: "plane" as const, layer: "inner1" } }
          : { preferredExit: "right" as const, allowedLayers: ["bottom"] }),
      })
    }
  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["bottom"],
  })
  const originalInput = JSON.stringify({ srj, prepared })
  const steps = routePlaneReservedSourceEscapesSteps({
    srj,
    buses: prepared,
    ...rules,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  const result = next.value!
  expect(result).not.toBeNull()
  // Sixteen of 24 signals can move to the perimeter without sacrificing any
  // of the twelve plane connections or the eight remaining signal escapes.
  expect(result.prefixPlans).toHaveLength(16)
  expect(result.fixedPlaneSites.size).toBe(12)
  expect(result.remainingViaPointsByConnectionIndex.size).toBe(20)
  const indices = [
    ...result.prefixPlans.map((plan) => plan.connectionIndex),
    ...result.remainingViaPointsByConnectionIndex.keys(),
  ]
  expect(new Set(indices).size).toBe(36)
  expect(indices).toHaveLength(36)
  for (const [index, point] of result.fixedPlaneSites)
    expect(result.remainingViaPointsByConnectionIndex.get(index)).toEqual(point)
  expect(JSON.stringify({ srj, prepared })).toBe(originalInput)

  // Independently check all source copper and the twenty through vias, rather
  // than merely trusting the local matcher's count.
  const localTraces: SimplifiedPcbTrace[] = prepared.flatMap((bus) =>
    bus.connections.flatMap((connection) => {
      const via = result.remainingViaPointsByConnectionIndex.get(
        connection.connectionIndex,
      )
      if (!via) return []
      const targetLayer =
        bus.termination.type === "plane" ? bus.termination.layer : "bottom"
      return [
        {
          type: "pcb_trace" as const,
          pcb_trace_id: `local:${connection.connectionIndex}`,
          connection_name: connection.connection.name,
          route: [
            {
              route_type: "wire" as const,
              x: connection.sourcePoint.x,
              y: connection.sourcePoint.y,
              width: rules.traceWidth,
              layer: "top",
            },
            {
              route_type: "wire" as const,
              ...via,
              width: rules.traceWidth,
              layer: "top",
            },
            {
              route_type: "via" as const,
              ...via,
              from_layer: "top",
              to_layer: targetLayer,
              via_diameter: rules.viaDiameter,
              via_hole_diameter: rules.viaHoleDiameter,
            },
            {
              route_type: "wire" as const,
              ...via,
              width: rules.traceWidth,
              layer: targetLayer,
            },
          ],
        },
      ]
    }),
  )
  const routedSrj = {
    ...srj,
    traces: [...result.prefixPlans.map((plan) => plan.trace), ...localTraces],
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
    checkedViaCount: 20,
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})

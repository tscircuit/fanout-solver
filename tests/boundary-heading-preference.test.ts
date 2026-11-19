import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { getBusRouteChoices } from "lib/get-bus-route-choices"

test("an inferred boundary heading is preferred without excluding other headings", (): void => {
  const srj: SimpleRouteJson = {
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 0, y: -1.9999, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        componentId: "U1",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["signal"],
      },
    ],
  }
  const solver = new FanoutSolver(srj, {
    sharedBoundary: srj.bounds,
    escapeLayers: ["top"],
  })
  const bus = solver.preparedBuses[0]
  const route = { ...solver.config, srj, bus, acceptedPlans: [] }
  expect(bus.direction).toBe("down")
  expect(getBusRouteChoices(route, 1)[0][0].direction).toBe("down")
  const directions = getBusRouteChoices(route, 8).map(
    (plans) => plans[0].direction,
  )
  expect(new Set(directions)).toEqual(new Set(["left", "right", "up", "down"]))
  const explicit = {
    ...bus,
    direction: "right" as const,
    requestedDirection: "right" as const,
  }
  expect(
    getBusRouteChoices({ ...route, bus: explicit }, 8).every(
      (plans) => plans[0].direction === "right",
    ),
  ).toBe(true)
})

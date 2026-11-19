import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBusAlternatives } from "lib/route-bus"

test("expanded plane alternatives do not repeat the original via-in-pad choice", () => {
  const input: SimpleRouteJson & { allowViaInPad: boolean } = {
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.2,
    minViaHoleDiameter: 0.1,
    allowViaInPad: true,
    obstacles: [
      {
        type: "rect",
        componentId: "U1",
        center: { x: 0, y: 0 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["GND"],
      },
    ],
    connections: [
      {
        name: "GND",
        pointsToConnect: [{ x: 0, y: 0, layer: "top" }],
      },
    ],
  }
  const solver = new FanoutSolver(input, {
    buses: [
      {
        busId: "ground",
        connectionNames: ["GND"],
        direction: "right",
        termination: { type: "plane", layer: "bottom" },
      },
    ],
  })
  const alternatives = routeBusAlternatives(
    {
      ...solver.config,
      srj: input,
      bus: solver.preparedBuses[0]!,
      targetLayer: "bottom",
      acceptedPlans: [],
    },
    2,
  )
  expect(alternatives).toHaveLength(2)
  expect(alternatives[0]![0]!.via?.center).toEqual({ x: 0, y: 0 })
  expect(alternatives[1]![0]!.via?.center).not.toEqual({ x: 0, y: 0 })
})

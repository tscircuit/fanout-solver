import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("a blocked inferred heading can change without overriding explicit guidance", async () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: [
      {
        type: "rect",
        componentId: "U1",
        center: { x: 0, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["signal"],
      },
      {
        type: "rect",
        center: { x: 1, y: 0 },
        width: 0.4,
        height: 6,
        layers: ["top", "bottom"],
        connectedTo: ["foreign-net"],
      },
    ],
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const bus = { busId: "signal", connectionNames: ["signal"] }
  const options: FanoutSolverOptions = {
    buses: [bus],
    sourceComponentId: "U1",
    sharedBoundary: input.bounds,
    escapeLayers: ["top"],
    clearance: 0.1,
    maxLayerCombinations: 1,
  }
  const solver = new FanoutSolver(input, options)
  expect(solver.preparedBuses[0]?.direction).toBe("right")
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.getOutput().busDirections.signal).toBe("left")
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: solver.getOutput().simpleRouteJson,
      clearance: options.clearance!,
    }),
  ).toMatchObject({ valid: true, checkedViaCount: 0, issues: [] })

  const guidance: FanoutSolverOptions[] = [
    { buses: [{ ...bus, direction: "right" }] },
    { busDirections: { signal: "right" } },
    { defaultDirection: "right" },
    { buses: [{ ...bus, preferredExit: "right" }] },
    { buses: [{ ...bus, preferredExit: "right", exitEdge: "right" }] },
    {
      buses: [{ ...bus, connectionExitTargets: { signal: { x: 3, y: 0 } } }],
    },
  ]
  for (const explicitOptions of guidance) {
    const guided = new FanoutSolver(input, { ...options, ...explicitOptions })
    guided.solve()
    expect(guided.solved).toBe(false)
  }
  await expect(
    getSvgFromGraphicsObject(solver.visualize(), { backgroundColor: "white" }),
  ).toMatchSvgSnapshot(import.meta.path)
})

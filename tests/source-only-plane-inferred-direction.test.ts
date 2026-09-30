import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

// Same four-pad geometry as plane-termination.test.ts, with the optional
// direction omitted: a plane has no remote endpoint from which to infer it.
test("routes a source-only plane bus without an explicit escape direction", async () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    connections: [
      {
        name: "VSS_A1",
        pointsToConnect: [
          {
            x: -0.4,
            y: 0.4,
            layer: "top",
            pointId: "bga:A1",
            pcb_port_id: "bga:A1",
          },
        ],
      },
    ],
    obstacles: [
      [-0.4, 0.4],
      [0.4, 0.4],
      [-0.4, -0.4],
      [0.4, -0.4],
    ].map(([x, y], i) => ({
      obstacleId: `pad-${i}`,
      componentId: "bga",
      type: "rect",
      shape: "circle",
      center: { x: x!, y: y! },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: i === 0 ? ["VSS_A1", "bga:A1"] : [],
    })),
  }
  const before = JSON.stringify(input)
  const options = {
    buses: [
      {
        busId: "ground",
        connectionNames: ["VSS_A1"],
        termination: { type: "plane" as const, layer: "inner1" },
      },
    ],
    sharedBoundary: { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5 },
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
  }
  const solver = new FanoutSolver(input, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 1,
    brokenOutConnectionCount: 1,
    issues: [],
  })
  expect(output.planeTerminations).toHaveLength(1)
  expect(output.planeTerminations[0]!.via.spanLayers).toEqual([
    "top",
    "inner1",
    "inner2",
    "bottom",
  ])
  expect(output.simpleRouteJson.connections).toHaveLength(0)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  // The automatic seed must preserve the established explicit-right route.
  const explicit = new FanoutSolver(input, {
    ...options,
    buses: options.buses.map((bus) => ({
      ...bus,
      direction: "right" as const,
    })),
  })
  explicit.solve()
  expect(output.fanoutTraces).toEqual(explicit.getOutput().fanoutTraces)
  expect(JSON.stringify(input)).toBe(before)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus } from "lib/route-bus"
import type { FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native ButterStick plane escape reaches its adjacent via", async () => {
  // Native source_trace_18, with its full-board escape direction and nearby copper.
  const { solverParams, solverOptions, viewport } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/butterstick-plane-angle.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as {
    solverParams: SimpleRouteJson
    solverOptions: FanoutSolverOptions
    viewport: SimpleRouteJson["bounds"]
  }
  const solver = new FanoutSolver(solverParams, solverOptions)
  solver.solve()
  expect(solver.solved).toBe(true)
  const bus = solver.preparedBuses[0]!
  if (bus.termination.type !== "plane") throw new Error("Expected a plane drop")
  const plans = routeBus({
    ...solver.config,
    srj: solverParams,
    bus,
    targetLayer: bus.termination.layer,
    acceptedPlans: [],
  })
  expect(plans).toHaveLength(1)
  const plan = plans![0]!
  expect(plan.via!.center.x).toBeCloseTo(10.7899)
  expect(plan.via!.center.y).toBeCloseTo(2.8)
  const obliqueSegments = plan.segments.filter(({ start, end }) => {
    const dx = Math.abs(end.x - start.x)
    const dy = Math.abs(end.y - start.y)
    return dx > 1e-7 && dy > 1e-7 && Math.abs(dx - dy) > 1e-7
  })
  expect(obliqueSegments).toHaveLength(0)
  const routedSrj = { ...solverParams, traces: [plan.trace] }
  expect(
    validateRoutedCopperDrc({
      inputSrj: solverParams,
      routedSrj,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  // Clip the drawing while retaining the original copper for routing and DRC.
  const obstacles = solverParams.obstacles.map((obstacle) => {
    if (!obstacle.isCopperPour) return obstacle
    const minX = Math.max(viewport.minX, obstacle.center.x - obstacle.width / 2)
    const maxX = Math.min(viewport.maxX, obstacle.center.x + obstacle.width / 2)
    const minY = Math.max(
      viewport.minY,
      obstacle.center.y - obstacle.height / 2,
    )
    const maxY = Math.min(
      viewport.maxY,
      obstacle.center.y + obstacle.height / 2,
    )
    return {
      ...obstacle,
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    }
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, bounds: viewport, obstacles }),
      { backgroundColor: "white" },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
  const committedTraces = solver.solved ? solver.getOutput().fanoutTraces : []
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...solverParams,
        bounds: viewport,
        obstacles,
        traces: committedTraces,
      }),
      { backgroundColor: "white" },
    ),
  ).toMatchSvgSnapshot(import.meta.path, "solver")
})

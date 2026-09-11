import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FanoutSolver } from "lib/fanout-solver"
import { distancePointToObstacle } from "lib/geometry"

test("native decoupler plane drops join retained ground without relaxing physical clearance", () => {
  // Unmodified constructor arguments emitted by Core's real TSX repro:
  // tests/repros/repro-decoupler-plane-retained-ground.test.tsx.
  const [srj, options]: ConstructorParameters<typeof FanoutSolver> = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/decoupler-plane-retained-ground.json",
        import.meta.url,
      ),
      "utf8",
    ),
  )
  const before = JSON.stringify([srj, options])
  expect(options.allowSameNetMerges).toBeUndefined()
  const solver = new FanoutSolver(srj, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.planeTerminations).toHaveLength(2)
  for (const { via } of output.planeTerminations) {
    expect(via.spanLayers).toEqual(["top", "inner1", "inner2", "bottom"])
    for (const obstacle of srj.obstacles) {
      if ("isCopperPour" in obstacle && obstacle.isCopperPour === true) continue
      expect(
        distancePointToObstacle(via.center, obstacle) - via.diameter / 2,
      ).toBeGreaterThanOrEqual(0.15)
    }
  }
  expect(JSON.stringify([srj, options])).toBe(before)
  for (const trace of srj.traces ?? []) {
    // Output annotates the existing through-via span; all physical geometry
    // and source attribution must remain unchanged.
    expect(output.simpleRouteJson.traces).toContainEqual({
      ...trace,
      route: trace.route.map((point) =>
        point.route_type === "via"
          ? { ...point, layers: ["top", "inner1", "inner2", "bottom"] }
          : point,
      ),
    })
  }

  // A plane label is not permission to cross foreign copper or physical pads.
  for (const obstacleKind of ["foreign_plane", "physical_pad"] as const) {
    const blockedSrj = structuredClone(srj)
    const plane = blockedSrj.obstacles.find(
      (obstacle) =>
        "isCopperPour" in obstacle && obstacle.isCopperPour === true,
    )
    if (!plane)
      throw new Error("Repro must contain the native ground-plane reservation")
    if (obstacleKind === "foreign_plane")
      plane.connectedTo = ["isolated_foreign_net"]
    else Reflect.deleteProperty(plane, "isCopperPour")
    const blocked = new FanoutSolver(blockedSrj, options)
    blocked.solve()
    expect(blocked.failed).toBe(true)
  }
  const foreignTraceSrj = structuredClone(srj)
  const retainedTrace = foreignTraceSrj.traces?.[0]
  if (!retainedTrace)
    throw new Error("Repro must retain the earlier ground route")
  retainedTrace.connection_name = "isolated_foreign_trace"
  retainedTrace.connectsTo = []
  const foreignTraceSolver = new FanoutSolver(foreignTraceSrj, options)
  foreignTraceSolver.solve()
  expect(foreignTraceSolver.failed).toBe(true)
})

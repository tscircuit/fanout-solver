import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "../lib/fanout-solver"
import type { FanoutSolverOptions } from "../lib/types"
import capturedFixture from "./fixtures/am62l-lpddr4-three-bus-through-all.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test("repro03 exposes dense winding search as incremental subsolver steps", () => {
  const solver = new FanoutSolver(
    structuredClone(fixture.inputSrj),
    structuredClone(fixture.options),
  )
  let boundaryRoutingStepCount = 0
  let largestSearchBatch = 0

  for (let guard = 0; guard < 200; guard++) {
    solver.step()
    const activeSolverNames: string[] = []
    let activeSolver = solver.activeSubSolver
    while (activeSolver) {
      activeSolverNames.push(activeSolver.getSolverName())
      activeSolver = activeSolver.activeSubSolver
    }
    if (activeSolverNames.includes("BoundaryBusRoutingSolver")) {
      boundaryRoutingStepCount++
      expect(activeSolverNames).toEqual([
        "FanoutAssignmentSolver",
        "DenseMixedTerminationSolver",
        "BoundaryBusRoutingSolver",
      ])
    }
    if (solver.stats.phase === "route-boundary-bus-connection") {
      largestSearchBatch = Math.max(
        largestSearchBatch,
        Number(solver.stats.searchBatch ?? 0),
      )
    }
    if (largestSearchBatch >= 3) break
  }

  expect(boundaryRoutingStepCount).toBeGreaterThan(3)
  expect(largestSearchBatch).toBeGreaterThanOrEqual(3)
  expect(solver.stats).toMatchObject({
    phase: "route-boundary-bus-connection",
    searchBatch: largestSearchBatch,
    connectionComplete: false,
  })
  expect(Number(solver.stats.expandedStates)).toBeGreaterThanOrEqual(15_000)
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(false)
})

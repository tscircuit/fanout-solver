import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { GraphicsObject } from "graphics-debug"
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
  let firstSearchVisualization: GraphicsObject | undefined
  let latestSearchVisualization: GraphicsObject | undefined

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
      if (Number(solver.stats.searchBatch ?? 0) > 0) {
        const visualization = solver.visualize()
        firstSearchVisualization ??= structuredClone(visualization)
        latestSearchVisualization = structuredClone(visualization)
      }
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
  expect(firstSearchVisualization).toBeDefined()
  expect(latestSearchVisualization).not.toEqual(firstSearchVisualization)
  expect(latestSearchVisualization?.title).toStartWith("Winding DDR_BYTE1:")
  expect(
    latestSearchVisualization?.points?.some(
      (point) => point.label === "expanded in current step",
    ),
  ).toBe(true)
  expect(
    latestSearchVisualization?.points?.some(
      (point) => point.label === "open frontier",
    ),
  ).toBe(true)
  expect(
    latestSearchVisualization?.lines?.some(
      (line) => line.label === "active via-to-exit search",
    ),
  ).toBe(true)
  expect(
    latestSearchVisualization?.circles?.some(
      (circle) => circle.label === "active via",
    ),
  ).toBe(true)
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(false)
})

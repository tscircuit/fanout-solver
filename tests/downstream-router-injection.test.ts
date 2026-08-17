import { AutoroutingPipelineSolver6 } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { srj29FanoutSamples } from "../datasets/srj29"
import { FanoutSolver } from "../lib/fanout-solver"
import type { FanoutDownstreamRouter } from "../lib/types"

test("endpoint completion delegates unresolved board routes to the host", () => {
  const sample = srj29FanoutSamples.find(({ id }) => id === "sample003")!
  const routedInputs: Parameters<FanoutDownstreamRouter>[0][] = []
  const routeDownstreamConnections: FanoutDownstreamRouter = (
    inputSrj,
    { effort },
  ) => {
    routedInputs.push(inputSrj)
    const downstreamSolver = new AutoroutingPipelineSolver6(inputSrj, {
      effort,
    })
    downstreamSolver.solve()
    if (!downstreamSolver.solved) {
      throw new Error(
        downstreamSolver.error ??
          "Injected downstream autorouter did not solve",
      )
    }
    return downstreamSolver.getOutputSimpleRouteJson().traces ?? []
  }
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    routeDownstreamConnections,
  })

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(routedInputs).toHaveLength(1)
  expect(routedInputs[0]!.connections.length).toBeGreaterThan(0)
  expect(routedInputs[0]!.connections.length).toBeLessThanOrEqual(12)
  expect(solver.getOutput().endpointCompletion?.errors).toEqual([])
  expect(solver.getOutput().endpointCompletion?.drc.valid).toBe(true)
  expect(solver.getOutput().completionTraces.length).toBeGreaterThan(0)
}, 60_000)

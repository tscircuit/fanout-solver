import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "../../lib/fanout-solver"
import type { FanoutSolverOptions } from "../../lib/types"

const fixturePath = process.argv[2]
if (!fixturePath) throw new Error("Expected a fixture path")

const fixture = (await Bun.file(fixturePath).json()) as {
  input: SimpleRouteJson
  options: FanoutSolverOptions
}

const solver = new FanoutSolver(fixture.input, fixture.options)
solver.step()

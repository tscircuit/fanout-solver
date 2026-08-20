import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import inputJson from "../tests/fixtures/am62l-soc-winding-fanout.json"

const input = inputJson as unknown as {
  simpleRouteJson: SimpleRouteJson
  options: FanoutSolverOptions
}

export default function Am62lWindingFanoutPage() {
  return (
    <GenericSolverDebugger
      createSolver={() =>
        new FanoutSolver(input.simpleRouteJson, input.options)
      }
      animationSpeed={80}
    />
  )
}

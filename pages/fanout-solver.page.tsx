import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "tests/fixtures/create-footprinter-benchmark"

const benchmarkSrj = createFootprinterBenchmarkSrj({ gridSize: 8 })

export default (
  <GenericSolverDebugger
    createSolver={() => new FanoutSolver(benchmarkSrj)}
    animationSpeed={80}
  />
)

import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { createAm62lCoreProgressiveDramInput } from "../tests/fixtures/create-am62l-core-progressive-dram-input"

export default function CoreProgressiveDramReproPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        color: "#0f172a",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid #e2e8f0",
          background: "#ffffff",
          display: "grid",
          gap: 10,
          padding: 16,
        }}
      >
        <strong>Repro 06 · Core AM62L progressive DRAM fanout</strong>
        <div style={{ color: "#475569", fontSize: 13 }}>
          Exact DRAM-phase input · 143 connections · 217 obstacles · 135 prior
          traces · original solver options
        </div>
        <div style={{ color: "#475569", fontSize: 13 }}>
          Captured from core&apos;s{" "}
          <code>repro-am62l-lpddr4-progressive-fanout.test.tsx</code>, after the
          SoC fanout phase. Full connectivity lists and existing copper are
          retained.
        </div>
        <div style={{ color: "#166534", fontSize: 13 }}>
          All 143 connections route with the original options. The regression
          checks every breakout, bus length skew, and copper clearance.
        </div>
      </header>

      <GenericSolverDebugger
        createSolver={() => {
          const { inputSrj, options } = createAm62lCoreProgressiveDramInput()
          return new FanoutSolver(inputSrj, options)
        }}
        animationSpeed={80}
      />
    </div>
  )
}

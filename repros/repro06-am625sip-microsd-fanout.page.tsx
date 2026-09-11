import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { useState } from "react"
import { createAm625sipMicrosdFanout } from "../tests/fixtures/create-am625sip-microsd-fanout"

export default function Am625sipMicrosdFanoutReproPage() {
  const [includeInnerRow, setIncludeInnerRow] = useState(true)
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        fontFamily: "sans-serif",
      }}
    >
      <header style={{ padding: 16, display: "grid", gap: 12 }}>
        <strong>Repro 06 · AM625SiP microSD breakout</strong>
        <div>
          425 circular BGA pads · 0.50 mm pitch · 0.09 mm trace/clearance · 4
          layers
        </div>
        <label>
          <input
            type="checkbox"
            checked={includeInnerRow}
            onChange={(event) => setIncludeInnerRow(event.target.checked)}
          />
          Include B21 / MMC1_DAT1 (inner row)
        </label>
        <div>
          The control routes A21 and A22. The captured three-signal case adds
          B21. Both retain every pad obstacle, including the unused testpoint in
          the control. The 32 × 32 mm fanout boundary and original via rules are
          unchanged.
        </div>
      </header>
      <GenericSolverDebugger
        key={String(includeInnerRow)}
        createSolver={() => {
          const { inputSrj, options } = createAm625sipMicrosdFanout({
            includeInnerRow,
          })
          return new FanoutSolver(inputSrj, options)
        }}
        animationSpeed={80}
      />
    </div>
  )
}

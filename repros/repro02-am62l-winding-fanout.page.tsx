import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds, FanoutSolverOptions } from "lib/types"
import { useState } from "react"
import inputJson from "../tests/fixtures/am62l-soc-winding-fanout.json"

const input = inputJson as unknown as {
  simpleRouteJson: SimpleRouteJson
  options: FanoutSolverOptions
}

const growBounds = (bounds: Bounds, padding: number): Bounds => ({
  minX: bounds.minX - padding,
  maxX: bounds.maxX + padding,
  minY: bounds.minY - padding,
  maxY: bounds.maxY + padding,
})

export default function Am62lWindingFanoutPage() {
  const [padding, setPadding] = useState(1)
  const sharedBoundary = growBounds(input.options.sharedBoundary!, padding)

  return (
    <div>
      <header style={{ display: "grid", gap: 8, padding: 16 }}>
        <strong>AM62L winding fanout · boundary padding</strong>
        <label>
          Padding: {padding}mm
          <input
            type="range"
            min={1}
            max={3}
            step={1}
            value={padding}
            onChange={(event) => setPadding(Number(event.target.value))}
            style={{ display: "block", width: 320 }}
          />
        </label>
        <span>Measured result at 1mm, 2mm, and 3mm: failed, 0/33 routed.</span>
      </header>
      <GenericSolverDebugger
        key={`padding-${padding}`}
        createSolver={() =>
          new FanoutSolver(input.simpleRouteJson, {
            ...input.options,
            sharedBoundary,
          })
        }
        animationSpeed={80}
      />
    </div>
  )
}

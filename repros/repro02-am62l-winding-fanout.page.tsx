import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds, FanoutBusSpec, FanoutSolverOptions } from "lib/types"
import { useState } from "react"
import inputJson from "../tests/fixtures/am62l-soc-winding-fanout.json"

interface CapturedConnectionTarget {
  x: number
  y: number
  layer?: string
}

interface CapturedBus extends FanoutBusSpec {
  connectionTargets?: Record<string, CapturedConnectionTarget>
}

const input = inputJson as unknown as {
  simpleRouteJson: SimpleRouteJson & { buses?: CapturedBus[] }
  options: FanoutSolverOptions & {
    buses: CapturedBus[]
    sharedBoundary: Bounds
  }
}

const growBounds = (bounds: Bounds, padding: number): Bounds => ({
  minX: bounds.minX - padding,
  maxX: bounds.maxX + padding,
  minY: bounds.minY - padding,
  maxY: bounds.maxY + padding,
})

const moveConnectionTargets = (
  buses: CapturedBus[] | undefined,
  padding: number,
): void => {
  for (const bus of buses ?? []) {
    for (const target of Object.values(bus.connectionTargets ?? {})) {
      target.x += padding
    }
  }
}

export const createPaddedInput = (padding: number) => {
  const simpleRouteJson = structuredClone(input.simpleRouteJson)
  const options = structuredClone(input.options)

  simpleRouteJson.bounds.maxX += padding
  for (const connection of simpleRouteJson.connections) {
    for (const point of connection.pointsToConnect) {
      if (!point.pointId?.startsWith("pcb_breakout_point_")) continue
      point.x += padding
    }
  }
  moveConnectionTargets(simpleRouteJson.buses, padding)
  moveConnectionTargets(options.buses, padding)
  options.sharedBoundary = growBounds(options.sharedBoundary, padding)

  return { simpleRouteJson, options }
}

export default function Am62lWindingFanoutPage() {
  const [padding, setPadding] = useState(1)
  const paddedInput = createPaddedInput(padding)

  return (
    <div>
      <header style={{ padding: 16 }}>
        <label style={{ alignItems: "center", display: "flex", gap: 6 }}>
          padding:
          <input
            type="number"
            min={0}
            step={0.1}
            value={padding}
            onChange={(event) => setPadding(Number(event.target.value))}
            style={{ width: 120 }}
          />
          mm
        </label>
      </header>
      <GenericSolverDebugger
        key={`padding-${padding}`}
        createSolver={() =>
          new FanoutSolver(paddedInput.simpleRouteJson, paddedInput.options)
        }
        animationSpeed={80}
      />
    </div>
  )
}

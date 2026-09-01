import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutExitPosition, FanoutSolverOptions } from "lib/types"
import capturedFixture from "../tests/fixtures/am62l-lpddr4-six-bus-through-all-soc.json"

type CapturedInput = SimpleRouteJson & {
  allowBlindAndBuriedVias?: boolean
  allowViaInPad?: boolean
}

const fixture = capturedFixture as unknown as {
  inputSrj: CapturedInput
  options: FanoutSolverOptions
}

const topExitPositionByBusId: Readonly<Record<string, FanoutExitPosition>> = {
  DDR_ADDR_CTRL: "topside_center",
  DDR_BYTE0: "topside_left",
  DDR_BYTE1: "topside_right",
  DDR_CLOCK: "topside_left",
  DDR_DMI0: "topside_left",
  DDR_DMI1: "topside_right",
  DDR_DQS0: "topside_left",
  DDR_DQS1: "topside_right",
  DDR_RESET: "topside_center",
}

const busDescriptions = [
  "BYTE0 · top/left · 8 signals",
  "BYTE1 · top/right · 8 signals",
  "ADDR/CTRL · top/center · 8 signals",
  "CLOCK + DQS0 · top/left · 4 signals",
  "DQS1 · top/right · 2 signals",
  "RESET · top/center · 1 signal",
  "DMI0 · top/left · 1 signal",
  "DMI1 · top/right · 1 signal",
]

export const createAm62lTopEdgeBreakoutRepro = () => {
  const inputSrj = structuredClone(fixture.inputSrj)
  const options = structuredClone(fixture.options)

  for (const bus of options.buses ?? []) {
    const exitPosition = topExitPositionByBusId[bus.busId]
    if (exitPosition !== undefined) bus.exitPosition = exitPosition
  }

  return { inputSrj, options }
}

export default function Am62lTopEdgeBreakoutReproPage() {
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
        <div>
          <strong>Repro 04 · AM62L nine-bus top-edge breakout</strong>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
            SoC fanout phase · 135 connections · 373 active BGA pads · 8 layers
          </div>
        </div>

        <div style={{ color: "#475569", fontSize: 13 }}>
          This reuses the passing AM62L/LPDDR4 captured input with 102
          power-plane drops and 33 DDR signals. The only change is that all nine
          signal buses must terminate on the top edge in left, center, or right
          bands.
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          {busDescriptions.map((description) => (
            <span
              key={description}
              style={{
                background: "#eef2ff",
                border: "1px solid #c7d2fe",
                borderRadius: 999,
                color: "#3730a3",
                fontSize: 12,
                padding: "5px 9px",
              }}
            >
              {description}
            </span>
          ))}
        </div>

        <div style={{ color: "#b45309", fontSize: 13 }}>
          Current behavior: the solver cannot complete the AM62L escape. In
          core, the 3mm-boundary run reached 114/135 connections before failing;
          solver 0.0.47 can instead remain CPU-bound for several minutes. Use
          the debugger controls to inspect the search.
        </div>
      </header>

      <GenericSolverDebugger
        createSolver={() => {
          const { inputSrj, options } = createAm62lTopEdgeBreakoutRepro()
          return new FanoutSolver(inputSrj, options)
        }}
        animationSpeed={80}
      />
    </div>
  )
}

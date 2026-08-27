import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "../tests/fixtures/am62l-lpddr4-three-bus-through-all.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

const busDescriptions = [
  "BYTE0 · right/top · top or inner4 · skew ≤ 8mm",
  "BYTE1 · right/bottom · inner5 or bottom · skew ≤ 14.5mm",
  "ADDR/CTRL · right/center · inner6 · skew ≤ 15mm",
]

export default function Am62lThreeBusThroughAllReproPage() {
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
          <strong>Repro 03 · AM62L dense three-bus through-all fanout</strong>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
            SoC fanout phase · 126 connections · 373 active BGA pads · 8 layers
          </div>
        </div>
        <div style={{ color: "#475569", fontSize: 13 }}>
          102 power-plane drops plus 24 boundary signals. Via-in-pad and
          blind/buried vias are disabled, so every connection must dogbone to
          one full-stack via.
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
          A complete solve takes roughly 20 seconds on the captured machine. The
          page does not auto-run; use the debugger controls when ready.
        </div>
      </header>
      <GenericSolverDebugger
        createSolver={() =>
          new FanoutSolver(
            structuredClone(fixture.inputSrj),
            structuredClone(fixture.options),
          )
        }
        animationSpeed={80}
      />
    </div>
  )
}

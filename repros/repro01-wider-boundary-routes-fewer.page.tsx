import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerColor } from "lib/layer-colors"
import { getCopperLayerNames } from "lib/layer-names"
import { useState } from "react"
import {
  growBounds,
  RP2350A_BREAKOUT_BOUNDARY,
  rp2350aBreakoutFanoutInput,
} from "../datasets/dataset07"

const { simpleRouteJson, solverOptions } = rp2350aBreakoutFanoutInput

const buttonStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
  font: "inherit",
  padding: "8px 12px",
}

const variants = [
  { grownBy: 0, label: "As resolved by core", routed: "13/23" },
  { grownBy: 0.3, label: "+0.3mm", routed: "0/23" },
  { grownBy: 0.6, label: "+0.6mm", routed: "0/23" },
  { grownBy: 1.2, label: "+1.2mm", routed: "0/23" },
  { grownBy: 3, label: "+3mm", routed: "0/23" },
]

/**
 * Repro 01 — a wider shared boundary routes fewer connections.
 *
 * Same RP2350A breakout problem in every tab. The only thing that changes is
 * how much room the escapes are given, and more room does strictly worse.
 */
export default function Repro01WiderBoundaryRoutesFewerPage() {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const variant = variants[selectedIndex]!
  const layerNames = getCopperLayerNames(simpleRouteJson.layerCount)
  const sharedBoundary = growBounds(RP2350A_BREAKOUT_BOUNDARY, variant.grownBy)

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
          gap: 12,
          padding: 16,
        }}
      >
        <div>
          <strong>Repro 01 · A wider boundary routes fewer connections</strong>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
            RP2350A QFN60 plus its decoupling ring ·{" "}
            {simpleRouteJson.connections.length} connections ·{" "}
            {simpleRouteJson.obstacles.length} obstacles ·{" "}
            {simpleRouteJson.layerCount} layers
          </div>
          <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 6 }}>
            Every tab is the same problem with only the shared boundary changed.
            Widening it should never route fewer connections, but it drops from
            13/23 to 0/23 and stays there.
          </div>
        </div>

        <div
          aria-label="Shared boundary size"
          role="tablist"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {variants.map((candidate, index) => {
            const isSelected = index === selectedIndex
            return (
              <button
                aria-selected={isSelected}
                key={candidate.label}
                onClick={() => setSelectedIndex(index)}
                role="tab"
                style={{
                  ...buttonStyle,
                  background: isSelected ? "#0f172a" : "#ffffff",
                  color: isSelected ? "#ffffff" : "#0f172a",
                }}
                type="button"
              >
                {candidate.label} · {candidate.routed}
              </button>
            )
          })}
        </div>

        <div style={{ color: "#475569", fontSize: 13 }}>
          Boundary grown by {variant.grownBy}mm on every side:{" "}
          <code style={{ color: "#0f766e" }}>
            x {sharedBoundary.minX.toFixed(2)}..{sharedBoundary.maxX.toFixed(2)}
            , y {sharedBoundary.minY.toFixed(2)}..
            {sharedBoundary.maxY.toFixed(2)}
          </code>
        </div>

        <div
          aria-label="Copper layer colors"
          style={{ display: "flex", flexWrap: "wrap", gap: 12 }}
        >
          {layerNames.map((layerName, index) => (
            <span
              key={layerName}
              style={{
                alignItems: "center",
                display: "inline-flex",
                fontSize: 12,
                gap: 6,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  background: getCopperLayerColor(index),
                  borderRadius: "999px",
                  display: "inline-block",
                  height: 10,
                  width: 10,
                }}
              />
              {layerName}
            </span>
          ))}
        </div>
      </header>

      <GenericSolverDebugger
        key={`grown-${variant.grownBy}`}
        createSolver={() =>
          new FanoutSolver(simpleRouteJson, {
            ...solverOptions,
            sharedBoundary,
          })
        }
        animationSpeed={80}
      />
    </div>
  )
}

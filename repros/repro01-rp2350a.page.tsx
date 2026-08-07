import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerColor } from "lib/layer-colors"
import { getCopperLayerNames } from "lib/layer-names"
import { useState } from "react"
import {
  RP2350A_PACKAGE_BOUNDS,
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

const boundaryAtMargin = (margin: number) => ({
  minX: RP2350A_PACKAGE_BOUNDS.minX - margin,
  maxX: RP2350A_PACKAGE_BOUNDS.maxX + margin,
  minY: RP2350A_PACKAGE_BOUNDS.minY - margin,
  maxY: RP2350A_PACKAGE_BOUNDS.maxY + margin,
})

const isInsidePackage = (obstacle: { center: { x: number; y: number } }) =>
  obstacle.center.x > RP2350A_PACKAGE_BOUNDS.minX - 0.5 &&
  obstacle.center.x < RP2350A_PACKAGE_BOUNDS.maxX + 0.5 &&
  obstacle.center.y > RP2350A_PACKAGE_BOUNDS.minY - 0.5 &&
  obstacle.center.y < RP2350A_PACKAGE_BOUNDS.maxY + 0.5

interface ReproVariant {
  id: string
  label: string
  description: string
  simpleRouteJson: typeof simpleRouteJson
  solverOptions: typeof solverOptions
}

const packageObstacles = simpleRouteJson.obstacles.filter(isInsidePackage)

const variants: ReproVariant[] = [
  {
    id: "as-captured",
    label: "As captured from core",
    description:
      "Exactly what @tscircuit/core hands the solver. Note that it supplies no sharedBoundary and no componentBounds — solverOptions is only { borderDistribution, compactBusTracks }.",
    simpleRouteJson,
    solverOptions,
  },
  ...[0.6, 1, 2].map((margin) => ({
    id: `bounds-${margin}mm`,
    label: `+ bounds at ${margin}mm`,
    description: `The same input with componentBounds and a sharedBoundary ${margin}mm outside the package pads. Supplying the bounds the solver expects does not change the outcome.`,
    simpleRouteJson,
    solverOptions: {
      ...solverOptions,
      componentBounds: { U_MCU: RP2350A_PACKAGE_BOUNDS },
      sharedBoundary: boundaryAtMargin(margin),
    },
  })),
  {
    id: "package-only",
    label: "Package pads only",
    description: `Neighbouring parts removed: ${simpleRouteJson.obstacles.length} obstacles reduced to the ${packageObstacles.length} that belong to the QFN itself, with bounds supplied. Still routes nothing, so the decouplers, flash and crystal are not the blocker.`,
    simpleRouteJson: { ...simpleRouteJson, obstacles: packageObstacles },
    solverOptions: {
      ...solverOptions,
      componentBounds: { U_MCU: RP2350A_PACKAGE_BOUNDS },
      sharedBoundary: boundaryAtMargin(0.6),
    },
  },
]

/**
 * Repro 01 — RP2350A QFN60 breakout.
 *
 * Serialized fanout input from @tscircuit/core's <breakout> around an RP2350A
 * on a four-layer handheld. 27 of the QFN60's 61 pads cross the boundary and
 * the solver routes none of them. Each tab is one of the variations that were
 * tried while narrowing it down.
 */
export default function Repro01Rp2350aPage() {
  const [selectedVariantIndex, setSelectedVariantIndex] = useState(0)
  const variant = variants[selectedVariantIndex]!
  const layerNames = getCopperLayerNames(simpleRouteJson.layerCount)

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
          <strong>Repro 01 · RP2350A QFN60 breakout</strong>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
            {simpleRouteJson.connections.length} connections ·{" "}
            {variant.simpleRouteJson.obstacles.length} obstacles ·{" "}
            {simpleRouteJson.layerCount} layers · QFN60, 0.4mm pitch, 7x7mm
            body, 3.4mm thermal pad
          </div>
          <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 6 }}>
            Expected: all {simpleRouteJson.connections.length} escapes route.
            Actual: FanoutSolver: best layer assignment routed 0/
            {simpleRouteJson.connections.length} connections.
          </div>
        </div>

        <div
          aria-label="Repro variants"
          role="tablist"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {variants.map((candidate, index) => {
            const isSelected = index === selectedVariantIndex
            return (
              <button
                aria-selected={isSelected}
                key={candidate.id}
                onClick={() => setSelectedVariantIndex(index)}
                role="tab"
                style={{
                  ...buttonStyle,
                  background: isSelected ? "#0f172a" : "#ffffff",
                  color: isSelected ? "#ffffff" : "#0f172a",
                }}
                type="button"
              >
                {candidate.label}
              </button>
            )
          })}
        </div>

        <div style={{ color: "#475569", fontSize: 13 }}>
          {variant.description}
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
        key={variant.id}
        createSolver={() =>
          new FanoutSolver(variant.simpleRouteJson, variant.solverOptions)
        }
        animationSpeed={80}
      />
    </div>
  )
}

import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { useEffect, useState } from "react"
import { fanoutDataset01 } from "../datasets/dataset01"

const buttonStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
  font: "inherit",
  padding: "8px 12px",
}

export default function FanoutSolverPage() {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedSample = fanoutDataset01[selectedIndex]!

  useEffect(() => {
    const requestedSample = new URLSearchParams(window.location.search).get(
      "sample",
    )
    const requestedIndex = fanoutDataset01.findIndex(
      (sample) => sample.id === requestedSample,
    )
    if (requestedIndex >= 0) setSelectedIndex(requestedIndex)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("sample", selectedSample.id)
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    )
  }, [selectedSample.id])

  const selectSample = (index: number) => {
    if (index < 0 || index >= fanoutDataset01.length) return
    setSelectedIndex(index)
  }

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
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            justifyContent: "space-between",
          }}
        >
          <div>
            <strong>Fanout Solver · Dataset 01</strong>
            <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
              {selectedSample.id} · {selectedSample.name} ·{" "}
              {selectedSample.simpleRouteJson.connections.length} connections ·{" "}
              {selectedSample.simpleRouteJson.buses?.length ?? 0} buses
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => selectSample(selectedIndex - 1)}
              disabled={selectedIndex === 0}
              style={{
                ...buttonStyle,
                cursor: selectedIndex === 0 ? "not-allowed" : "pointer",
                opacity: selectedIndex === 0 ? 0.45 : 1,
              }}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => selectSample(selectedIndex + 1)}
              disabled={selectedIndex === fanoutDataset01.length - 1}
              style={{
                ...buttonStyle,
                cursor:
                  selectedIndex === fanoutDataset01.length - 1
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  selectedIndex === fanoutDataset01.length - 1 ? 0.45 : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>

        <div
          aria-label="Dataset 01 samples"
          role="tablist"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {fanoutDataset01.map((sample, index) => {
            const isSelected = index === selectedIndex
            return (
              <button
                aria-selected={isSelected}
                key={sample.id}
                onClick={() => selectSample(index)}
                role="tab"
                style={{
                  ...buttonStyle,
                  background: isSelected ? "#0f172a" : "#ffffff",
                  color: isSelected ? "#ffffff" : "#0f172a",
                }}
                type="button"
              >
                Sample {index + 1} · {sample.footprintCount} FP
              </button>
            )
          })}
        </div>

        <div style={{ color: "#475569", fontSize: 13 }}>
          {selectedSample.description}
        </div>
      </header>

      <GenericSolverDebugger
        key={selectedSample.id}
        createSolver={() =>
          new FanoutSolver(
            selectedSample.simpleRouteJson,
            selectedSample.solverOptions,
          )
        }
        animationSpeed={80}
      />
    </div>
  )
}

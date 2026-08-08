import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { type ChangeEvent, useEffect, useState } from "react"
import { srj19DatasetName, srj19DatasetRule, srj19FanoutSamples } from "./srj19"

const buttonStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
  font: "inherit",
  padding: "8px 12px",
}

function getInitialSampleIndex(): number {
  if (typeof window === "undefined") return 0
  const requestedSample = new URLSearchParams(window.location.search).get(
    "sample",
  )
  const requestedIndex = srj19FanoutSamples.findIndex(
    (sample) => sample.id === requestedSample,
  )
  return requestedIndex >= 0 ? requestedIndex : 0
}

export default function Srj19Page() {
  const [selectedIndex, setSelectedIndex] = useState(getInitialSampleIndex)
  const selectedSample = srj19FanoutSamples[selectedIndex]!

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("sample", selectedSample.id)
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    )
    document.title = `${selectedSample.id} · SRJ19 · Fanout Solver`
  }, [selectedSample.id])

  const selectSample = (index: number) => {
    if (index < 0 || index >= srj19FanoutSamples.length) return
    setSelectedIndex(index)
  }

  const onSelectSample = (event: ChangeEvent<HTMLSelectElement>) => {
    selectSample(Number(event.currentTarget.value))
  }

  const onScrubSample = (event: ChangeEvent<HTMLInputElement>) => {
    selectSample(Number(event.currentTarget.value))
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
            <strong>Fanout Solver · SRJ19</strong>
            <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
              {selectedSample.id} · sample {selectedIndex + 1} of{" "}
              {srj19FanoutSamples.length} · {selectedSample.bgaPadCount} BGA
              pads · {selectedSample.fanoutConnectionCount} fanout connections
            </div>
            <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
              {selectedSample.componentCount} components ·{" "}
              {selectedSample.obstacleCount} obstacles ·{" "}
              {selectedSample.passiveOverlayCount} passive pads · BGA on{" "}
              {selectedSample.bgaLayer}, passives on{" "}
              {selectedSample.passiveLayer}
            </div>
          </div>

          <div
            style={{
              alignItems: "center",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
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
            <select
              aria-label="SRJ19 sample"
              onChange={onSelectSample}
              style={{ ...buttonStyle, minWidth: 150 }}
              value={selectedIndex}
            >
              {srj19FanoutSamples.map((sample, index) => (
                <option key={sample.id} value={index}>
                  {sample.id} · {sample.bgaPadCount} pads ·{" "}
                  {sample.fanoutConnectionCount} nets
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => selectSample(selectedIndex + 1)}
              disabled={selectedIndex === srj19FanoutSamples.length - 1}
              style={{
                ...buttonStyle,
                cursor:
                  selectedIndex === srj19FanoutSamples.length - 1
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  selectedIndex === srj19FanoutSamples.length - 1 ? 0.45 : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>

        <input
          aria-label="Scrub through SRJ19 samples"
          type="range"
          min={0}
          max={srj19FanoutSamples.length - 1}
          onChange={onScrubSample}
          value={selectedIndex}
        />

        <details style={{ color: "#475569", fontSize: 13 }}>
          <summary style={{ cursor: "pointer" }}>{srj19DatasetName}</summary>
          <p style={{ marginBottom: 0 }}>{srj19DatasetRule}</p>
          <p style={{ marginBottom: 0 }}>
            The adapter sends only BGA-touching connections to FanoutSolver.
            Passive-to-I/O connection segments are omitted, but all components
            remain as copper obstacles.
          </p>
        </details>
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

import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerColor } from "lib/layer-colors"
import { getCopperLayerNames } from "lib/layer-names"
import { useEffect, useState } from "react"
import { fanoutDatasets } from "../datasets"

const buttonStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
  font: "inherit",
  padding: "8px 12px",
}

function formatFootprinterStrings(strings: string[]): string {
  const counts = new Map<string, number>()
  for (const value of strings) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .map(([value, count]) => (count === 1 ? value : `${value} × ${count}`))
    .join(" + ")
}

const DEFAULT_DATASET_INDEX = Math.max(
  0,
  fanoutDatasets.findIndex((dataset) => dataset.id === "dataset02"),
)

export default function FanoutSolverPage() {
  const [selectedDatasetIndex, setSelectedDatasetIndex] = useState(
    DEFAULT_DATASET_INDEX,
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedDataset = fanoutDatasets[selectedDatasetIndex]!
  const selectedSample = selectedDataset.samples[selectedIndex]!
  const footprinterTitle = formatFootprinterStrings(
    selectedSample.footprinterStrings,
  )
  const layerNames = getCopperLayerNames(
    selectedSample.simpleRouteJson.layerCount,
  )

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestedDatasetIndex = fanoutDatasets.findIndex(
      (dataset) => dataset.id === params.get("dataset"),
    )
    const datasetIndex =
      requestedDatasetIndex >= 0 ? requestedDatasetIndex : DEFAULT_DATASET_INDEX
    const requestedSampleIndex = fanoutDatasets[
      datasetIndex
    ]!.samples.findIndex((sample) => sample.id === params.get("sample"))
    setSelectedDatasetIndex(datasetIndex)
    if (requestedSampleIndex >= 0) setSelectedIndex(requestedSampleIndex)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("dataset", selectedDataset.id)
    params.set("sample", selectedSample.id)
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    )
    document.title = `${selectedSample.name} · ${footprinterTitle} · Fanout Solver`
  }, [
    footprinterTitle,
    selectedDataset.id,
    selectedSample.id,
    selectedSample.name,
  ])

  const selectDataset = (index: number) => {
    if (index < 0 || index >= fanoutDatasets.length) return
    setSelectedDatasetIndex(index)
    setSelectedIndex(0)
  }

  const selectSample = (index: number) => {
    if (index < 0 || index >= selectedDataset.samples.length) return
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
            <strong>
              Fanout Solver · {selectedDataset.id} · {selectedDataset.name}
            </strong>
            <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
              {selectedSample.id} · {selectedSample.name} ·{" "}
              {selectedSample.simpleRouteJson.connections.length} connections ·{" "}
              {selectedSample.simpleRouteJson.buses?.length ?? 0} buses
            </div>
            <code
              style={{
                color: "#0f766e",
                display: "block",
                fontSize: 12,
                marginTop: 6,
                overflowWrap: "anywhere",
              }}
            >
              {footprinterTitle}
            </code>
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
              disabled={selectedIndex === selectedDataset.samples.length - 1}
              style={{
                ...buttonStyle,
                cursor:
                  selectedIndex === selectedDataset.samples.length - 1
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  selectedIndex === selectedDataset.samples.length - 1
                    ? 0.45
                    : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>

        <div
          aria-label="Fanout datasets"
          role="tablist"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {fanoutDatasets.map((dataset, index) => {
            const isSelected = index === selectedDatasetIndex
            return (
              <button
                aria-selected={isSelected}
                key={dataset.id}
                onClick={() => selectDataset(index)}
                role="tab"
                style={{
                  ...buttonStyle,
                  background: isSelected ? "#0f172a" : "#ffffff",
                  color: isSelected ? "#ffffff" : "#0f172a",
                }}
                type="button"
              >
                {dataset.id} · {dataset.name}
              </button>
            )
          })}
        </div>

        <div style={{ color: "#475569", fontSize: 13 }}>
          {selectedDataset.description}
        </div>

        <div
          aria-label={`${selectedDataset.id} samples`}
          role="tablist"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {selectedDataset.samples.map((sample, index) => {
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
        key={`${selectedDataset.id}:${selectedSample.id}`}
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

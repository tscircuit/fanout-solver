import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { type ChangeEvent, useEffect, useState } from "react"
import {
  createDataset31Sample,
  type Dataset31Sample,
} from "../scripts/generate-repro/create-dataset31-sample"
import { dataset31Source } from "../scripts/generate-repro/dataset31-source"
import { benchmarkSamples } from "./benchmark-catalog"

type BenchmarkDefinition = (typeof benchmarkSamples)[number]
type Chip = BenchmarkDefinition["chip"]
type LoadState =
  | { status: "loading" }
  | { status: "ready"; sample: Dataset31Sample }
  | { status: "error"; message: string }

const chipLabels: Record<Chip, string> = {
  am62l: "AM62L",
  rk3308: "RK3308",
  k230: "K230",
  imx6ull: "i.MX6ULL",
  t113s3: "T113-S3",
  am3352: "AM3352",
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
  font: "inherit",
  padding: "8px 12px",
}

const samplePromises = new Map<string, Promise<Dataset31Sample>>()

function loadBenchmarkSample(
  definition: BenchmarkDefinition,
): Promise<Dataset31Sample> {
  const cached = samplePromises.get(definition.id)
  if (cached) return cached
  const pending = createDataset31Sample(definition).catch((error) => {
    samplePromises.delete(definition.id)
    throw error
  })
  samplePromises.set(definition.id, pending)
  return pending
}

function getInitialSampleIndex(): number {
  if (typeof window === "undefined") return 0
  const requestedSample = new URLSearchParams(window.location.search).get(
    "sample",
  )
  const requestedIndex = benchmarkSamples.findIndex(
    (sample) => sample.id === requestedSample,
  )
  return requestedIndex >= 0 ? requestedIndex : 0
}

export default function BenchmarkSamplesPage() {
  const [selectedIndex, setSelectedIndex] = useState(getInitialSampleIndex)
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" })
  const selectedDefinition = benchmarkSamples[selectedIndex]!

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("sample", selectedDefinition.id)
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    )
    document.title = `${selectedDefinition.id} · Dataset 31 · Fanout Solver`
  }, [selectedDefinition.id])

  useEffect(() => {
    let isCurrent = true
    setLoadState({ status: "loading" })
    loadBenchmarkSample(selectedDefinition).then(
      (sample) => {
        if (isCurrent) setLoadState({ status: "ready", sample })
      },
      (error) => {
        if (isCurrent) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => {
      isCurrent = false
    }
  }, [selectedDefinition])

  const selectSample = (index: number): void => {
    if (index < 0 || index >= benchmarkSamples.length) return
    setSelectedIndex(index)
  }

  const onSelectSample = (event: ChangeEvent<HTMLSelectElement>): void => {
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
          background: "#ffffff",
          borderBottom: "1px solid #e2e8f0",
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
            <strong>Fanout Solver · Dataset 31 benchmark</strong>
            <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
              {selectedDefinition.id} · {selectedDefinition.name} · sample{" "}
              {selectedIndex + 1} of {benchmarkSamples.length}
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
              aria-label="Dataset 31 benchmark sample"
              onChange={onSelectSample}
              style={{ ...buttonStyle, maxWidth: "100%", width: 360 }}
              value={selectedIndex}
            >
              {(Object.keys(chipLabels) as Chip[]).map((chip) => (
                <optgroup key={chip} label={chipLabels[chip]}>
                  {benchmarkSamples.map((sample, index) =>
                    sample.chip === chip ? (
                      <option key={sample.id} value={index}>
                        {sample.id} · {sample.name}
                      </option>
                    ) : null,
                  )}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              onClick={() => selectSample(selectedIndex + 1)}
              disabled={selectedIndex === benchmarkSamples.length - 1}
              style={{
                ...buttonStyle,
                cursor:
                  selectedIndex === benchmarkSamples.length - 1
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  selectedIndex === benchmarkSamples.length - 1 ? 0.45 : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>

        <div style={{ color: "#475569", fontSize: 13 }}>
          {chipLabels[selectedDefinition.chip]} ·{" "}
          {selectedDefinition.exitPosition} · {selectedDefinition.description}
        </div>

        {loadState.status === "ready" && (
          <div style={{ color: "#475569", fontSize: 13 }}>
            {loadState.sample.simpleRouteJson.connections.length} connections ·{" "}
            {loadState.sample.solverOptions.buses?.length ?? 0} buses ·{" "}
            {loadState.sample.simpleRouteJson.obstacles.length} obstacles ·{" "}
            {loadState.sample.simpleRouteJson.layerCount} layers
          </div>
        )}

        <div style={{ color: "#0f766e", fontSize: 12 }}>
          Generated from the pinned upstream TSX/core workload at{" "}
          <code>{dataset31Source.commit.slice(0, 7)}</code>. The debugger runs
          this checkout&apos;s FanoutSolver with the benchmark&apos;s original
          input and options.
        </div>
      </header>

      {loadState.status === "loading" && (
        <div style={{ color: "#475569", padding: 24 }}>
          Generating {selectedDefinition.id} through tscircuit/core…
        </div>
      )}
      {loadState.status === "error" && (
        <div style={{ color: "#b91c1c", padding: 24 }}>
          Could not generate the benchmark sample: {loadState.message}
        </div>
      )}
      {loadState.status === "ready" && (
        <GenericSolverDebugger
          key={selectedDefinition.id}
          createSolver={() =>
            new FanoutSolver(
              structuredClone(loadState.sample.simpleRouteJson),
              structuredClone(loadState.sample.solverOptions),
            )
          }
          animationSpeed={80}
        />
      )}
    </div>
  )
}

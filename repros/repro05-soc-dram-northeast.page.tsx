import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { FanoutSolver } from "lib/fanout-solver"
import { useState } from "react"
import dramBreakoutFixture from "../tests/fixtures/soc-dram/northeast/dram-breakout.srj.json"
import socBreakoutFixture from "../tests/fixtures/soc-dram/northeast/soc-breakout.srj.json"

type BreakoutFixtureId = "soc" | "dram"

const breakoutFixtures = {
  soc: {
    label: "SoC breakout",
    input: socBreakoutFixture as unknown as SimpleRouteJson,
  },
  dram: {
    label: "DRAM breakout",
    input: dramBreakoutFixture as unknown as SimpleRouteJson,
  },
} satisfies Record<BreakoutFixtureId, { label: string; input: SimpleRouteJson }>

export default function SocDramNortheastReproPage() {
  const [selectedFixtureId, setSelectedFixtureId] =
    useState<BreakoutFixtureId>("soc")
  const selectedFixture = breakoutFixtures[selectedFixtureId]

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
          <strong>Repro 05 · SoC/DRAM northeast breakout</strong>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>
            Exact captured SRJ · 33 DDR connections · 3 buses · 8 layers
          </div>
        </div>

        <label
          style={{
            alignItems: "center",
            display: "flex",
            fontSize: 13,
            gap: 8,
          }}
        >
          Fixture
          <select
            value={selectedFixtureId}
            onChange={(event) =>
              setSelectedFixtureId(event.target.value as BreakoutFixtureId)
            }
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              padding: "6px 9px",
            }}
          >
            {Object.entries(breakoutFixtures).map(([fixtureId, fixture]) => (
              <option key={fixtureId} value={fixtureId}>
                {fixture.label}
              </option>
            ))}
          </select>
        </label>

        <div style={{ color: "#b45309", fontSize: 13 }}>
          This is a failure-characterization page. The captured SRJ is passed
          directly to FanoutSolver without routing overrides.
        </div>
      </header>

      <GenericSolverDebugger
        key={selectedFixtureId}
        createSolver={() =>
          new FanoutSolver(structuredClone(selectedFixture.input))
        }
        animationSpeed={80}
      />
    </div>
  )
}

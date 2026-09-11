import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { expectSvgSnapshotWithActual } from "./fixtures/expect-svg-snapshot-with-actual"
import { createAm62lDirectDecouplingDramInput } from "./fixtures/create-am62l-direct-decoupling-dram-input"

const REPRO_STEP_BUDGET = 2_000

test("reproduces the stalled 143-connection AM62L DRAM fanout", async () => {
  const { inputSrj, options } = createAm62lDirectDecouplingDramInput()
  const throughViaObstacles = inputSrj.obstacles.filter(
    (obstacle) =>
      (obstacle as { circuitJsonMetadata?: { pcb_via_id?: string } })
        .circuitJsonMetadata?.pcb_via_id !== undefined &&
      obstacle.layers.length === inputSrj.layerCount,
  )
  const priorTraces = inputSrj.traces ?? []

  expect(inputSrj.connections).toHaveLength(143)
  expect(inputSrj.obstacles).toHaveLength(457)
  expect(priorTraces).toHaveLength(255)
  expect(new Set(priorTraces.map((trace) => trace.pcb_trace_id)).size).toBe(
    priorTraces.length,
  )
  expect(throughViaObstacles).toHaveLength(120)

  const solver = new FanoutSolver(inputSrj, options)
  while (
    !solver.solved &&
    !solver.failed &&
    solver.iterations < REPRO_STEP_BUDGET
  ) {
    solver.step()
  }

  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(false)
  expect(solver.iterations).toBe(REPRO_STEP_BUDGET)

  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 2,
        text: "Real Core TSX · AM62L + LPDDR4 · 60 decouplers · 120 vias",
        color: "#0f172a",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: `Unsolved after ${REPRO_STEP_BUDGET.toLocaleString()} deterministic steps`,
        color: "#b91c1c",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expectSvgSnapshotWithActual(
    getSvgFromGraphicsObject(visualization),
    import.meta.path,
  )
}, 120_000)

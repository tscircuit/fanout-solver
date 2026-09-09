import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { createAm62lRealDecouplingInput } from "./fixtures/create-am62l-real-decoupling-input"

test("reproduces the AM62L fanout failure with real decoupling copper", async () => {
  const { inputSrj, options } = createAm62lRealDecouplingInput()
  const padObstacles = inputSrj.obstacles.filter(
    (obstacle) =>
      (obstacle as { circuitJsonMetadata?: { pcb_smtpad_id?: string } })
        .circuitJsonMetadata?.pcb_smtpad_id !== undefined,
  )
  const throughViaObstacles = inputSrj.obstacles.filter(
    (obstacle) =>
      (obstacle as { circuitJsonMetadata?: { pcb_via_id?: string } })
        .circuitJsonMetadata?.pcb_via_id !== undefined &&
      obstacle.layers.length === inputSrj.layerCount,
  )

  expect(inputSrj.connections).toHaveLength(135)
  expect(padObstacles).toHaveLength(709)
  expect(throughViaObstacles).toHaveLength(120)

  const solver = new FanoutSolver(inputSrj, {
    ...options,
    maxLayerCombinations: 1,
  })
  solver.solve()

  const bestRoutedConnectionCount = Math.max(
    0,
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(bestRoutedConnectionCount).toBeLessThan(135)

  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 2,
        text: "Real TSX · AM62L + LPDDR4 · 60 decouplers · 120 vias",
        color: "#0f172a",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: `Best routed ${bestRoutedConnectionCount}/135 · solved=${solver.solved} · failed=${solver.failed}`,
        color: "#b91c1c",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 600_000)

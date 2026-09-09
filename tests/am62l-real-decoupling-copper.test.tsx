import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { createAm62lRealDecouplingInput } from "./fixtures/create-am62l-real-decoupling-input"

test("routes the AM62L fanout with real decoupling copper", async () => {
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

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(135)
  expect(output.planeTerminations).toHaveLength(102)
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 135,
    brokenOutConnectionCount: 135,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: {
        ...output.simpleRouteJson,
        traces: output.fanoutTraces,
      },
      clearance: inputSrj.minViaEdgeToPadEdgeClearance!,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 135,
    checkedViaCount: 135,
    issues: [],
  })

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
        text: "Routed 135/135 · solved=true · DRC valid",
        color: "#166534",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 600_000)

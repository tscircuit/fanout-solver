import { expect, test } from "bun:test"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import captured from "./fixtures/am62l-core-progressive-fanout.json"

// Exact through-via centers from core's original 46 under-BGA AM62L
// decoupling placements. These vias are authored after the progressive fanout,
// but span every copper layer and therefore must be reserved while escaping U1.
const futureDecouplingViaCenters = [
  [-13.8, 4.7],
  [-12.2, 4.7],
  [-8, 0],
  [-6.4, 0],
  [-8.15, -4.25],
  [-8.45, -4.25],
  [-8.25, -0.25],
  [-8.55, 0.65],
  [-4.8, 1.7],
  [-5.2, 3.3],
  [-7.75, 3.25],
  [-7.05, 3.25],
  [-6.5, -1.6],
  [-4.9, -1.6],
  [-6.05, 3.75],
  [-6.75, 3.75],
  [-10.3, -4.7],
  [-8.7, -4.7],
  [-5.75, 3.45],
  [-5.75, 2.75],
  [-8.91, -1.85],
  [-7.89, -1.85],
  [-6.85, -1.55],
  [-7.75, -2.25],
  [-6.15, 3.45],
  [-5.25, 2.75],
  [-7.1, -1],
  [-5.5, -1],
  [-12.25, 3.75],
  [-11.9, 4.65],
  [-7.25, -4.75],
  [-6.1, -4.3],
  [-13.85, 4.35],
  [-13.5, 3.45],
  [-8.59, 6.65],
  [-9.61, 6.65],
  [-4.95, -2.65],
  [-4.95, -2.35],
  [-3.65, 0.79],
  [-3.65, 1.81],
  [-10.55, -4.25],
  [-11.25, -4.25],
  [-4.95, 3.65],
  [-5.25, 3.65],
  [-9.35, -5.95],
  [-10.25, -5.25],
  [-10.3, 1.7],
  [-8.7, 1.7],
  [-7.09, 6.65],
  [-8.11, 6.65],
  [-12.25, -4.75],
  [-12.7, -5.9],
  [-3.2, 3.7],
  [-4.8, 3.3],
  [-7.8, -6.4],
  [-8.25, -5.25],
  [-3.55, 2.75],
  [-4.25, 2.75],
  [-3.55, 3.25],
  [-4.25, 3.25],
  [-7.85, -5.95],
  [-8.75, -5.25],
  [-10.75, 4.65],
  [-11.05, 4.65],
  [-11.75, -5.25],
  [-11.3, -6.4],
  [-10.25, 6.65],
  [-10.55, 6.65],
  [-11.29, 6.45],
  [-12.31, 6.45],
  [-3.3, 0.1],
  [-3.3, 1.7],
  [-9.75, -5.85],
  [-9.3, -7],
  [-10.35, -6.35],
  [-10.35, -6.05],
  [-9.75, 3.75],
  [-10.45, 4.65],
  [-6.65, -0.85],
  [-5.5, -1.3],
  [-2.95, -3.65],
  [-2.95, -4.35],
  [-5.8, -6.4],
  [-6.25, -5.25],
  [-7.25, -5.25],
  [-7.25, -5.95],
  [-7.15, -1.69],
  [-6.25, -2.71],
  [-12.25, -5.75],
  [-12.25, -6.45],
  [-5.05, -4.35],
  [-4.75, -5.25],
] as const

const signalLayers = [
  "top",
  "inner1",
  "inner2",
  "inner3",
  "inner4",
  "inner5",
  "inner6",
  "bottom",
]

const futureDecouplingViaObstacles: Obstacle[] = futureDecouplingViaCenters.map(
  ([x, y], index) => ({
    obstacleId: `future-decoupling-via-${index}`,
    type: "rect",
    shape: "circle",
    layers: signalLayers,
    center: { x, y },
    width: 0.24,
    height: 0.24,
    connectedTo: [`future-decoupling-via-${index}`],
  }),
)

test("routes core's AM62L fanout around its future decoupling vias", async () => {
  const inputSrj = {
    ...captured.inputSrj,
    obstacles: [
      ...captured.inputSrj.obstacles.map(
        ({ connectedToSuffixIndex, ...obstacle }) => ({
          ...obstacle,
          connectedTo: [
            ...obstacle.connectedTo,
            ...(connectedToSuffixIndex === null
              ? []
              : captured.connectedToSuffixes[connectedToSuffixIndex]!),
          ],
        }),
      ),
      ...futureDecouplingViaObstacles,
    ],
  } as unknown as ConstructorParameters<typeof FanoutSolver>[0]
  const options = captured.options as unknown as NonNullable<
    ConstructorParameters<typeof FanoutSolver>[1]
  >
  const solver = new FanoutSolver(inputSrj, {
    ...options,
    maxLayerCombinations: 1,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expectStraightOr45Fanout(output.fanoutTraces)
  expect(output.fanoutTraces).toHaveLength(135)
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 135,
    brokenOutConnectionCount: 135,
    issues: [],
  })
  const routedSrj = {
    ...output.simpleRouteJson,
    traces: output.fanoutTraces,
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj,
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
        text: "Core AM62L · 135 fanouts · 92 future decoupling vias",
        color: "#0f172a",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: `solved=${solver.solved} · failed=${solver.failed} · routed=135/135 · DRC valid`,
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

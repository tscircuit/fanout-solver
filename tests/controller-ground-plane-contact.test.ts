import { beforeAll, expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import capturedInput from "./fixtures/six-layer-controller-ground-planes.json"

// Native SRJ captured before fanout from core's six-layer QFN controller and
// double-sided 0402/0603 decoupling repro. Preserve all pads and both pours.
// TSX: https://github.com/tscircuit/core/blob/fdd902c91c99e54627987027086657009cb889c1/tests/repros/fanout-two-ground-planes.test.tsx
const input = structuredClone(capturedInput) as SimpleRouteJson
const solver = new FanoutSolver(input, {
  busDirections: {
    U1_GND4: "left",
    U1_GND12: "right",
    C1_GND: "right",
    C2_GND: "left",
    C3_GND: "left",
  },
  allowSameNetMerges: false,
  allowBlindAndBuriedVias: false,
})

beforeAll(async () => {
  solver.solve()
  let traces: SimpleRouteJson["traces"] = []
  let dropCount = 0
  if (solver.solved) {
    const output = solver.getOutput()
    traces = output.fanoutTraces
    dropCount = output.planeTerminations.length
  }
  const graphics = visualizeSimpleRouteJson({ ...input, traces })
  graphics.texts ??= []
  graphics.texts.push(
    {
      x: 0,
      y: 4,
      text: "Six-layer controller: two reserved GND planes",
      fontSize: 0.4,
      anchorSide: "center",
    },
    {
      x: 0,
      y: 3.2,
      text: "inner1: 3 top drops / inner4: 2 backside drops",
      fontSize: 0.3,
      anchorSide: "center",
    },
    { x: 0, y: 2.4, text: "U1 QFN-16", fontSize: 0.3, anchorSide: "center" },
    { x: -4, y: 1, text: "C1 top 0402", fontSize: 0.25, anchorSide: "center" },
    {
      x: 0,
      y: -2.5,
      text: "C2 backside 0402",
      fontSize: 0.25,
      anchorSide: "center",
    },
    {
      x: 4,
      y: 1,
      text: "C3 backside 0603",
      fontSize: 0.25,
      anchorSide: "center",
    },
    {
      x: 0,
      y: -3.5,
      text: `Actual: ${dropCount}/5 ground drops; each via must clear every pad`,
      fontSize: 0.3,
      anchorSide: "center",
    },
  )
  // Keep image comparison outside the intentionally failing behavior check.
  await expect(
    getSvgFromGraphicsObject(graphics, { svgWidth: 1000, svgHeight: 700 }),
  ).toMatchSvgSnapshot(import.meta.path)
})

test.failing("a QFN controller and backside decouplers contact their reserved ground planes", () => {
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    issues: [],
    brokenOutConnectionCount: 5,
  })
  expect(
    output.planeTerminations.map(({ busId, layer }) => ({ busId, layer })),
  ).toEqual([
    { busId: "U1_GND4", layer: "inner1" },
    { busId: "U1_GND12", layer: "inner1" },
    { busId: "C1_GND", layer: "inner1" },
    { busId: "C2_GND", layer: "inner4" },
    { busId: "C3_GND", layer: "inner4" },
  ])
  expect(output.simpleRouteJson.connections).toEqual([])
  for (const { via } of output.planeTerminations) {
    expect(via.spanLayers).toEqual([
      "top",
      "inner1",
      "inner2",
      "inner3",
      "inner4",
      "bottom",
    ])
  }
})

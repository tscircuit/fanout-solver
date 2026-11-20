import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("iCE/Pi B2 escapes between the outer oval pads", async () => {
  // Native U22 pad centers, translated to B2; dimensions and rules are in mm.
  const input: SimpleRouteJson = {
    layerCount: 2,
    bounds: { minX: -0.8, maxX: 0.8, minY: -1.2, maxY: 0.9 },
    nominalTraceWidth: 0.1,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    minViaPadDiameter: 0.45,
    minViaHoleDiameter: 0.2,
    obstacles: [
      { name: "B2", x: 0, y: 0, width: 0.24, height: 0.24, circle: true },
      { name: "B3", x: -0.5, y: 0, width: 0.24, height: 0.24, circle: true },
      { name: "B1", x: 0.5, y: 0, width: 0.24, height: 0.24, circle: true },
      { name: "A3", x: -0.5, y: -0.5, width: 0.19, height: 0.3 },
      { name: "A2", x: 0, y: -0.5, width: 0.19, height: 0.3 },
      { name: "A1", x: 0.5, y: -0.5, width: 0.19, height: 0.3 },
      { name: "C3", x: -0.5, y: 0.5, width: 0.24, height: 0.24, circle: true },
      { name: "C2", x: 0, y: 0.5, width: 0.24, height: 0.24, circle: true },
      { name: "C1", x: 0.5, y: 0.5, width: 0.3, height: 0.19 },
    ].map((pad) => ({
      type: "rect",
      obstacleId: pad.name,
      componentId: "U22",
      center: { x: pad.x, y: pad.y },
      width: pad.width,
      height: pad.height,
      shape: pad.circle ? "circle" : undefined,
      layers: ["top"],
      connectedTo: [pad.name === "B2" ? "DATA" : pad.name],
    })),
    connections: [
      {
        name: "DATA",
        nominalTraceWidth: 0.1,
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 0, y: -1.2, layer: "top" },
        ],
      },
    ],
  }
  const solver = new FanoutSolver(input, {
    sharedBoundary: input.bounds,
    escapeLayers: ["top"],
    buses: [{ busId: "DATA", connectionNames: ["DATA"] }],
    busDirections: { DATA: "down" },
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.solved ? solver.getOutput() : undefined
  const copperDrc = output
    ? validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: output.simpleRouteJson,
        clearance: 0.1,
      })
    : undefined
  if (output) {
    expect(copperDrc).toMatchObject({
      valid: true,
      checkedViaCount: 0,
      issues: [],
    })
  }
  const graphics = solver.visualize()
  graphics.lines ??= []
  graphics.lines.push({
    points: [
      { x: input.bounds.minX, y: input.bounds.minY },
      { x: input.bounds.maxX, y: input.bounds.minY },
    ],
    strokeColor: "#64748b",
    strokeWidth: 0.01,
  })
  graphics.texts = [
    {
      x: -0.75,
      y: 1.25,
      fontSize: 0.07,
      anchorSide: "center_left",
      color: "#0f172a",
      text: "iCE/Pi U22 B2 must turn before the next pad.",
    },
    {
      x: -0.75,
      y: 1.1,
      fontSize: 0.055,
      anchorSide: "center_left",
      color: solver.solved ? "#166534" : "#b91c1c",
      text: solver.solved
        ? `PASS: B2 escapes; ${copperDrc!.checkedViaCount} vias, ${copperDrc!.issues.length} DRC errors.`
        : "FAIL: No route between the oval pads.",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})

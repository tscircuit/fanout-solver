import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("an enclosed i.MX6 pad repeats equivalent failed layer assignments", async () => {
  // U10.B2's captured 3x3 neighborhood, translated to the origin in board mm.
  // The outer A1 pad is a routable control; B2 is enclosed under these rules.
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.119,
    bounds: { minX: -1.4, maxX: 1.4, minY: -1.1, maxY: 1.1 },
    obstacles: [-0.5, 0, 0.5].flatMap((x, column) =>
      [0.5, 0, -0.5].map((y, row) => ({
        type: "rect" as const,
        shape: "circle" as const,
        center: { x, y },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        componentId: "U10",
        connectedTo: [`${"ABC"[row]}${column + 1}`],
      })),
    ),
    connections: [
      {
        name: "B2",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pcb_port_id: "B2" },
          { x: 1.4, y: 0, layer: "bottom" },
        ],
      },
      {
        name: "A1",
        pointsToConnect: [
          { x: -0.5, y: 0.5, layer: "top", pcb_port_id: "A1" },
          { x: -1.4, y: 0.5, layer: "bottom" },
        ],
      },
    ],
  }
  const solver = new FanoutSolver(input, {
    clearance: 0.119,
    viaDiameter: 0.4,
    viaHoleDiameter: 0.2,
    allowBlindAndBuriedVias: false,
    sharedBoundary: input.bounds,
  })
  solver.solve()
  expect(solver.failed).toBe(true)
  expect(() => solver.getOutput()).toThrow()
  const bestAttempt = Reflect.get(solver, "bestAttempt") as {
    outputSrj: SimpleRouteJson
    summary: { routedConnectionCount: number }
  }
  const routed = bestAttempt.summary.routedConnectionCount
  expect(routed).toBe(1)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: bestAttempt.outputSrj,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const graphics = solver.visualize()
  graphics.texts = [
    {
      x: -1.4,
      y: 1.35,
      text: `i.MX6 U10: ${routed}/${input.connections.length} escapes; failed`,
      fontSize: 0.11,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: -1.4,
      y: 1.15,
      text: `${solver.attempts.length} assignments | 0.119mm trace and clearance`,
      fontSize: 0.08,
      color: "#475569",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, { backgroundColor: "white" }),
  ).toMatchSvgSnapshot(import.meta.path)
})

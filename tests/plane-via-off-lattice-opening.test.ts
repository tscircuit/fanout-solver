import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBusAlternatives } from "lib/route-bus"
import { circleFitsInsideObstacle } from "lib/geometry"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import type { Bounds } from "lib/types"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

function foreignCopper(bounds: Bounds): Obstacle {
  return {
    type: "rect",
    layers: ["inner2"],
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    },
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    connectedTo: ["foreign-copper"],
  }
}

test("a plane drop finds an opening away from the pad lattice", async () => {
  const { input, options } = createTwoViaWindows()
  input.minViaPadDiameter = 0.2
  input.connections = [input.connections[0]!]
  options.buses = [options.buses![0]!]
  // The only barrel opening is 0.36 mm wide, centered at (-0.42, 0.205).
  const borders: Bounds[] = [
    { minX: -1.1, maxX: 1.7, minY: -1.1, maxY: 0.025 },
    { minX: -1.1, maxX: 1.7, minY: 0.385, maxY: 1.1 },
    { minX: -1.1, maxX: -0.6, minY: 0.025, maxY: 0.385 },
    { minX: -0.24, maxX: 1.7, minY: 0.025, maxY: 0.385 },
  ]
  const landing: Obstacle = {
    type: "rect",
    layers: ["inner1"],
    center: { x: -0.42, y: 0.205 },
    width: 0.36,
    height: 0.36,
    connectedTo: ["GND"],
    isCopperPour: true,
  }
  input.obstacles = [
    ...input.obstacles.filter((obstacle) => obstacle.componentId === "U1"),
    ...borders.map(foreignCopper),
    ...borders.map((bounds) => ({
      ...foreignCopper(bounds),
      layers: ["inner1"],
      isCopperPour: true,
    })),
    landing,
  ]
  const solver = new FanoutSolver(input, options)
  expect(
    routeBusAlternatives(
      {
        ...solver.config,
        srj: input,
        bus: solver.preparedBuses[0]!,
        targetLayer: "inner1",
        acceptedPlans: [],
      },
      solver.config.maxLayerCombinations,
    ),
  ).toHaveLength(0)
  solver.solve()
  const output = solver.solved ? solver.getOutput() : undefined
  const traces = output?.fanoutTraces ?? []
  const terminations = output?.planeTerminations ?? []
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: output?.simpleRouteJson ?? { ...input, traces: [] },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: traces.length,
    checkedViaCount: terminations.length,
    issues: [],
  })
  for (const trace of traces) {
    for (const point of trace.route) {
      if (point.route_type === "wire") expect(point.width).toBeCloseTo(0.1)
    }
  }
  for (const { layer, via } of terminations) {
    expect(layer).toBe("inner1")
    expect(via.diameter).toBeCloseTo(0.2)
    expect(
      circleFitsInsideObstacle({
        center: via.center,
        diameter: via.diameter,
        obstacle: landing,
      }),
    ).toBe(true)
  }
  const routed = traces.length
  const graphics = solver.visualize()
  graphics.texts = [
    {
      x: input.bounds.minX,
      y: input.bounds.maxY + 0.22,
      text: `Plane escape through a copper opening · ${routed}/1 routed`,
      fontSize: 0.12,
      anchorSide: "center_left",
      color: "#0f172a",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 900,
      svgHeight: 700,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})

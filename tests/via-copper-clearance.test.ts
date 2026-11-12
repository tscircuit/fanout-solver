import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { matchComponentDogboneViaSites } from "lib/match-component-dogbone-via-sites"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("via copper honors the board rule independently of via-to-pad clearance", async () => {
  const input = {
    layerCount: 4,
    minTraceWidth: 0.08128,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.15,
    minViaEdgeToPadEdgeClearance: 0.08128,
    minPadEdgeToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    obstacles: [
      { x: 0, y: 0 },
      { x: 0.33, y: 0 },
      { x: 0, y: 0.8 },
      { x: 0.33, y: 0.8 },
    ].map((center, index) => ({
      type: "rect" as const,
      shape: "circle" as const,
      obstacleId: `pad-${index}`,
      componentId: "U1",
      center,
      width: 0.1,
      height: 0.1,
      layers: ["top"],
      connectedTo: [`N${index}`],
    })),
    connections: [] as SimpleRouteJson["connections"],
  }
  input.connections = input.obstacles.map((pad, index) => ({
    name: `N${index}`,
    pointsToConnect: [
      { ...pad.center, layer: "top", pcb_port_id: `N${index}` },
    ],
  }))
  const options = {
    defaultDirection: "down" as const,
    allowBlindAndBuriedVias: false,
    buses: input.connections.map(({ name }) => ({
      busId: name,
      connectionNames: [name],
      termination: { type: "plane" as const, layer: "inner1" },
    })),
  }
  const control = new FanoutSolver(
    { ...input, minPadEdgeToPadEdgeClearance: undefined } as SimpleRouteJson,
    options,
  )
  const solver = new FanoutSolver(input, options)
  control.solve()
  solver.solve()
  const controlOutput = control.getOutput()
  const output = solver.getOutput()
  for (const result of [control, solver]) {
    expect(result.error).toBeNull()
    expect(result.solved).toBe(true)
    expect(result.getOutput().fanoutTraces).toHaveLength(4)
    expect(result.getOutput().validation.valid).toBe(true)
  }

  const minimumGap = (result: typeof output) => {
    const vias = result.planeTerminations.map(({ via }) => via)
    return Math.min(
      ...vias.flatMap((a, index) =>
        vias
          .slice(index + 1)
          .map(
            (b) =>
              Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) -
              (a.diameter + b.diameter) / 2,
          ),
      ),
    )
  }
  expect(minimumGap(controlOutput)).toBeCloseTo(0.09)
  expect(minimumGap(output)).toBeGreaterThanOrEqual(0.1 - 1e-9)
  const audit = (result: typeof output) =>
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: result.simpleRouteJson,
      clearance: input.minViaEdgeToPadEdgeClearance,
      allowBlindAndBuriedVias: false,
    })
  expect(audit(controlOutput).issues.map(({ code }) => code)).toEqual([
    "different-net-via-clearance",
    "different-net-via-clearance",
  ])
  expect(audit(output).issues).toEqual([])

  const sites = matchComponentDogboneViaSites(
    prepareFanoutBuses(input, options),
    {
      traceWidth: input.minTraceWidth,
      viaDiameter: input.minViaPadDiameter,
      viaHoleDiameter: input.minViaHoleDiameter,
      clearance: input.minViaEdgeToPadEdgeClearance,
      viaToViaClearance: input.minPadEdgeToPadEdgeClearance,
    },
  )
  expect(sites?.size).toBe(4)
  const points = [...sites!.values()]
  for (const [index, a] of points.entries())
    for (const b of points.slice(index + 1))
      expect(
        Math.hypot(a.x - b.x, a.y - b.y) - input.minViaPadDiameter,
      ).toBeGreaterThanOrEqual(0.1 - 1e-9)

  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    title: "Via copper spacing uses its own board rule",
    circles: [],
    lines: [],
    texts: [],
  }
  for (const [panel, result] of [controlOutput, output].entries()) {
    const shift = panel * 3,
      point = (p: { x: number; y: number }) => ({ x: p.x + shift, y: p.y })
    for (const pad of input.obstacles)
      graphics.circles!.push({
        center: point(pad.center),
        radius: pad.width / 2,
        fill: "#64748b",
      })
    for (const trace of result.fanoutTraces) {
      for (let i = 1; i < trace.route.length; i++) {
        const a = trace.route[i - 1]!,
          b = trace.route[i]!
        if (a.route_type === "wire" && b.route_type === "wire")
          graphics.lines!.push({
            points: [point(a), point(b)],
            strokeColor: "#2563eb",
            strokeWidth: a.width,
          })
      }
    }
    for (const { via } of result.planeTerminations) {
      graphics.circles!.push(
        {
          center: point(via.center),
          radius: via.diameter / 2,
          fill: "#d97706",
        },
        {
          center: point(via.center),
          radius: via.holeDiameter / 2,
          fill: "white",
        },
      )
    }
    graphics.texts!.push(
      {
        x: shift + 0.2,
        y: 1.7,
        text: panel ? "Board via gap: 0.10 mm" : "Control: rule omitted",
        fontSize: 0.16,
      },
      {
        x: shift + 0.2,
        y: 1.4,
        text: `Actual minimum: ${minimumGap(result).toFixed(2)} mm`,
        fontSize: 0.14,
      },
    )
  }
  graphics.texts!.push({
    x: 1.7,
    y: -1.8,
    text: "Same 0.08128 mm via-to-pad rule; 0.24 mm copper / 0.15 mm holes",
    fontSize: 0.13,
  })
  graphics.texts!.push({
    x: 1.7,
    y: -2.1,
    text: "Gray: component pads | Orange: via copper | Blue: traces",
    fontSize: 0.13,
  })
  await expect(
    getSvgFromGraphicsObject(graphics, { svgWidth: 1000, svgHeight: 650 }),
  ).toMatchSvgSnapshot(import.meta.path)
})

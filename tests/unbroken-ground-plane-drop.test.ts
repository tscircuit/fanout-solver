import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"

test("a ground pad dropping into a reserved inner1 plane", async () => {
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    rects: [],
    circles: [],
    lines: [],
    texts: [],
  }
  for (const [index, planeNet] of [null, "GND", "VCC"].entries()) {
    const pad = {
      type: "rect" as const,
      shape: "circle",
      componentId: "U1",
      center: { x: 0, y: 0 },
      width: 0.35,
      height: 0.35,
      layers: ["top"],
      connectedTo: ["U1.1", "GND_A1", "GND"],
    }
    const input: SimpleRouteJson = {
      layerCount: 6,
      minTraceWidth: 0.1,
      minViaDiameter: 0.5,
      bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
      connections: [
        {
          name: "GND_A1",
          netConnectionName: "GND",
          pointsToConnect: [{ x: 0, y: 0, layer: "top", pointId: "U1.1" }],
        },
      ],
      obstacles: [pad],
    }
    if (planeNet) {
      input.obstacles.push({
        type: "rect",
        isCopperPour: true,
        layers: ["inner1"],
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        connectedTo: [planeNet],
      })
    }
    const solver = new FanoutSolver(input, {
      buses: [
        {
          busId: "GND_A1",
          connectionNames: ["GND_A1"],
          termination: { type: "plane", layer: "inner1" },
        },
      ],
      busDirections: { GND_A1: "right" },
    })
    solver.solve()
    expect(solver.solved).toBe(planeNet === null)
    if (!solver.solved) expect(solver.error).toContain("routed 0/1 connections")
    const output = solver.solved ? solver.getOutput() : undefined
    const drop = output?.planeTerminations[0]
    if (output) {
      expect(output.fanoutTraces).toHaveLength(1)
      expect(output.planeTerminations).toHaveLength(1)
      expect(drop).toMatchObject({ connectionName: "GND_A1", layer: "inner1" })
    }
    // Magnified view at U1.1, with the same XY scale and pad in every panel.
    const x = index * 2.65
    graphics.rects!.push({
      center: { x, y: 0 },
      width: 2.5,
      height: 1.6,
      fill:
        planeNet === "GND"
          ? "rgba(36,130,77,0.16)"
          : planeNet === "VCC"
            ? "rgba(175,42,32,0.14)"
            : "rgba(60,85,110,0.08)",
      stroke: "#64748b",
    })
    graphics.circles!.push({
      center: { x, y: 0 },
      radius: pad.width / 2,
      fill: "#a6472c",
    })
    for (const trace of output?.fanoutTraces ?? []) {
      for (const [i, a] of trace.route.entries()) {
        const b = trace.route[i + 1]
        if (
          a.route_type === "wire" &&
          b?.route_type === "wire" &&
          a.layer === "top" &&
          b.layer === "top"
        ) {
          graphics.lines!.push({
            points: [
              { x: x + a.x, y: a.y },
              { x: x + b.x, y: b.y },
            ],
            strokeColor: "#a6472c",
            strokeWidth: a.width,
          })
        }
      }
    }
    if (drop) {
      const center = { x: x + drop.via.center.x, y: drop.via.center.y }
      graphics.circles!.push(
        { center, radius: drop.via.diameter / 2, fill: "#bf8020" },
        { center, radius: drop.via.holeDiameter / 2, fill: "white" },
      )
    }
    graphics.texts!.push(
      {
        x,
        y: 1.05,
        text: planeNet ? `inner1: ${planeNet} pour` : "No pour reservation",
        fontSize: 0.18,
        anchorSide: "center",
      },
      {
        x,
        y: -1.05,
        text: drop ? "GND pad + via to inner1" : "GND pad only: 0 vias",
        fontSize: 0.16,
        anchorSide: "center",
      },
    )
  }
  await expect(
    getSvgFromGraphicsObject(graphics, {
      svgWidth: 1100,
      svgHeight: 360,
      backgroundColor: "white",
    }).replace(/[ \t]+$/gm, ""),
  ).toMatchSvgSnapshot(import.meta.path)
})

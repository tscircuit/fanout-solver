import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"

const initialAssignment = (
  allowAlternative: boolean,
  embedded: boolean | "edge",
) => {
  const points = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y })))
  const middle = points.findIndex((point) => point.x === 0 && point.y === 0)
  if (!embedded) points[middle] = { x: -3, y: 0 }
  if (embedded === "edge") points[middle] = { x: 0.5, y: -1 }
  const connections = points.map((point, i) => ({
    name: `net-${i}`,
    pointsToConnect: [
      { ...point, layer: "top", pcb_port_id: `pad-${i}` },
      { x: 5, y: i / 2, layer: "inner1" },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections,
    obstacles: points.map((point, i) => ({
      type: "rect",
      center: point,
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [`net-${i}`, `pad-${i}`],
    })),
  }
  const wide = connections.filter((_, i) => i !== middle)
  const solver = new FanoutSolver(srj, {
    maxLayerCombinations: 1,
    allowBlindAndBuriedVias: false,
    buses: [
      {
        busId: "wide",
        connectionNames: wide.map((connection) => connection.name),
        exitPosition: "rightside_center",
        allowedLayers: allowAlternative ? ["inner1", "bottom"] : ["inner1"],
        connectionExitTargets: Object.fromEntries(
          wide.map((connection, i) => [
            connection.name,
            { x: 5, y: i / 2, layer: i % 2 ? "bottom" : "inner1" },
          ]),
        ),
      },
      {
        busId: "embedded",
        connectionNames: [connections[middle]!.name],
        allowedLayers: ["inner1"],
        exitPosition: "rightside_center",
        connectionExitTargets: {
          [connections[middle]!.name]: { x: 5, y: 0, layer: "inner1" },
        },
      },
    ],
  })
  for (
    let steps = 0;
    steps < 100 && !solver.layerAssignments.length && !solver.failed;
    steps++
  )
    solver.step()
  expect(solver.failed).toBe(false)
  expect(solver.layerAssignments).toHaveLength(1)
  return solver.layerAssignments[0]!
}

test("isolates a fixed-layer singleton enclosed by a mixed-layer wide source field", () => {
  expect(initialAssignment(true, true)).toMatchObject({
    wide: "bottom",
    embedded: "inner1",
  })
  expect(initialAssignment(false, true)).toMatchObject({
    wide: "inner1",
    embedded: "inner1",
  })
  expect(initialAssignment(true, "edge")).toMatchObject({
    wide: "inner1",
    embedded: "inner1",
  })
  expect(initialAssignment(true, false)).toMatchObject({
    wide: "inner1",
    embedded: "inner1",
  })
})

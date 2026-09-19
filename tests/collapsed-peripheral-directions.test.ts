import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { prepareFanoutBuses } from "lib/prepare-buses"

test("four-sided leads escape outward when every target is on one boundary", () => {
  const bounds = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const leads = [
    { name: "left", x: -1.5, y: 0, width: 1, height: 0.2, targetX: -3 },
    { name: "right", x: 1.5, y: 0, width: 1, height: 0.2, targetX: 3 },
    { name: "up", x: 0, y: 1.5, width: 0.2, height: 1, targetX: 1 },
    { name: "down", x: 0, y: -1.5, width: 0.2, height: 1, targetX: -1 },
  ] as const
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: 0.1,
    connections: leads.map((lead) => ({
      name: lead.name,
      pointsToConnect: [
        { x: lead.x, y: lead.y, layer: "top" },
        { x: lead.targetX, y: bounds.minY, layer: "bottom" },
      ],
    })),
    obstacles: leads.map((lead) => ({
      type: "rect",
      center: { x: lead.x, y: lead.y },
      width: lead.width,
      height: lead.height,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [lead.name],
    })),
  }

  const directions = Object.fromEntries(
    prepareFanoutBuses(srj, { sharedBoundary: bounds }).map((bus) => [
      bus.connections[0]!.connection.name,
      bus.direction,
    ]),
  )

  expect(directions).toEqual({
    left: "left",
    right: "right",
    up: "up",
    down: "down",
  })
})

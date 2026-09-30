import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeLocalSignalDogbones } from "lib/route-local-signal-dogbones"

test("local signal dogbones escape both pad fields without boundary routes", async () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -4, maxY: 4 },
    connections: [],
    obstacles: [],
  }
  for (const [componentId, y] of [
    ["U1", 2],
    ["U2", -2],
  ] as const)
    for (let i = 0; i < 4; i++) {
      input.obstacles.push({
        type: "rect",
        componentId,
        layers: ["top"],
        center: { x: (i % 2) * 0.8 - 0.4, y: y + Math.floor(i / 2) * 0.8 },
        width: 0.4,
        height: 0.4,
        connectedTo: [`port_${componentId}_${i}`, `signal_${i}`],
        shape: "circle",
      } as SimpleRouteJson["obstacles"][number])
    }
  for (let i = 0; i < 4; i++)
    input.connections.push({
      name: `signal_${i}`,
      pointsToConnect: input.obstacles
        .filter((o) => o.connectedTo.includes(`signal_${i}`))
        .map((o) => ({
          ...o.center,
          layer: "top",
          pcb_port_id: o.connectedTo[0],
        })),
    })
  const before = JSON.stringify(input)
  const options = {
    targetLayers: new Map(input.connections.map((c) => [c.name, "inner1"])),
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
  }
  const result = routeLocalSignalDogbones(input, options)
  expect(JSON.stringify(input)).toBe(before)
  expect(result.traces).toHaveLength(8)
  expect(
    result.connections
      .flatMap((c) => c.pointsToConnect)
      .every((p) => "layer" in p && p.layer === "inner1"),
  ).toBe(true)
  for (const trace of result.traces) {
    const via = trace.route.find((p) => p.route_type === "via")!
    expect(via.layers).toEqual(["top", "inner1", "inner2", "bottom"])
    const first = trace.route[0]!
    if (first.route_type !== "wire") throw Error("Expected wire")
    expect(Math.hypot(first.x - via.x, first.y - via.y)).toBeLessThan(0.6)
  }
  const unchanged = routeLocalSignalDogbones(
    { ...input, connections: result.connections },
    options,
  )
  expect(unchanged.traces).toHaveLength(0)
  for (const layer of ["top", "bottom"])
    for (const degrees of [0, 90, 180, 270]) {
      const rotated = structuredClone(input)
      rotated.bounds = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
      const radians = (degrees * Math.PI) / 180
      const rotate = (p: { x: number; y: number }) => ({
        x: p.x * Math.cos(radians) - p.y * Math.sin(radians),
        y: p.x * Math.sin(radians) + p.y * Math.cos(radians),
      })
      rotated.obstacles = rotated.obstacles.map((o) => ({
        ...o,
        center: rotate(o.center),
        layers: [layer],
      }))
      rotated.connections = rotated.connections.map((c) => ({
        ...c,
        pointsToConnect: c.pointsToConnect.map((p) => ({
          ...p,
          ...rotate(p),
          layer,
        })),
      }))
      const escaped = routeLocalSignalDogbones(rotated, options)
      expect(escaped.traces).toHaveLength(8)
      for (const trace of escaped.traces) {
        const a = trace.route[0]!,
          b = trace.route.find((p) => p.route_type === "via")!
        if (a.route_type !== "wire") throw Error("Expected wire")
        expect(
          Math.abs(Math.abs(a.x - b.x) - Math.abs(a.y - b.y)),
        ).toBeLessThan(1e-8)
      }
    }
  const blocked = structuredClone(input)
  blocked.obstacles.push({
    type: "rect",
    center: { x: 0, y: 0 },
    width: 6,
    height: 8,
    layers: ["bottom"],
    connectedTo: [],
  })
  expect(() => routeLocalSignalDogbones(blocked, options)).toThrow()
  const graphics = {
    title: "Local signal dogbones: 8 pads, 8 through vias; no boundary escape",
    circles: input.obstacles.map((o) => ({
      center: o.center,
      radius: o.width / 2,
      fill: "#c44",
      stroke: "#c44",
    })),
    lines: result.traces.map((t) => ({
      points: t.route.flatMap((p) =>
        p.route_type === "wire" || p.route_type === "via"
          ? [{ x: p.x, y: p.y }]
          : [],
      ),
      strokeColor: "#e90",
      strokeWidth: 0.1,
    })),
    points: result.traces.flatMap((t) => {
      const p = t.route.at(-1)!
      return p.route_type === "wire"
        ? [{ x: p.x, y: p.y, color: "#45d", label: t.connection_name }]
        : []
    }),
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  createBoundaryTerminalConnector,
  getBoundaryTerminalEntry,
} from "lib/boundary-terminal-connectors"
import { distance, distancePointToSegment } from "lib/geometry"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("a side-first terminal entry clears a retained through-via while preserving the exact tail", async () => {
  const width = 0.08128,
    clearance = 0.08128,
    viaDiameter = 0.24
  const bounds = { minX: 0, maxX: 1.5, minY: -10.45, maxY: -9.1 }
  const layerNames = ["top", "inner1", "bottom"]
  const retainedVia = { x: 0.56344, y: -10.00296 }
  const activeVia = { x: 0.9, y: -9.95 }
  const sources = [activeVia, retainedVia].map((point) => ({
    x: point.x,
    y: -9.5,
    layer: "top",
  }))
  const connector = createBoundaryTerminalConnector({
    connectionName: "active",
    edge: "bottom",
    layer: "inner1",
    exit: { x: 0.49872, y: -10.45 },
    bounds,
    approachLength: width + clearance,
  })
  const before = JSON.stringify({ connector, retainedVia, activeVia, sources })
  const required = (width + viaDiameter) / 2 + clearance
  const normalEntry = getBoundaryTerminalEntry(
    { x: 0.48216, y: -10.16552 },
    connector,
  )!
  expect(normalEntry).toHaveLength(3)
  expect(
    Math.min(
      ...normalEntry
        .slice(1)
        .map((point, i) =>
          distancePointToSegment(retainedVia, normalEntry[i]!, point),
        ),
    ),
  ).toBeLessThan(required)
  const sideEntry = getBoundaryTerminalEntry(
    { x: 0.56344, y: -10.2468 },
    connector,
  )!
  expect(sideEntry[0]).toEqual({ x: 0.56344, y: -10.2468 })
  expect(sideEntry[1]!.x).toBeCloseTo(0.53936, 10)
  expect(sideEntry[1]!.y).toBe(-10.2468)
  expect(sideEntry.at(-1)).toBe(connector.goal)
  for (const [i, point] of sideEntry.slice(1).entries())
    expect(
      distancePointToSegment(retainedVia, sideEntry[i]!, point),
    ).toBeGreaterThanOrEqual(required - 1e-9)
  expect(
    getBoundaryTerminalEntry({ x: 0.56344, y: -10.4 }, connector),
  ).toBeNull()

  const normalized = normalizeLayeredPath({
    points: [
      { ...sources[0]!, z: 0 },
      { ...activeVia, z: 0 },
      { ...activeVia, z: 1 },
      { x: activeVia.x, y: sideEntry[0]!.y, z: 1 },
      ...sideEntry.map((point) => ({ ...point, z: 1 })),
      { ...connector.exit, z: 1 },
    ],
    chamfer: width / 4,
    segmentIsClear: (a, b) =>
      a.z !== 1 || distancePointToSegment(retainedVia, a, b) >= required - 1e-9,
  })!
  expect(normalized).not.toBeNull()
  expect(normalized.at(-1)).toMatchObject(connector.exit)
  const lastStart = normalized.at(-2)!
  expect(
    distancePointToSegment(connector.goal, lastStart, normalized.at(-1)!),
  ).toBeLessThan(1e-7)
  for (let i = 1; i < normalized.length; i++) {
    const a = normalized[i - 1]!,
      b = normalized[i]!
    if (a.z !== b.z) {
      expect(distance(a, b)).toBeLessThan(1e-7)
      continue
    }
    const dx = b.x - a.x,
      dy = b.y - a.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const c = normalized[i + 1]
    if (c?.z === b.z)
      expect(
        (dx * (c.x - b.x) + dy * (c.y - b.y)) /
          (distance(a, b) * distance(b, c)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
  }
  const wire = (point: { x: number; y: number; z: number }) => ({
    route_type: "wire" as const,
    x: point.x,
    y: point.y,
    width,
    layer: layerNames[point.z]!,
  })
  const traces = [
    { name: "active", points: normalized },
    {
      name: "retained",
      points: [
        { ...sources[1]!, z: 0 },
        { ...retainedVia, z: 0 },
        { ...retainedVia, z: 2 },
      ],
    },
  ].map(({ name, points }) => ({
    type: "pcb_trace" as const,
    pcb_trace_id: name,
    connection_name: name,
    route: points.flatMap((point, i) => {
      const previous = points[i - 1]
      return previous && previous.z !== point.z
        ? [
            {
              route_type: "via" as const,
              x: point.x,
              y: point.y,
              from_layer: layerNames[previous.z]!,
              to_layer: layerNames[point.z]!,
              via_diameter: viaDiameter,
              via_hole_diameter: 0.1,
            },
            wire(point),
          ]
        : [wire(point)]
    }),
  }))
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: layerNames.length,
    minTraceWidth: width,
    obstacles: sources.map((center, i) => ({
      type: "rect",
      center,
      width: 0.12,
      height: 0.12,
      layers: ["top"],
      connectedTo: [i === 0 ? "active" : "retained"],
    })),
    connections: sources.map((source, i) => ({
      name: i === 0 ? "active" : "retained",
      pointsToConnect: [source],
    })),
  }
  const native = validateRoutedCopperDrc({
    inputSrj: srj,
    routedSrj: { ...srj, traces },
    clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(native).toMatchObject({ valid: true, issues: [], checkedViaCount: 2 })
  expect(JSON.stringify({ connector, retainedVia, activeVia, sources })).toBe(
    before,
  )
  const graphics = visualizeSimpleRouteJson({ ...srj, traces, connections: [] })
  graphics.lines!.push({
    points: normalEntry,
    strokeColor: "#dc2626",
    strokeWidth: width,
  })
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

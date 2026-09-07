import "./fixtures/preload"
import { expect, test } from "bun:test"
import {
  circleFitsInsideObstacle,
  distancePointToObstacle,
  distanceSegmentToObstacle,
  pointIsInsideObstacle,
} from "../lib/geometry"
import {
  createOrthogonalFanoutView,
  ORTHOGONAL_MATRICES,
} from "../lib/orthogonal-fanout-view"
import type {
  FanoutRoutePlan,
  PreparedConnection,
  RoutedSegment,
} from "../lib/types"

test("preserves rotated pad clearance, edge bands, layers and source identity in all eight orthogonal views", async () => {
  const pad = {
    type: "rect" as const,
    center: { x: 1.1, y: 0.4 },
    width: 1.8,
    height: 0.65,
    ccwRotationDegrees: 37,
    layers: ["top"],
    connectedTo: ["top-left"],
    componentId: "right",
  }
  const circle = { ...pad, shape: "circle" as const, width: 0.7, height: 9 }
  const bounds = { minX: -3, maxX: 5, minY: -2, maxY: 4 }
  const through = [
    "top",
    "inner1",
    "inner2",
    "inner3",
    "inner4",
    "inner5",
    "inner6",
    "bottom",
  ]
  const sourcePoint = { ...pad.center, layer: "top", pointId: "top" }
  const targetPoint = { x: 6, y: 3, layer: "bottom", pointId: "right" }
  const prepared: PreparedConnection = {
    connectionIndex: 3,
    sourcePointIndex: 0,
    sourcePoint,
    targetPoint,
    sourceLayer: "top",
    sourceObstacle: pad,
    connection: { name: "left", pointsToConnect: [sourcePoint, targetPoint] },
  }
  const plan: FanoutRoutePlan = {
    ...prepared,
    connectionName: "left",
    busId: "top-right",
    targetLayer: "inner6",
    direction: "up",
    exitEdge: "right",
    cornerBandSide: "maximum",
    termination: { type: "boundary" },
    exitPoint: { x: bounds.maxX, y: 3 },
    length: 5,
    segments: [],
    trace: {
      type: "pcb_trace",
      pcb_trace_id: "top",
      connection_name: "left",
      route: [],
    },
    via: {
      center: { x: 2.5, y: 1 },
      diameter: 0.24,
      holeDiameter: 0.1,
      fromLayer: "top",
      toLayer: "inner6",
      spanLayers: through,
    },
  }
  const graph = {
    bounds,
    pads: [pad],
    sourceObstacle: pad,
    plan,
    prepared,
    pitchX: 0.65,
    pitchY: 0.8,
    xCoordinates: [-2, 1],
    yCoordinates: [-3, 4],
    direction: "up",
    exitEdge: "right",
    preferredExit: "top-left",
    cornerBandSide: "maximum",
    defaultDirection: "down",
    defaultPreferredExit: "bottom-right",
    busDirections: { left: "up" },
    busExitPreferences: { right: "bottom-left" },
    exitPosition: "rightside_top",
    availableCornersAndSides: ["right_top", "top_middle", "left"],
    name: "up",
    layerNames: through,
    targets: new Map([[pad, sourcePoint]]),
    reserved: new Set([pad]),
  }
  const expected = {
    identity: ["up", "right", "top-left", "maximum"],
    clockwise: ["right", "bottom", "top-right", "maximum"],
    halfTurn: ["down", "left", "bottom-right", "minimum"],
    counterclockwise: ["left", "top", "bottom-left", "minimum"],
    reflectX: ["up", "left", "top-right", "maximum"],
    reflectY: ["down", "right", "bottom-left", "minimum"],
    transpose: ["right", "top", "bottom-right", "maximum"],
    antiTranspose: ["left", "bottom", "top-left", "minimum"],
  }
  const points = Array.from({ length: 25 }, (_, index) => ({
    x: pad.center.x + ((index % 5) - 2) * 0.47,
    y: pad.center.y + (Math.floor(index / 5) - 2) * 0.39,
  }))
  const segments: RoutedSegment[] = [
    {
      start: { x: -2, y: 1 },
      end: { x: 3, y: 1 },
      width: 0.08,
      layer: "inner6",
    },
    {
      start: { x: -1, y: 2.5 },
      end: { x: 2, y: -0.5 },
      width: 0.08,
      layer: "top",
    },
    {
      start: { x: 0.4, y: -1.7 },
      end: { x: 2.4, y: -1.7 },
      width: 0.08,
      layer: "top",
    },
  ]
  const panels: string[] = []
  let index = 0
  for (const [name, matrix] of Object.entries(ORTHOGONAL_MATRICES)) {
    const view = createOrthogonalFanoutView(matrix)
    const canonical = view.toCanonical(graph)
    const convertedPad = canonical.pads[0]
    const convertedCircle = view.toCanonical(circle)
    expect([
      canonical.direction,
      canonical.exitEdge,
      canonical.preferredExit,
      canonical.cornerBandSide,
    ]).toEqual(expected[name as keyof typeof expected])
    expect(canonical.sourceObstacle).toBe(convertedPad)
    expect(canonical.plan.sourceObstacle).toBe(convertedPad)
    expect(canonical.prepared.sourceObstacle).toBe(convertedPad)
    expect(canonical.prepared.sourcePoint).toBe(
      canonical.targets.get(convertedPad)!,
    )
    expect(canonical.reserved.has(convertedPad)).toBe(true)
    expect(canonical.plan.via?.spanLayers).toEqual(through)
    expect(canonical.name).toBe("up")
    expect(convertedPad.componentId).toBe("right")
    expect(convertedPad.connectedTo).toEqual(["top-left"])
    expect(convertedCircle.width).toBe(circle.width)
    expect(canonical.pitchX).toBe(matrix[0] ? graph.pitchX : graph.pitchY)
    expect(canonical.pitchY).toBe(matrix[2] ? graph.pitchX : graph.pitchY)
    const restored = view.toOriginal(canonical)
    expect(restored).toEqual(graph)
    expect(restored.plan.sourceObstacle).toBe(pad)
    const newPlan = { ...canonical.plan, segments: view.toCanonical(segments) }
    const restoredPlan = view.restorePlan(newPlan, prepared)
    expect(restoredPlan.sourceObstacle).toBe(pad)
    expect(restoredPlan.targetPoint).toBe(targetPoint)
    expect(restoredPlan.sourcePoint).toBe(sourcePoint)
    expect(restoredPlan.segments).toEqual(segments)
    expect(() =>
      view.restorePlan(newPlan, { ...prepared, connectionIndex: 7 }),
    ).toThrow()
    for (const p of points) {
      const q = view.toCanonical(p)
      expect(distancePointToObstacle(q, convertedPad)).toBeCloseTo(
        distancePointToObstacle(p, pad),
        9,
      )
      expect(pointIsInsideObstacle(q, convertedPad)).toBe(
        pointIsInsideObstacle(p, pad),
      )
      expect(
        circleFitsInsideObstacle({
          center: q,
          diameter: 0.12,
          obstacle: convertedPad,
        }),
      ).toBe(
        circleFitsInsideObstacle({ center: p, diameter: 0.12, obstacle: pad }),
      )
      expect(distancePointToObstacle(q, convertedCircle)).toBeCloseTo(
        distancePointToObstacle(p, circle),
        9,
      )
    }
    for (const segment of segments) {
      expect(
        distanceSegmentToObstacle(view.toCanonical(segment), convertedPad),
      ).toBeCloseTo(distanceSegmentToObstacle(segment, pad), 9)
      expect(
        distanceSegmentToObstacle(view.toCanonical(segment), convertedCircle),
      ).toBeCloseTo(distanceSegmentToObstacle(segment, circle), 9)
    }
    const x = (index % 4) * 260
    const y = Math.floor(index / 4) * 230
    const screen = ({ x, y }: { x: number; y: number }) =>
      `${125 + x * 25},${125 - y * 25}`
    const radians = (convertedPad.ccwRotationDegrees * Math.PI) / 180
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => {
      const px = (sx * convertedPad.width) / 2
      const py = (sy * convertedPad.height) / 2
      return screen({
        x:
          convertedPad.center.x +
          px * Math.cos(radians) -
          py * Math.sin(radians),
        y:
          convertedPad.center.y +
          px * Math.sin(radians) +
          py * Math.cos(radians),
      })
    })
    panels.push(
      `<g transform="translate(${x},${y})"><rect x="6" y="6" width="248" height="218" rx="8" fill="#f8fafc" stroke="#cbd5e1"/><text x="16" y="28" font-size="14">${name}</text><path d="M26 125H228 M125 42V208" stroke="#cbd5e1"/><polygon points="${corners.join(" ")}" fill="#fde68a" stroke="#b45309" stroke-width="2"/>${segments
        .map((segment) => {
          const transformed = view.toCanonical(segment)
          return `<polyline points="${screen(transformed.start)} ${screen(transformed.end)}" fill="none" stroke="#0891b2" stroke-width="2.2"/>`
        })
        .join(
          "",
        )}<text x="16" y="212" font-size="11">${canonical.exitEdge} · ${canonical.cornerBandSide} band</text></g>`,
    )
    index++
  }
  expect(pad.ccwRotationDegrees).toBe(37)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="490" viewBox="0 0 1040 490"><rect width="1040" height="490" fill="white"/><text x="16" y="22" font-family="sans-serif" font-size="16">One rotated pad and three probes — eight exact orthogonal views</text><g transform="translate(0,30)" font-family="sans-serif">${panels.join("")}</g></svg>`
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})

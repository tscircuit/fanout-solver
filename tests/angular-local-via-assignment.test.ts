import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  segmentsAreClear,
} from "lib/geometry"
import { matchAngularlyOrderedLocalVias } from "lib/match-angularly-ordered-local-vias"
import { matchComponentDogboneViaSites } from "lib/match-component-dogbone-via-sites"
import type {
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "lib/types"

test("repairs angular signal order while retaining every neighboring plane escape", async () => {
  const xCoordinates = [-3.575, -2.925, -2.275, -1.625, -0.975]
  const yCoordinates = [2.925, 3.575, 4.225, 4.875, 5.525, 6.175]
  const sources: Point2D[] = [
    { x: -2.925, y: 5.525 },
    { x: -2.275, y: 4.225 },
    { x: -2.275, y: 3.575 },
  ]
  for (const x of xCoordinates)
    for (const y of yCoordinates) {
      if (!sources.some((p) => p.x === x && p.y === y)) sources.push({ x, y })
    }
  const obstacles: Obstacle[] = sources.map((center, i) => ({
    type: "rect",
    shape: "circle",
    center,
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    componentId: "U1",
    obstacleId: `pad-${i}`,
    connectedTo: [`connection-${i}`],
  }))
  const connections: PreparedConnection[] = sources.map(
    (source, connectionIndex) => {
      const connection: SimpleRouteConnection = {
        name: `connection-${connectionIndex}`,
        pointsToConnect: [
          { ...source, layer: "top" },
          { x: 8, y: connectionIndex, layer: "bottom" },
        ],
      }
      return {
        connection,
        connectionIndex,
        sourcePoint: connection.pointsToConnect[0]!,
        sourcePointIndex: 0,
        sourceLayer: "top",
        sourceObstacle: obstacles[connectionIndex]!,
        targetPoint: connection.pointsToConnect[1]!,
      }
    },
  )
  const common = {
    componentId: "U1",
    componentObstacles: obstacles,
    componentBounds: { minX: -6.5, maxX: 6.5, minY: -6.5, maxY: 6.5 },
    sharedBoundary: { minX: -8, maxX: 8, minY: -8, maxY: 8 },
    xCoordinates,
    yCoordinates,
    pitchX: 0.65,
    pitchY: 0.65,
  }
  const bus: PreparedBus = {
    ...common,
    busId: "signals",
    termination: { type: "boundary" },
    direction: "right",
    exitEdge: "right",
    allowedLayers: ["bottom"],
    connections: connections.slice(0, 3),
  }
  const buses: PreparedBus[] = [
    bus,
    ...connections.slice(3).map((connection) => ({
      ...common,
      busId: `plane-${connection.connectionIndex}`,
      direction: "up" as const,
      termination: { type: "plane" as const, layer: "bottom" },
      connections: [connection],
    })),
  ]
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const invertedSites = new Map<number, Point2D>([
    [0, { x: -3.25, y: 5.2 }],
    [1, { x: -1.95, y: 4.55 }],
    [2, { x: -2.6, y: 3.9 }],
  ])
  const provisional = matchComponentDogboneViaSites(buses, {
    ...rules,
    fixedViaPointsByConnectionIndex: invertedSites,
  })
  expect(provisional).not.toBeNull()
  const angle = (p: Point2D) => Math.atan2(p.y, p.x)
  expect(angle(provisional!.get(0)!)).toBeGreaterThan(
    angle(provisional!.get(1)!),
  )
  const matched = matchAngularlyOrderedLocalVias({
    buses,
    busId: bus.busId,
    rules: { ...rules, preferredViaPointsByConnectionIndex: provisional! },
  })
  expect(matched?.size).toBe(connections.length)
  if (!matched)
    throw new Error(
      "Expected all signal and plane sources to receive legal vias",
    )
  expect(angle(matched.get(0)!)).toBeLessThan(angle(matched.get(1)!))
  expect(angle(matched.get(1)!)).toBeLessThan(angle(matched.get(2)!))
  const segments: RoutedSegment[] = connections.map((connection) => ({
    start: connection.sourcePoint,
    end: matched.get(connection.connectionIndex)!,
    width: rules.traceWidth,
    layer: "top",
  }))
  for (const [i, connection] of connections.entries()) {
    const via = matched.get(connection.connectionIndex)!
    for (const obstacle of obstacles)
      expect(distancePointToObstacle(via, obstacle)).toBeGreaterThanOrEqual(
        rules.viaDiameter / 2 + rules.clearance - 1e-8,
      )
    for (let j = i + 1; j < segments.length; j++) {
      expect(distance(via, matched.get(j)!)).toBeGreaterThanOrEqual(
        rules.viaDiameter + rules.clearance - 1e-8,
      )
      expect(
        distancePointToSegment(via, segments[j]!.start, segments[j]!.end),
      ).toBeGreaterThanOrEqual(
        rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance - 1e-8,
      )
      expect(
        segmentsAreClear(segments[i]!, segments[j]!, rules.clearance),
      ).toBe(true)
    }
  }
  // A caller's fixed reservations remain authoritative: reject the whole
  // ordered assignment rather than moving a fixed via or returning a subset.
  const fixedBefore = JSON.stringify([...invertedSites])
  expect(
    matchAngularlyOrderedLocalVias({
      buses,
      busId: bus.busId,
      rules: { ...rules, fixedViaPointsByConnectionIndex: invertedSites },
    }),
  ).toBeNull()
  expect(JSON.stringify([...invertedSites])).toBe(fixedBefore)
  const colors = ["#d9480f", "#1971c2", "#2b8a3e"]
  const graphics: GraphicsObject = {
    title: "Source via order with neighboring plane escapes",
    circles: [],
    lines: [],
    texts: [],
  }
  for (const [panel, sites] of [provisional!, matched].entries()) {
    const shift = panel * 4.8
    graphics.texts!.push({
      x: -2.275 + shift,
      y: 6.85,
      text: panel ? "Ordered signal vias" : "Provisional vias: A / B inverted",
      fontSize: 0.19,
    })
    for (const [i, source] of sources.entries()) {
      const via = sites.get(i)!,
        color = colors[i] ?? "#adb5bd"
      graphics.circles!.push(
        {
          center: { x: source.x + shift, y: source.y },
          radius: 0.15,
          fill: "#e9ecef",
          stroke: "#adb5bd",
        },
        { center: { x: via.x + shift, y: via.y }, radius: 0.12, fill: color },
      )
      graphics.lines!.push({
        points: [
          { x: source.x + shift, y: source.y },
          { x: via.x + shift, y: via.y },
        ],
        strokeWidth: rules.traceWidth,
        strokeColor: color,
      })
      if (i < 3)
        graphics.texts!.push({
          x: -3.45 + shift,
          y: 2.45 - i * 0.25,
          text: `${"ABC"[i]}: ${((angle(via) * 180) / Math.PI).toFixed(1)}°`,
          color,
          fontSize: 0.17,
          anchorSide: "center_left",
        })
    }
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

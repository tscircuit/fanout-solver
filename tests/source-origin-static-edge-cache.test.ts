import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getOutwardSourcePadOwner } from "lib/get-outward-source-pad-owner"
import type { StaticEdgeClearance } from "lib/static-edge-clearance-cache"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "lib/geometry"
import { StaticEdgeClearanceCache } from "lib/static-edge-clearance-cache"
import type { Point2D, RoutedSegment } from "lib/types"

// Reference classification keeps the old per-blocker geometry and exercises
// the shared production source-pad exception before caching owner results.
type Obstacle = SimpleRouteJson["obstacles"][number]
type StaticCopperBlocker =
  | { kind: "segment"; connectionName: string; segment: RoutedSegment }
  | {
      kind: "via"
      connectionName: string
      center: Point2D
      diameter: number
      layers: readonly string[]
    }
  | { kind: "obstacle"; obstacle: Obstacle }

interface EdgeRules {
  start: Point2D
  end: Point2D
  layer: string
  traceWidth: number
  clearance: number
}

function staticCopperBlockerIsClear(
  { start, end, layer, traceWidth, clearance }: EdgeRules,
  blocker: StaticCopperBlocker,
): boolean {
  if (blocker.kind === "obstacle")
    return (
      !blocker.obstacle.layers.includes(layer) ||
      distanceSegmentToObstacle(
        { start, end, width: traceWidth, layer },
        blocker.obstacle,
      ) >=
        traceWidth / 2 + clearance - 1e-9
    )
  if (blocker.kind === "via")
    return (
      !blocker.layers.includes(layer) ||
      distancePointToSegment(blocker.center, start, end) >=
        (traceWidth + blocker.diameter) / 2 + clearance - 1e-9
    )
  return (
    blocker.segment.layer !== layer ||
    distanceSegmentToSegment(
      start,
      end,
      blocker.segment.start,
      blocker.segment.end,
    ) >=
      (traceWidth + blocker.segment.width) / 2 + clearance - 1e-9
  )
}

/** Classify one directed grid edge without assuming the active connection. */
function classifyStaticCopperEdge(
  params: EdgeRules & {
    blockers: Iterable<StaticCopperBlocker>
    /** Only pads whose first vias are currently being chosen may be escaped. */
    sourceObstacleOwners?: ReadonlyMap<
      Obstacle,
      { connectionName: string; sourcePoint: Point2D }
    >
  },
): StaticEdgeClearance {
  const { start, end, layer, traceWidth, clearance } = params
  let soleOwner: string | undefined
  for (const blocker of params.blockers) {
    if (staticCopperBlockerIsClear(params, blocker)) continue
    let owner: string | undefined
    if (blocker.kind === "obstacle") {
      owner = getOutwardSourcePadOwner(
        start,
        end,
        layer,
        traceWidth,
        clearance,
        blocker.obstacle,
        params.sourceObstacleOwners?.get(blocker.obstacle),
      )
    } else owner = blocker.connectionName
    if (owner === undefined || (soleOwner !== undefined && soleOwner !== owner))
      return false
    soleOwner = owner
  }
  return soleOwner ?? true
}

test("directed TOP cache preserves outward pad ownership and exact terminal clearance", async () => {
  const traceWidth = 0.08128,
    clearance = 0.08128
  const pad = (x: number): SimpleRouteJson["obstacles"][number] =>
    ({
      type: "rect",
      shape: "circle",
      center: { x, y: 0 },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: [],
    }) as SimpleRouteJson["obstacles"][number]
  const first = pad(0),
    second = pad(0.65)
  const owners = new Map([
    [first, { connectionName: "A", sourcePoint: first.center }],
    [second, { connectionName: "B", sourcePoint: second.center }],
  ])
  const copper: StaticCopperBlocker = {
    kind: "segment",
    connectionName: "A",
    segment: {
      start: { x: 0.05, y: 0.1 },
      end: { x: 0.4, y: 0.1 },
      width: traceWidth,
      layer: "top",
    },
  }
  const blockers: StaticCopperBlocker[] = [
    { kind: "obstacle", obstacle: first },
    { kind: "obstacle", obstacle: second },
    copper,
    {
      kind: "via",
      connectionName: "B",
      center: { x: 0.975, y: 0.325 },
      diameter: 0.24,
      layers: ["top", "bottom"],
    },
  ]
  // This is the original uncached per-connection physical predicate. Each
  // cached classification must agree for every possible active owner.
  const legacyClear = (
    start: Point2D,
    end: Point2D,
    layer: string,
    name: string,
    obstacles = blockers,
  ) =>
    obstacles.every((blocker) => {
      if (blocker.kind !== "obstacle" && blocker.connectionName === name)
        return true
      if (blocker.kind === "obstacle") {
        const source = owners.get(blocker.obstacle)
        if (
          layer === "top" &&
          source?.connectionName === name &&
          distanceSegmentToObstacle(
            { start, end: start, width: traceWidth, layer },
            blocker.obstacle,
          ) <
            traceWidth / 2 + clearance - 1e-9 &&
          distance(end, source.sourcePoint) >=
            distance(start, source.sourcePoint) - 1e-9
        )
          return true
        return (
          !blocker.obstacle.layers.includes(layer) ||
          distanceSegmentToObstacle(
            { start, end, width: traceWidth, layer },
            blocker.obstacle,
          ) >=
            traceWidth / 2 + clearance - 1e-9
        )
      }
      if (blocker.kind === "via")
        return (
          !blocker.layers.includes(layer) ||
          distancePointToSegment(blocker.center, start, end) >=
            (traceWidth + blocker.diameter) / 2 + clearance - 1e-9
        )
      return (
        blocker.segment.layer !== layer ||
        distanceSegmentToSegment(
          start,
          end,
          blocker.segment.start,
          blocker.segment.end,
        ) >=
          (traceWidth + blocker.segment.width) / 2 + clearance - 1e-9
      )
    })
  const classify = (
    start: Point2D,
    end: Point2D,
    layer = "top",
    obstacles = blockers,
  ) =>
    classifyStaticCopperEdge({
      start,
      end,
      layer,
      traceWidth,
      clearance,
      blockers: obstacles,
      sourceObstacleOwners: owners,
    })
  const points = Array.from({ length: 18 * 10 }, (_, index) => ({
    x: ((index % 18) - 4) * traceWidth,
    y: (Math.floor(index / 18) - 4) * traceWidth,
  }))
  const cache = new StaticEdgeClearanceCache(points.length, 2)
  for (const [z, layer] of ["top", "bottom"].entries())
    for (const [index, start] of points.entries())
      for (const delta of [1, -1, 18, -18, 19, -19, 17, -17]) {
        const target = index + delta,
          end = points[target]
        if (!end || distance(start, end) > traceWidth * 1.5) continue
        const origin = z * points.length + index
        const result = classify(start, end, layer)
        cache.set(origin, target, result)
        for (const name of ["A", "B", "foreign"])
          expect(
            cache.get(origin, target) === true ||
              cache.get(origin, target) === name,
          ).toBe(legacyClear(start, end, layer, name))
      }
  const start = { x: 0, y: 0 },
    end = { x: traceWidth, y: traceWidth }
  expect(classify(start, end)).toBe("A")
  expect(classify(end, start)).toBe(false)
  expect(classify(start, end) === "B").toBe(false)
  const conflict = { ...copper, connectionName: "B" } as StaticCopperBlocker
  expect(classify(start, end, "top", [...blockers, conflict])).toBe(false)
  const foreignPad = pad(0.04)
  owners.set(foreignPad, {
    connectionName: "B",
    sourcePoint: foreignPad.center,
  })
  expect(
    classify(start, end, "top", [
      ...blockers,
      { kind: "obstacle", obstacle: foreignPad },
    ]),
  ).toBe(false)
  // Equal-looking pad data cannot inherit another object's source exemption.
  expect(
    classify(start, end, "top", [{ kind: "obstacle", obstacle: { ...first } }]),
  ).toBe(false)
  const origin = 11,
    target = 12
  cache.set(origin, target, "A")
  expect(cache.get(target, origin)).not.toBe("A")
  expect(cache.get(origin, target, true)).toBeUndefined()
  cache.set(origin, target, false, true)
  expect(cache.get(origin, target)).toBe("A")
  // A source/exit connector within the same cells can have different actual
  // coordinates; such a connector must bypass the otherwise valid grid hit.
  expect(legacyClear({ x: 0.2, y: 0 }, start, "top", "A")).toBe(false)
  expect(cache.get(origin, target, true)).toBeUndefined()

  const panels = [
    {
      title: "Outward: owner A",
      a: start,
      b: end,
      valid: true,
      foreign: false,
    },
    {
      title: "Inward: blocked",
      a: end,
      b: start,
      valid: false,
      foreign: false,
    },
    {
      title: "Foreign pad: blocked",
      a: start,
      b: end,
      valid: false,
      foreign: true,
    },
    {
      title: "Foreign copper: blocked",
      a: start,
      b: end,
      valid: false,
      foreign: false,
    },
  ]
  const panelsSvg = panels
    .map((p, i) => {
      const ox = 45 + (i % 2) * 280,
        oy = 90 + Math.floor(i / 2) * 240,
        scale = 420
      const x = (v: number) => ox + 72 + v * scale,
        y = (v: number) => oy + 75 - v * scale
      return `<g><text x="${ox}" y="${oy - 60}" font-family="sans-serif" font-size="15">${p.title}</text><circle cx="${x(0)}" cy="${y(0)}" r="${0.15 * scale}" fill="#ffc9a2" stroke="#c35a13"/><circle cx="${x(0)}" cy="${y(0)}" r="${(0.15 + traceWidth / 2 + clearance) * scale}" fill="none" stroke="#bbb" stroke-dasharray="3 4"/>${p.foreign ? `<circle cx="${x(0.04)}" cy="${y(0)}" r="${0.15 * scale}" fill="#aad3ff" opacity="0.65" stroke="#2364a0"/>` : ""}${i === 3 ? `<line x1="${x(0.05)}" y1="${y(0.1)}" x2="${x(0.4)}" y2="${y(0.1)}" stroke="#2364a0" stroke-width="${traceWidth * scale}"/>` : ""}<line x1="${x(p.a.x)}" y1="${y(p.a.y)}" x2="${x(p.b.x)}" y2="${y(p.b.y)}" stroke="${p.valid ? "#169547" : "#cf2835"}" stroke-width="${traceWidth * scale}"/><circle cx="${x(p.b.x)}" cy="${y(p.b.y)}" r="4" fill="black"/></g>`
    })
    .join("")
  await expect(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="550" viewBox="0 0 600 550"><rect width="600" height="550" fill="white"/>${panelsSvg}<text x="30" y="537" font-family="sans-serif" font-size="12">Dot = edge destination; dashed circle = required centerline clearance</text></svg>`,
  ).toMatchSvgSnapshot(import.meta.path)
})

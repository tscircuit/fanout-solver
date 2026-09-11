import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import {
  getAllRoutedTraceCopper,
  getRoutedTraceCopper,
} from "./get-routed-trace-copper"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import {
  normalizeLayeredPath,
  type LayeredPathPoint,
} from "./normalize-layered-path"
import { fanoutPlansAreClear } from "./route-bus"
import { RouteSegmentSpatialIndex } from "./route-segment-spatial-index"
import { sourceOriginRouteIsSelfClear } from "./source-origin-route-self-clear"
import type {
  Bounds,
  FanoutRoutePlan,
  FanoutRoutePoint,
  PreparedBus,
} from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"
import { getViaHoleToHoleClearance } from "./via-clearance"

export interface ShortcutFanoutPlansParams {
  inputSrj: SimpleRouteJson
  /** Complete copper, including other buses and any reserved source prefixes. */
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  layerNames: readonly string[]
  traceWidth: number
  clearance: number
  selectedBusIds?: ReadonlySet<string>
  selectedConnectionIndices?: ReadonlySet<number>
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  /** Shorten pad-clear source copper too, retaining its pad lead and first via. */
  allowSourcePrefixShortcuts?: boolean
}

const EPSILON = 1e-7
const MAXIMUM_VERTICES = 180

type Wire = Extract<FanoutRoutePoint, { route_type: "wire" }>

function connectorVariants(
  a: LayeredPathPoint,
  b: LayeredPathPoint,
): LayeredPathPoint[][] {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    diagonal = Math.min(Math.abs(dx), Math.abs(dy))
  if (
    Math.abs(dx) < EPSILON ||
    Math.abs(dy) < EPSILON ||
    Math.abs(Math.abs(dx) - Math.abs(dy)) < EPSILON
  )
    return [[a, b]]
  return [
    [
      a,
      {
        x: a.x + Math.sign(dx) * diagonal,
        y: a.y + Math.sign(dy) * diagonal,
        z: a.z,
      },
      b,
    ],
    [
      a,
      {
        x: b.x - Math.sign(dx) * diagonal,
        y: b.y - Math.sign(dy) * diagonal,
        z: a.z,
      },
      b,
    ],
    [a, { x: a.x, y: b.y, z: a.z }, b],
    [a, { x: b.x, y: a.y, z: a.z }, b],
  ]
}

function shortcutSection(
  points: LayeredPathPoint[],
  width: number,
  clear: (a: LayeredPathPoint, b: LayeredPathPoint) => boolean,
): LayeredPathPoint[] {
  if (points.length < 3) return points
  const n = points.length
  const indices =
    n <= MAXIMUM_VERTICES
      ? points.map((_, i) => i)
      : [
          ...new Set([
            0,
            ...Array.from({ length: MAXIMUM_VERTICES - 2 }, (_, i) =>
              Math.round(((i + 1) * (n - 1)) / (MAXIMUM_VERTICES - 1)),
            ),
            n - 1,
          ]),
        ]
  const cost = new Float64Array(n).fill(Infinity),
    edges: Array<{ previous: number; points: LayeredPathPoint[] } | undefined> =
      new Array(n)
  cost[0] = 0
  for (let k = 1; k < indices.length; k++) {
    const j = indices[k]!
    for (let h = 0; h < k; h++) {
      const i = indices[h]!,
        a = points[i]!,
        b = points[j]!,
        dx = Math.abs(b.x - a.x),
        dy = Math.abs(b.y - a.y)
      const lowerBound = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
      if (cost[i]! + lowerBound >= cost[j]! - EPSILON) continue
      for (const path of connectorVariants(a, b)) {
        const length = path
          .slice(1)
          .reduce((sum, p, index) => sum + distance(path[index]!, p), 0)
        if (
          cost[i]! + length >= cost[j]! - EPSILON ||
          !path.slice(1).every((p, index) => clear(path[index]!, p))
        )
          continue
        cost[j] = cost[i]! + length
        edges[j] = { previous: i, points: path }
      }
    }
    // Keep the exact original subpath available when no shortcut is clear.
    if (!edges[j]) {
      const previous = indices[k - 1]!,
        path = points.slice(previous, j + 1)
      cost[j] =
        cost[previous]! +
        path
          .slice(1)
          .reduce((sum, p, index) => sum + distance(path[index]!, p), 0)
      edges[j] = { previous, points: path }
    }
  }
  const paths: LayeredPathPoint[][] = []
  for (let j = n - 1; j > 0; ) {
    const edge = edges[j]
    if (!edge)
      throw new Error("FanoutSolver: shortcut graph lost a retained path")
    paths.unshift(edge.points)
    j = edge.previous
  }
  const selected = paths.flatMap((path, i) => (i ? path.slice(1) : path))
  return (
    normalizeLayeredPath({
      points: selected,
      chamfer: width / 4,
      segmentIsClear: clear,
    }) ?? points
  )
}

function inside(
  point: LayeredPathPoint,
  bounds: Bounds,
  endpoint: FanoutRoutePlan["exitPoint"],
): boolean {
  if (
    point.x < bounds.minX - EPSILON ||
    point.x > bounds.maxX + EPSILON ||
    point.y < bounds.minY - EPSILON ||
    point.y > bounds.maxY + EPSILON
  )
    return false
  const onBoundary =
    Math.abs(point.x - bounds.minX) < EPSILON ||
    Math.abs(point.x - bounds.maxX) < EPSILON ||
    Math.abs(point.y - bounds.minY) < EPSILON ||
    Math.abs(point.y - bounds.maxY) < EPSILON
  return !onBoundary || distance(point, endpoint) < EPSILON
}

/**
 * Bounded same-layer shortcuts for lanes exceeding their original bus minimum
 * plus allowed skew. Every physical via, layer transition and boundary endpoint
 * stays fixed; source prefixes stay fixed unless explicitly enabled. No bus
 * minimum is lowered; remaining skew is
 * handled by the caller's length matcher. Null means complete copper validation
 * failed, so the caller must retain its original plans.
 */
export function shortcutFanoutPlans(
  params: ShortcutFanoutPlansParams,
): FanoutRoutePlan[] | null {
  const {
    inputSrj,
    preparedBuses,
    layerNames,
    clearance,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
  } = params
  const buses = new Map(preparedBuses.map((bus) => [bus.busId, bus]))
  const originalMinimum = new Map(
    preparedBuses.map((bus) => [
      bus.busId,
      Math.min(
        ...params.plans
          .filter((p) => p.busId === bus.busId)
          .map((p) => p.length),
      ),
    ]),
  )
  const supplied = getAllRoutedTraceCopper(inputSrj, allowBlindAndBuriedVias)
  let plans = [...params.plans]
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (const original of plans.toSorted((a, b) => b.length - a.length)) {
      const bus = buses.get(original.busId),
        minimum = originalMinimum.get(original.busId)
      if (
        !bus ||
        minimum === undefined ||
        !Number.isFinite(minimum) ||
        bus.maxLengthSkew === undefined ||
        original.termination.type !== "boundary" ||
        original.length <= minimum + bus.maxLengthSkew + EPSILON
      )
        continue
      if (params.selectedBusIds && !params.selectedBusIds.has(original.busId))
        continue
      if (
        params.selectedConnectionIndices &&
        !params.selectedConnectionIndices.has(original.connectionIndex)
      )
        continue
      // The preserved first via is an exact separator for the pad-side prefix.
      // Via-free paths have no such separator and are intentionally unchanged.
      const firstVia = original.trace.route.findIndex(
        (p) => p.route_type === "via",
      )
      if (firstVia < 0) continue
      const sharesNet = (name: string) =>
        name === original.connectionName ||
        (allowSameNetMerges &&
          connectionsShareElectricalNet(
            inputSrj,
            name,
            original.connectionName,
          ))
      const other = plans.filter(
        (p) =>
          p.connectionIndex !== original.connectionIndex &&
          !sharesNet(p.connectionName),
      )
      const otherSupplied = supplied.filter((p) => !sharesNet(p.connectionName))
      const index = new RouteSegmentSpatialIndex([
        ...other.flatMap((p) => [
          ...p.segments,
          ...(p.planeEndpointSegments ?? []),
        ]),
        ...otherSupplied.flatMap((p) => p.segments),
      ])
      const vias = [
        ...other.flatMap((p) =>
          [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia].filter(
            (v) => !!v,
          ),
        ),
        ...otherSupplied.flatMap((p) => p.vias),
      ]
      const obstacles = inputSrj.obstacles.filter(
        (o) =>
          !(
            allowSameNetMerges &&
            obstacleSharesElectricalNet(inputSrj, o, original.connectionName)
          ),
      )
      let prefixStart = firstVia + 1
      if (params.allowSourcePrefixShortcuts) {
        prefixStart = 1
        while (prefixStart < firstVia) {
          const point = original.trace.route[prefixStart]!
          if (
            point.route_type === "wire" &&
            distancePointToObstacle(point, original.sourceObstacle) >=
              point.width / 2 + clearance - 1e-9
          )
            break
          prefixStart++
        }
      }
      const route = original.trace.route.slice(0, prefixStart)
      let sectionStart = prefixStart
      while (sectionStart < original.trace.route.length) {
        const first = original.trace.route[sectionStart]!
        if (first.route_type !== "wire") {
          route.push(first)
          sectionStart++
          continue
        }
        let end = sectionStart + 1
        while (end < original.trace.route.length) {
          const p = original.trace.route[end]!
          if (p.route_type !== "wire" || p.layer !== first.layer) break
          end++
        }
        const wires = original.trace.route.slice(sectionStart, end) as Wire[],
          z = layerNames.indexOf(first.layer)
        if (z < 0)
          throw new Error(
            `FanoutSolver: shortcut uses unknown layer ${first.layer}`,
          )
        const points = wires.map((p) => ({ x: p.x, y: p.y, z })),
          width = Math.max(...wires.map((p) => p.width))
        const incoming = route.at(-1)
        const clear = (a: LayeredPathPoint, b: LayeredPathPoint) => {
          const segment = { start: a, end: b, layer: first.layer, width }
          return (
            inside(a, bus.sharedBoundary, original.exitPoint) &&
            inside(b, bus.sharedBoundary, original.exitPoint) &&
            obstacles.every(
              (o) =>
                !o.layers.includes(first.layer) ||
                // Normalizing the join may trim the retained incident lead.
                // Only that exact old segment can still touch the source pad.
                (sectionStart < firstVia &&
                  o === original.sourceObstacle &&
                  incoming?.route_type === "wire" &&
                  distancePointToSegment(a, incoming, points[0]!) < EPSILON &&
                  distancePointToSegment(b, incoming, points[0]!) < EPSILON) ||
                distanceSegmentToObstacle(segment, o) >=
                  width / 2 + clearance - 1e-9,
            ) &&
            index
              .querySegment(segment, clearance)
              .every((s) => segmentsAreClear(segment, s, clearance)) &&
            vias.every(
              (v) =>
                !v.spanLayers.includes(first.layer) ||
                distancePointToSegment(v.center, a, b) >=
                  (width + v.diameter) / 2 + clearance - 1e-9,
            )
          )
        }
        let shortened = shortcutSection(points, width, clear)
        let retainedFirstWire: Wire | undefined
        if (
          sectionStart < firstVia &&
          incoming?.route_type === "wire" &&
          incoming.layer === first.layer
        ) {
          // Include the preceding direction, so a shortcut cannot introduce
          // an unchecked orthogonal or acute corner at the preserved lead.
          const joined = normalizeLayeredPath({
            points: [{ x: incoming.x, y: incoming.y, z }, ...shortened],
            chamfer: width / 4,
            segmentIsClear: clear,
          })
          if (joined) {
            route.pop()
            retainedFirstWire = incoming
            shortened = joined
          } else shortened = points
        }
        route.push(
          ...shortened.map((p, index) => ({
            ...(index === 0 ? retainedFirstWire : undefined),
            route_type: "wire" as const,
            x: p.x,
            y: p.y,
            layer: first.layer,
            width,
          })),
        )
        sectionStart = end
      }
      const trace = { ...original.trace, route },
        segments = getRoutedTraceCopper(
          inputSrj,
          trace,
          allowBlindAndBuriedVias,
        ).segments
      const candidate = {
        ...original,
        trace,
        segments,
        ...(params.allowSourcePrefixShortcuts
          ? {
              sourceEscapeSegmentCount: segments.findIndex(
                (segment) => segment.layer !== original.sourceLayer,
              ),
            }
          : {}),
        length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
      }
      if (
        candidate.length < minimum - EPSILON ||
        candidate.length >= original.length - EPSILON
      )
        continue
      if (
        params.allowSourcePrefixShortcuts &&
        !sourceOriginRouteIsSelfClear({
          points: trace.route.flatMap((point) =>
            point.route_type === "wire"
              ? [{ x: point.x, y: point.y, z: layerNames.indexOf(point.layer) }]
              : [],
          ),
          topZ: layerNames.indexOf(original.sourceLayer),
          traceWidth: params.traceWidth,
          viaDiameter: original.via!.diameter,
          viaHoleDiameter: original.via!.holeDiameter,
          clearance,
          holeToHoleClearance: getViaHoleToHoleClearance(inputSrj),
        })
      )
        continue
      if (
        !fanoutPlansAreClear({
          plans: [candidate],
          srj: {
            ...inputSrj,
            traces: [
              ...(inputSrj.traces ?? []),
              ...other.flatMap((p) => [
                p.trace,
                ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
              ]),
            ],
          },
          sharedBoundary: bus.sharedBoundary,
          clearance,
          allowBlindAndBuriedVias,
          allowSameNetMerges,
        })
      )
        continue
      plans = plans.map((p) => (p === original ? candidate : p))
      changed = true
    }
    if (!changed) break
  }
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...plans.flatMap((p) => [
          p.trace,
          ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance,
    allowBlindAndBuriedVias,
  })
  return validation.valid ? plans : null
}

import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  routeSplitPerimeterBusSteps,
  type SplitBusParams,
} from "./route-split-perimeter-bus"
import type { SplitPerimeterSources } from "./route-split-perimeter-source-escapes"
import type { RouteViaMinimalWindingProgress } from "./route-via-minimal-winding"
import type { FanoutRoutePlan, PreparedBus } from "./types"

const EPSILON = 1e-7
export type ShallowSplitBusParams = SplitBusParams & {
  buses: readonly PreparedBus[]
}
export type ShallowSplitBusResult = SplitPerimeterSources & {
  plans: FanoutRoutePlan[]
}

function sourcesAreClear(
  params: ShallowSplitBusParams,
  sources: readonly PeripheralSourceEscape[],
): boolean {
  const connections = new Map(
    params.buses
      .flatMap((bus) => bus.connections)
      .map((connection) => [connection.connectionIndex, connection]),
  )
  const boundary = params.bus.sharedBoundary
  for (const source of sources) {
    const own = connections.get(source.connectionIndex)!
    const radius = source.via.diameter / 2
    for (const obstacle of params.srj.obstacles) {
      if (
        obstacle.layers.some((layer) =>
          source.via.spanLayers.includes(layer),
        ) &&
        distancePointToObstacle(source.via.center, obstacle) <
          radius + params.clearance - EPSILON
      )
        return false
      if (
        obstacle !== own.sourceObstacle &&
        source.segments.some(
          (segment) =>
            obstacle.layers.includes(segment.layer) &&
            distanceSegmentToObstacle(segment, obstacle) <
              segment.width / 2 + params.clearance - EPSILON,
        )
      )
        return false
    }
    for (const segment of source.segments) {
      if (
        [segment.start, segment.end].some(
          (point) =>
            point.x < boundary.minX - EPSILON ||
            point.x > boundary.maxX + EPSILON ||
            point.y < boundary.minY - EPSILON ||
            point.y > boundary.maxY + EPSILON,
        )
      )
        return false
    }
    for (const other of sources) {
      if (source.connectionIndex === other.connectionIndex) continue
      if (
        distance(source.via.center, other.via.center) <
        radius + other.via.diameter / 2 + params.clearance - EPSILON
      )
        return false
      if (
        source.segments.some(
          (segment) =>
            other.via.spanLayers.includes(segment.layer) &&
            distancePointToSegment(
              other.via.center,
              segment.start,
              segment.end,
            ) <
              other.via.diameter / 2 +
                segment.width / 2 +
                params.clearance -
                EPSILON,
        )
      )
        return false
      if (
        source.segments.some((segment) =>
          other.segments.some(
            (otherSegment) =>
              !segmentsAreClear(segment, otherSegment, params.clearance),
          ),
        )
      )
        return false
    }
  }
  return true
}

/** Shorten the lower perimeter while preserving its source-layer escape topology. */
export function* routeShallowSplitPerimeterBusSteps(
  params: ShallowSplitBusParams,
): Generator<
  RouteViaMinimalWindingProgress,
  ShallowSplitBusResult | null,
  void
> {
  const { bus, traceWidth, clearance, viaDiameter } = params
  if (
    bus.exitEdge !== "left" ||
    bus.termination.type !== "boundary" ||
    params.bottomRemoteConnectionIndices.size !== 1
  )
    return null
  const bottomIndex = [...params.bottomRemoteConnectionIndices][0]!
  const originalBottom = params.sourceEscapes.find(
    (source) => source.connectionIndex === bottomIndex,
  )
  const last = originalBottom?.segments.at(-1)
  if (
    !last ||
    Math.abs(last.start.x - last.end.x) > EPSILON ||
    last.start.y <= last.end.y
  )
    return null
  const padPitch = Math.min(bus.pitchX, bus.pitchY)
  if (!Number.isFinite(padPitch) || padPitch <= 0) return null
  const pitch = traceWidth + clearance
  const nativeRows = bus.yCoordinates
    .slice(1)
    .map((y, index) => (y + bus.yCoordinates[index]!) / 2)
    .filter((y) => y > last.end.y + EPSILON && y < last.start.y - EPSILON)
    .sort((a, b) => a - b)
    .slice(0, 4)
  const fixedIndices = new Set(
    bus.connections.map((connection) => connection.connectionIndex),
  )
  const movableBuses = params.buses
    .map((owner) => ({
      ...owner,
      connections: owner.connections.filter(
        (connection) => !fixedIndices.has(connection.connectionIndex),
      ),
    }))
    .filter((owner) => owner.connections.length)
  const pendingIndices = new Set(
    movableBuses
      .flatMap((owner) => owner.connections)
      .map((connection) => connection.connectionIndex),
  )
  for (const y of nativeRows) {
    yield {
      phase: "route-connection",
      routeOrderAttempt: 0,
      connectionIndex: 0,
      connectionCount: bus.connections.length,
      connectionName: originalBottom!.connectionName,
      searchBatch: 0,
      expandedStateCount: 0,
      connectionComplete: false,
    }
    const sources = params.sourceEscapes.map((source) => ({
      ...source,
      segments: source.segments.map((segment) => ({
        ...segment,
        start: { ...segment.start },
        end: { ...segment.end },
      })),
      via: { ...source.via, center: { ...source.via.center } },
    }))
    const viaPoints = new Map(params.viaPointsByConnectionIndex)
    const bottom = sources.find(
      (source) => source.connectionIndex === bottomIndex,
    )!
    bottom.via.center = { x: last.end.x, y }
    bottom.segments.at(-1)!.end = bottom.via.center
    viaPoints.set(bottomIndex, bottom.via.center)
    const fixed = sources.filter((source) =>
      fixedIndices.has(source.connectionIndex),
    )
    const rematch = (plans: FanoutRoutePlan[] = []) => {
      const matched = matchComponentDogboneViaSites(movableBuses, {
        ...params,
        additionalObstacles: params.srj.obstacles,
        maximumSearchStates: 300_000,
        preferredViaPointsByConnectionIndex: viaPoints,
        blockingSegments: [
          ...fixed.flatMap((source) =>
            source.segments.map((segment) => ({
              connectionIndex: source.connectionIndex,
              segment,
            })),
          ),
          ...plans.flatMap((plan) =>
            plan.segments
              .filter((segment) => segment.layer === params.targetLayer)
              .map((segment) => ({
                connectionIndex: plan.connectionIndex,
                segment,
              })),
          ),
        ],
        blockingVias: fixed.map((source) => ({
          connectionIndex: source.connectionIndex,
          ...source.via,
        })),
      })
      if (!matched) return false
      for (const source of sources)
        if (pendingIndices.has(source.connectionIndex)) {
          const end = matched.get(source.connectionIndex)!
          source.via = { ...source.via, center: end }
          source.segments = [{ ...source.segments[0]!, end }]
          viaPoints.set(source.connectionIndex, end)
        }
      return sourcesAreClear(params, sources)
    }
    if (!rematch()) continue
    // Center the middle lower rail on the preceding native interstitial row.
    const sourceBoundary = {
      ...params.sourceBoundary,
      minY:
        y -
        padPitch +
        viaDiameter / 2 +
        traceWidth / 2 +
        clearance +
        1e-5 +
        pitch,
    }
    const plans = yield* routeSplitPerimeterBusSteps({
      ...params,
      sourceEscapes: sources,
      sourceBoundary,
      viaPointsByConnectionIndex: viaPoints,
      rematchPendingSources: {
        connectionIndices: pendingIndices,
        afterLowerStage: rematch,
      },
    })
    if (plans && sourcesAreClear(params, sources))
      return {
        plans,
        sourceEscapes: sources,
        sourceBoundary,
        viaPointsByConnectionIndex: viaPoints,
        remoteConnectionIndices: new Set(params.remoteConnectionIndices),
        bottomRemoteConnectionIndices: new Set(
          params.bottomRemoteConnectionIndices,
        ),
        lowerConnectionIndices: [...params.lowerConnectionIndices],
      }
  }
  return null
}

import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "./geometry"
import type {
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"

interface PushShoveParams {
  srj: SimpleRouteJson
  buses: PreparedBus[]
  traceWidth: number
  clearance: number
  breakoutMargin: number
}

interface RoutingItem {
  bus: PreparedBus
  connection: PreparedConnection
  direction: FanoutDirection
  source: Point2D
}

interface RoutedPath {
  item: RoutingItem
  points: Point2D[]
  segments: RoutedSegment[]
}

interface ActiveRoute {
  item: RoutingItem
  points: Point2D[]
  track: number
}

function isHorizontal(direction: FanoutDirection): boolean {
  return direction === "left" || direction === "right"
}

function directionSign(direction: FanoutDirection): number {
  return direction === "right" || direction === "up" ? 1 : -1
}

function getAxis(point: Point2D, direction: FanoutDirection): number {
  return isHorizontal(direction) ? point.x : point.y
}

function getPerpendicularAxis(
  point: Point2D,
  direction: FanoutDirection,
): number {
  return isHorizontal(direction) ? point.y : point.x
}

function makePoint(
  axis: number,
  perpendicularAxis: number,
  direction: FanoutDirection,
): Point2D {
  return isHorizontal(direction)
    ? { x: axis, y: perpendicularAxis }
    : { x: perpendicularAxis, y: axis }
}

function getExitAxis(bus: PreparedBus, breakoutMargin: number): number {
  switch (bus.direction) {
    case "right":
      return bus.sharedBoundary.maxX + breakoutMargin
    case "left":
      return bus.sharedBoundary.minX - breakoutMargin
    case "up":
      return bus.sharedBoundary.maxY + breakoutMargin
    case "down":
      return bus.sharedBoundary.minY - breakoutMargin
  }
}

function compressPath(points: Point2D[]): Point2D[] {
  if (points.length < 3) return points
  const compressed = [points[0]!]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = compressed.at(-1)!
    const current = points[index]!
    const next = points[index + 1]!
    const incoming = {
      x: Math.sign(current.x - previous.x),
      y: Math.sign(current.y - previous.y),
    }
    const outgoing = {
      x: Math.sign(next.x - current.x),
      y: Math.sign(next.y - current.y),
    }
    if (incoming.x !== outgoing.x || incoming.y !== outgoing.y) {
      compressed.push(current)
    }
  }
  compressed.push(points.at(-1)!)
  return compressed
}

function getPathSegments(
  points: Point2D[],
  traceWidth: number,
): RoutedSegment[] {
  const segments: RoutedSegment[] = []
  for (let index = 1; index < points.length; index++) {
    if (distance(points[index - 1]!, points[index]!) < 1e-9) continue
    segments.push({
      start: points[index - 1]!,
      end: points[index]!,
      width: traceWidth,
      layer: "top",
    })
  }
  return segments
}

/**
 * Finds an ordered subset of candidate tracks with minimum total displacement.
 * Preserving the order is the "shove" invariant: existing routes can move, but
 * they cannot cross when a new pad row joins the channel.
 */
function selectOrderedTracks(params: {
  requestedTracks: number[]
  candidateTracks: number[]
  maximumShift: number
}): number[] | null {
  const { requestedTracks, candidateTracks, maximumShift } = params
  const rowCount = requestedTracks.length + 1
  const columnCount = candidateTracks.length + 1
  const costs = Array.from({ length: rowCount }, () =>
    new Float64Array(columnCount).fill(Number.POSITIVE_INFINITY),
  )
  const tookCandidate = Array.from(
    { length: rowCount },
    () => new Uint8Array(columnCount),
  )
  costs[0]!.fill(0)

  for (let row = 1; row < rowCount; row++) {
    for (let column = 1; column < columnCount; column++) {
      const skippedCost = costs[row]![column - 1]!
      const shift = Math.abs(
        requestedTracks[row - 1]! - candidateTracks[column - 1]!,
      )
      const selectedCost =
        shift > maximumShift + 1e-9
          ? Number.POSITIVE_INFINITY
          : costs[row - 1]![column - 1]! + shift
      if (selectedCost < skippedCost) {
        costs[row]![column] = selectedCost
        tookCandidate[row]![column] = 1
      } else {
        costs[row]![column] = skippedCost
      }
    }
  }

  if (!Number.isFinite(costs.at(-1)!.at(-1)!)) return null
  const selectedTracks: number[] = []
  let row = requestedTracks.length
  let column = candidateTracks.length
  while (row > 0 && column > 0) {
    if (tookCandidate[row]![column]) {
      selectedTracks.push(candidateTracks[column - 1]!)
      row--
    }
    column--
  }
  if (row > 0) return null
  return selectedTracks.reverse()
}

function getCandidateTracks(params: {
  direction: FanoutDirection
  activeRoutes: ActiveRoute[]
  obstacles: Obstacle[]
  boundaryMinimum: number
  boundaryMaximum: number
  traceWidth: number
  clearance: number
  maximumShift: number
}): number[] | null {
  const {
    direction,
    activeRoutes,
    obstacles,
    boundaryMinimum,
    boundaryMaximum,
    traceWidth,
    clearance,
    maximumShift,
  } = params
  const lanePitch = traceWidth + clearance
  const requiredObstacleDistance = traceWidth / 2 + clearance
  let selectedTracks: number[] | null = null
  let selectedCost = Number.POSITIVE_INFINITY

  for (const phase of Array.from(
    { length: Math.round(lanePitch / traceWidth) },
    (_, index) => index * traceWidth,
  )) {
    const candidates: number[] = []
    const firstTrack =
      Math.ceil((boundaryMinimum - phase) / lanePitch) * lanePitch + phase
    for (
      let track = firstTrack;
      track <= boundaryMaximum + 1e-9;
      track += lanePitch
    ) {
      const roundedTrack = Math.round(track / traceWidth) * traceWidth
      if (
        obstacles.every((obstacle) => {
          const obstacleTrack = getPerpendicularAxis(obstacle.center, direction)
          const obstacleSize = isHorizontal(direction)
            ? obstacle.height
            : obstacle.width
          return (
            Math.abs(roundedTrack - obstacleTrack) >=
            obstacleSize / 2 + requiredObstacleDistance - 1e-9
          )
        })
      ) {
        candidates.push(roundedTrack)
      }
    }

    const tracks = selectOrderedTracks({
      requestedTracks: activeRoutes.map((route) => route.track),
      candidateTracks: candidates,
      maximumShift,
    })
    if (!tracks) continue
    const cost = tracks.reduce(
      (sum, track, index) => sum + Math.abs(track - activeRoutes[index]!.track),
      0,
    )
    if (cost < selectedCost) {
      selectedCost = cost
      selectedTracks = tracks
    }
  }
  return selectedTracks
}

function buildPlan(path: RoutedPath): FanoutRoutePlan {
  const { item, points, segments } = path
  const route: SimplifiedPcbTrace["route"] = points.map((point, index) => ({
    route_type: "wire",
    x: point.x,
    y: point.y,
    width: segments[0]?.width ?? 0.1,
    layer: "top",
    ...(index === 0 && item.connection.sourcePoint.pcb_port_id
      ? { start_pcb_port_id: item.connection.sourcePoint.pcb_port_id }
      : {}),
  }))
  return {
    busId: item.bus.busId,
    connectionName: item.connection.connection.name,
    connectionIndex: item.connection.connectionIndex,
    sourcePointIndex: item.connection.sourcePointIndex,
    sourcePoint: item.connection.sourcePoint,
    sourceObstacle: item.connection.sourceObstacle,
    sourceLayer: item.connection.sourceLayer,
    targetLayer: "top",
    direction: item.direction,
    exitPoint: points.at(-1)!,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${item.connection.connection.name}`,
      connection_name: item.connection.connection.name,
      connectsTo: [
        item.connection.connection.name,
        ...(item.connection.sourcePoint.pointId
          ? [item.connection.sourcePoint.pointId]
          : []),
        ...(item.connection.sourcePoint.pcb_port_id
          ? [item.connection.sourcePoint.pcb_port_id]
          : []),
      ],
      route,
    },
    segments,
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

function routesAreClear(params: {
  paths: RoutedPath[]
  obstacles: Obstacle[]
  traceWidth: number
  clearance: number
  breakoutMargin: number
}): boolean {
  const { paths, obstacles, traceWidth, clearance, breakoutMargin } = params
  const requiredObstacleDistance = traceWidth / 2 + clearance
  const requiredCenterDistance = traceWidth + clearance

  for (const path of paths) {
    if (
      directionSign(path.item.direction) *
        (getAxis(path.points.at(-1)!, path.item.direction) -
          getExitAxis(path.item.bus, breakoutMargin)) <
      -1e-6
    ) {
      return false
    }
    for (const segment of path.segments) {
      for (const obstacle of obstacles) {
        if (
          obstacle === path.item.connection.sourceObstacle ||
          !obstacle.layers.includes("top")
        ) {
          continue
        }
        if (
          distanceSegmentToObstacle(segment, obstacle) <
          requiredObstacleDistance - 1e-9
        ) {
          return false
        }
      }
    }
  }

  for (let firstIndex = 0; firstIndex < paths.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < paths.length;
      secondIndex++
    ) {
      for (const firstSegment of paths[firstIndex]!.segments) {
        for (const secondSegment of paths[secondIndex]!.segments) {
          if (
            distanceSegmentToSegment(
              firstSegment.start,
              firstSegment.end,
              secondSegment.start,
              secondSegment.end,
            ) <
            requiredCenterDistance - 1e-9
          ) {
            return false
          }
        }
      }
    }
  }
  return true
}

export function routeSingleLayerWithPushAndShove(
  params: PushShoveParams,
): FanoutRoutePlan[] | null {
  const { srj, buses, traceWidth, clearance, breakoutMargin } = params
  const requiredObstacleDistance = traceWidth / 2 + clearance
  const recordsByConnectionName = new Map<string, ActiveRoute>()
  const items = buses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const source = {
        x: connection.sourcePoint.x,
        y: connection.sourcePoint.y,
      }
      return {
        bus,
        connection,
        direction: bus.direction,
        source,
      } satisfies RoutingItem
    }),
  )

  for (const direction of [
    "left",
    "right",
    "up",
    "down",
  ] as const satisfies readonly FanoutDirection[]) {
    const sign = directionSign(direction)
    const directionItems = items.filter((item) => item.direction === direction)
    if (directionItems.length === 0) continue
    const rawExitAxis = getExitAxis(directionItems[0]!.bus, breakoutMargin)
    const exitAxis =
      sign > 0
        ? Math.ceil(rawExitAxis / traceWidth) * traceWidth
        : Math.floor(rawExitAxis / traceWidth) * traceWidth
    const sourcesByEventKey = new Map<string, RoutingItem[]>()
    const obstaclesByEventKey = new Map<string, Obstacle[]>()
    const axisByEventKey = new Map<string, number>()

    for (const item of directionItems) {
      const axis = getAxis(item.source, direction)
      const key = axis.toFixed(6)
      axisByEventKey.set(key, axis)
      const eventSources = sourcesByEventKey.get(key) ?? []
      eventSources.push(item)
      sourcesByEventKey.set(key, eventSources)
    }
    for (const [eventKey, eventSources] of sourcesByEventKey) {
      const eventAxis = axisByEventKey.get(eventKey)!
      const eventComponentIds = new Set(
        eventSources.map((item) => item.bus.componentId),
      )
      obstaclesByEventKey.set(
        eventKey,
        srj.obstacles.filter(
          (obstacle) =>
            obstacle.layers.includes("top") &&
            !!obstacle.componentId &&
            eventComponentIds.has(obstacle.componentId) &&
            Math.abs(getAxis(obstacle.center, direction) - eventAxis) < 1e-6,
        ),
      )
    }

    const eventAxes = [...axisByEventKey.values()].toSorted(
      (a, b) => sign * (a - b),
    )
    const active = new Map<string, ActiveRoute>()
    for (let eventIndex = 0; eventIndex < eventAxes.length; eventIndex++) {
      const eventAxis = eventAxes[eventIndex]!
      const eventKey = eventAxis.toFixed(6)
      for (const item of sourcesByEventKey.get(eventKey) ?? []) {
        const directionalPadSize = isHorizontal(direction)
          ? item.connection.sourceObstacle.width
          : item.connection.sourceObstacle.height
        const sourceEscapeDistance =
          Math.max(
            item.connection.sourceObstacle.width,
            item.connection.sourceObstacle.height,
          ) < 1.5
            ? directionalPadSize / 2 + requiredObstacleDistance
            : 0
        const sourceEscapePoint = makePoint(
          eventAxis + sign * sourceEscapeDistance,
          getPerpendicularAxis(item.source, direction),
          direction,
        )
        active.set(item.connection.connection.name, {
          item,
          points:
            distance(item.source, sourceEscapePoint) > 1e-9
              ? [item.source, sourceEscapePoint]
              : [item.source],
          track: getPerpendicularAxis(item.source, direction),
        })
      }

      const nextAxis = eventAxes[eventIndex + 1] ?? exitAxis
      if (active.size === 0 || sign * (nextAxis - eventAxis) <= 1e-9) {
        continue
      }
      const orderedRoutes = [...active.values()].toSorted(
        (a, b) =>
          a.track - b.track ||
          a.item.connection.connection.name.localeCompare(
            b.item.connection.connection.name,
          ),
      )
      const lookaheadObstacles = eventAxes
        .slice(eventIndex + 1, eventIndex + 3)
        .flatMap((axis) => obstaclesByEventKey.get(axis.toFixed(6)) ?? [])
      const boundaryMinimum = isHorizontal(direction)
        ? directionItems[0]!.bus.sharedBoundary.minY
        : directionItems[0]!.bus.sharedBoundary.minX
      const boundaryMaximum = isHorizontal(direction)
        ? directionItems[0]!.bus.sharedBoundary.maxY
        : directionItems[0]!.bus.sharedBoundary.maxX
      const maximumShift = Math.min(
        ...orderedRoutes.map((route) =>
          Math.abs(nextAxis - getAxis(route.points.at(-1)!, direction)),
        ),
      )
      const selectedTracks = getCandidateTracks({
        direction,
        activeRoutes: orderedRoutes,
        obstacles: lookaheadObstacles,
        boundaryMinimum,
        boundaryMaximum,
        traceWidth,
        clearance,
        maximumShift,
      })
      if (!selectedTracks) return null

      for (let index = 0; index < orderedRoutes.length; index++) {
        const route = orderedRoutes[index]!
        const selectedTrack = selectedTracks[index]!
        const shift = Math.abs(selectedTrack - route.track)
        const routeStartAxis = getAxis(route.points.at(-1)!, direction)
        const diagonalEnd = makePoint(
          routeStartAxis + sign * shift,
          selectedTrack,
          direction,
        )
        if (distance(route.points.at(-1)!, diagonalEnd) > 1e-9) {
          route.points.push(diagonalEnd)
        }
        const nextPoint = makePoint(nextAxis, selectedTrack, direction)
        if (distance(route.points.at(-1)!, nextPoint) > 1e-9) {
          route.points.push(nextPoint)
        }
        route.track = selectedTrack
      }
    }

    for (const route of active.values()) {
      recordsByConnectionName.set(route.item.connection.connection.name, route)
    }
  }

  if (recordsByConnectionName.size !== items.length) return null
  const paths = items.map((item) => {
    const activeRoute = recordsByConnectionName.get(
      item.connection.connection.name,
    )!
    const points = compressPath(activeRoute.points)
    return {
      item,
      points,
      segments: getPathSegments(points, traceWidth),
    } satisfies RoutedPath
  })
  if (
    !routesAreClear({
      paths,
      obstacles: srj.obstacles,
      traceWidth,
      clearance,
      breakoutMargin,
    })
  ) {
    return null
  }
  return paths.map(buildPlan)
}

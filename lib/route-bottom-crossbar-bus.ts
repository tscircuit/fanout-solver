import type {
  Obstacle,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getCornerBandSide } from "./boundary-exit"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import {
  fanoutPlansAreClear,
  getCornerTargetTrack,
  getBoundaryTargetTrack,
  type RouteBusParams,
} from "./route-bus"
import { routeSingleLayerWithAdaptiveExitsSteps } from "./route-single-layer-adaptive-exits"
import {
  buildViaMinimalWindingPlan,
  type RouteViaMinimalWindingProgress,
} from "./route-via-minimal-winding"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  RoutedSegment,
  RoutedVia,
} from "./types"

/** Use two allowed layers to permute unordered bottom exits into either side of the boundary. */
export function* routeBottomCrossbarBusSteps(
  params: RouteBusParams & {
    sourceEscapes: readonly PeripheralSourceEscape[]
    sourceBoundary: Bounds
  },
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  const {
    bus,
    srj,
    sourceEscapes,
    sourceBoundary,
    targetLayer,
    acceptedPlans,
    traceWidth: width,
    clearance,
    viaDiameter,
  } = params
  const oppositeSide = bus.exitEdge === "left"
  const allowedLayers = bus.routableEscapeLayers ?? bus.allowedLayers ?? []
  const sourceLayer = bus.connections[0]!.sourceLayer
  const crossoverLayer = oppositeSide
    ? allowedLayers.find((layer) => layer !== targetLayer)
    : sourceLayer
  if (
    bus.termination.type !== "boundary" ||
    (bus.exitEdge !== "right" && !oppositeSide) ||
    !crossoverLayer ||
    !allowedLayers.includes(targetLayer) ||
    crossoverLayer === targetLayer ||
    !(bus.routableEscapeLayers ?? bus.allowedLayers ?? []).includes(
      crossoverLayer,
    )
  )
    return null
  const usesLowerBand =
    getCornerBandSide(bus.exitEdge, bus.preferredExit) === "minimum"
  const count = bus.connections.length,
    pitch = width + clearance
  const portPitch = Math.ceil((viaDiameter + clearance) / pitch) * pitch
  const byIndex = new Map(
    sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  const ownSources = bus.connections.map((connection) =>
    byIndex.get(connection.connectionIndex),
  )
  if (count < 2 || ownSources.some((source) => !source)) return null
  const viaPoints = ownSources.map((source) => source!.via.center)
  const firstPortColumn = Math.round(
    ((oppositeSide
      ? (sourceBoundary.minX + sourceBoundary.maxX) / 2
      : Math.min(...viaPoints.map((point) => point.x))) +
      portPitch -
      sourceBoundary.minX) /
      pitch,
  )
  const portStride = Math.round(portPitch / pitch)
  const portColumns = new Set(
    Array.from(
      { length: count },
      (_, rank) => firstPortColumn + rank * portStride,
    ),
  )
  const columnCount = Math.round(
    (sourceBoundary.maxX - sourceBoundary.minX) / pitch,
  )
  if (firstPortColumn < 1 || Math.max(...portColumns) >= columnCount)
    return null
  const circle = (name: string, center: Point2D, diameter: number): Obstacle =>
    ({
      type: "rect",
      shape: "circle",
      center,
      width: diameter,
      height: diameter,
      layers: ["top"],
      connectedTo: [name],
    }) as Obstacle
  const obstacles: Obstacle[] = [
    ...srj.obstacles
      .filter((obstacle) => obstacle.layers.includes(targetLayer))
      .map((obstacle) => ({ ...obstacle, layers: ["top"] })),
    ...sourceEscapes.map((source) =>
      circle(source.connectionName, source.via.center, source.via.diameter),
    ),
    ...acceptedPlans.flatMap((plan) =>
      (plan.additionalVias ?? []).map((via) =>
        circle(plan.connectionName, via.center, via.diameter),
      ),
    ),
    ...acceptedPlans.flatMap((plan) =>
      plan.segments
        .filter((segment) => segment.layer === targetLayer)
        .map((segment) => ({
          type: "rect" as const,
          center: {
            x: (segment.start.x + segment.end.x) / 2,
            y: (segment.start.y + segment.end.y) / 2,
          },
          width: distance(segment.start, segment.end),
          height: segment.width,
          ccwRotationDegrees:
            (Math.atan2(
              segment.end.y - segment.start.y,
              segment.end.x - segment.start.x,
            ) *
              180) /
            Math.PI,
          layers: ["top"],
          connectedTo: [plan.connectionName],
        })),
    ),
  ]
  // Restrict only the internal flow sinks. The returned copper is checked against the original SRJ.
  for (let column = 0; column <= columnCount; column++)
    if (!portColumns.has(column))
      obstacles.push(
        circle(
          `reserved-crossbar-port-${column}`,
          { x: sourceBoundary.minX + column * pitch, y: sourceBoundary.minY },
          width / 1000,
        ),
      )
  const flowBuses = bus.connections.map((connection, index) => {
    const viaPoint = viaPoints[index]!,
      ownObstacle = obstacles.find(
        (obstacle) =>
          obstacle.connectedTo.includes(connection.connection.name) &&
          distance(obstacle.center, viaPoint) < 1e-7,
      )!
    return {
      ...bus,
      busId: `${bus.busId}:source-${index}`,
      sharedBoundary: sourceBoundary,
      preferredExit: undefined,
      exitEdge: undefined,
      connections: [
        {
          ...connection,
          sourcePoint: {
            ...connection.sourcePoint,
            ...viaPoint,
            layer: "top",
          },
          sourceObstacle: ownObstacle,
          sourceLayer: "top",
          exitTargetPoint: undefined,
          hasExplicitLayeredExitTarget: false,
          hasExplicitExitTarget: false,
        },
      ],
    }
  })
  const flow = routeSingleLayerWithAdaptiveExitsSteps({
    srj: { ...srj, bounds: sourceBoundary, obstacles },
    buses: flowBuses,
    traceWidth: width,
    clearance,
    availableBoundaryRegions: [
      { direction: "down", preferredExit: "bottom", exitEdge: "bottom" },
    ],
  })
  let flowStep = flow.next()
  while (!flowStep.done) {
    yield {
      phase: "route-connection",
      routeOrderAttempt: 0,
      connectionIndex: 0,
      connectionCount: count,
      connectionName: bus.connections[0]!.connection.name,
      searchBatch: 0,
      expandedStateCount: 0,
      connectionComplete: false,
    }
    flowStep = flow.next()
  }
  if (!flowStep.value || flowStep.value.length !== count) return null
  const prefixes = new Map(
    flowStep.value.map((plan) => [plan.connectionIndex, plan]),
  )
  const targetTrack = (connection: (typeof bus.connections)[number]) =>
    getCornerBandSide(bus.exitEdge, bus.preferredExit) !== undefined
      ? getCornerTargetTrack({ ...params, connection, cornerExitLaneOffset: 0 })
      : getBoundaryTargetTrack({
          ...params,
          connection,
          boundaryDirection: oppositeSide ? "left" : "right",
        })
  const ordered = bus.connections.toSorted(
    (a, b) => targetTrack(a) - targetTrack(b),
  )

  const padMaximumX = Math.max(
    ...bus.componentObstacles.map(
      (obstacle) => obstacle.center.x + obstacle.width / 2,
    ),
  )
  const foreignRightVias = sourceEscapes
    .filter((source) => source.via.center.x > sourceBoundary.maxX)
    .map((source) => source.via.center.x)
  const rightViaX = foreignRightVias.length
    ? Math.min(...foreignRightVias)
    : bus.sharedBoundary.maxX
  const viaTraceDistance = viaDiameter / 2 + width / 2 + clearance
  // Diagonally staggered crossbar vias need trace-to-via spacing on each
  // axis; the final physical check also verifies their diagonal via clearance.
  const crossingPitch = usesLowerBand
    ? Math.max(viaTraceDistance, (viaDiameter + clearance) / Math.SQRT2) + 1e-5
    : portPitch
  const lowestAcceptedCopper = Math.min(
    ...acceptedPlans
      .flatMap((plan) => plan.segments)
      .filter((segment) => segment.layer !== crossoverLayer)
      .flatMap((segment) => [segment.start.y, segment.end.y]),
  )
  const annulusTop = Math.min(
    sourceBoundary.minY - viaDiameter / 2 - clearance,
    usesLowerBand ? lowestAcceptedCopper - viaTraceDistance - 1e-5 : Infinity,
  )
  const annulusBottom = annulusTop - (count - 1) * crossingPitch
  const crossingSourceSegments = sourceEscapes
    .flatMap((source) => source.segments)
    .filter(
      (segment) =>
        segment.layer === crossoverLayer &&
        (!usesLowerBand ||
          Math.max(segment.start.x, segment.end.x) >=
            Math.min(
              ...[...prefixes.values()].map((prefix) => prefix.exitPoint.x),
            ) -
              viaTraceDistance) &&
        Math.min(segment.start.y, segment.end.y) <=
          annulusTop + viaTraceDistance &&
        Math.max(segment.start.y, segment.end.y) >=
          annulusBottom - viaTraceDistance,
    )
  const sourceCopperColumnLimit = crossingSourceSegments.length
    ? Math.min(
        ...crossingSourceSegments.map((segment) =>
          Math.min(segment.start.x, segment.end.x),
        ),
      ) -
      viaTraceDistance -
      1e-5
    : bus.sharedBoundary.maxX
  const highestColumn = Math.min(
    bus.sharedBoundary.maxX - viaDiameter - clearance,
    rightViaX - viaTraceDistance - width,
    sourceCopperColumnLimit,
  )
  const columnBlockers = [
    ...sourceEscapes.map((source) => source.via),
    ...acceptedPlans.flatMap((plan) => plan.additionalVias ?? []),
  ]
    .filter((via) => via.spanLayers.includes(targetLayer))
    .map((via) => ({
      minimum: via.center.x - via.diameter / 2 - width / 2 - clearance - 1e-5,
      maximum: via.center.x + via.diameter / 2 + width / 2 + clearance + 1e-5,
    }))
  const nominalColumns = Array.from(
    { length: count },
    (_, rank) => highestColumn - rank * crossingPitch,
  )
  const columns: number[] = []
  if (
    nominalColumns.every((column) =>
      columnBlockers.every(
        (interval) => column < interval.minimum || column > interval.maximum,
      ),
    )
  )
    columns.push(...nominalColumns)
  else {
    let nextColumn = highestColumn
    for (let rank = 0; rank < count; rank++) {
      for (let pass = 0; pass <= columnBlockers.length; pass++) {
        const blockers = columnBlockers.filter(
          (interval) =>
            nextColumn >= interval.minimum && nextColumn <= interval.maximum,
        )
        if (!blockers.length) break
        nextColumn =
          Math.min(...blockers.map((interval) => interval.minimum)) - 1e-7
      }
      columns.push(nextColumn)
      nextColumn -= usesLowerBand ? crossingPitch : viaDiameter + clearance
    }
  }
  const minimumColumn = columns.at(-1)!
  const blockedTracks = [
    ...sourceEscapes.map((source) => source.via),
    ...acceptedPlans.flatMap((plan) => plan.additionalVias ?? []),
  ]
    .filter(
      (via) =>
        via.spanLayers.includes(targetLayer) &&
        via.center.x + via.diameter / 2 + width / 2 + clearance >=
          minimumColumn &&
        via.center.x - via.diameter / 2 - width / 2 - clearance <=
          bus.sharedBoundary.maxX,
    )
    .map((via) => ({
      minimum:
        via.center.y - via.diameter / 2 - width / 2 - clearance - width / 100,
      maximum:
        via.center.y + via.diameter / 2 + width / 2 + clearance + width / 100,
    }))
  const tracks: number[] = []
  let nextTrack = bus.sharedBoundary.maxY - width / 2
  for (let rank = count - 1; rank >= 0; rank--) {
    for (let pass = 0; pass <= blockedTracks.length; pass++) {
      const blockers = blockedTracks.filter(
        (interval) =>
          nextTrack >= interval.minimum && nextTrack <= interval.maximum,
      )
      if (!blockers.length) break
      nextTrack =
        Math.min(...blockers.map((interval) => interval.minimum)) - 1e-7
    }
    tracks[rank] = nextTrack
    nextTrack -= viaDiameter + clearance
  }
  if (usesLowerBand)
    tracks.splice(0, tracks.length, ...ordered.map(targetTrack))
  const lowestTrack = tracks[0]!
  const topRow = annulusTop
  if (
    topRow - (count - 1) * crossingPitch - viaDiameter / 2 <
      bus.sharedBoundary.minY ||
    minimumColumn <=
      Math.max(...[...prefixes.values()].map((prefix) => prefix.exitPoint.x)) +
        viaTraceDistance ||
    (!usesLowerBand &&
      lowestTrack <= (bus.sharedBoundary.minY + bus.sharedBoundary.maxY) / 2)
  )
    return null
  const baseLengths = ordered
    .map((connection, rank) => {
      const prefix = prefixes.get(connection.connectionIndex)!,
        source = byIndex.get(connection.connectionIndex)!,
        exitY = tracks[rank]!
      return {
        connectionIndex: connection.connectionIndex,
        length:
          source.segments.reduce(
            (sum, segment) => sum + distance(segment.start, segment.end),
            0,
          ) +
          prefix.length +
          exitY -
          prefix.exitPoint.x,
      }
    })
    .sort((a, b) => b.length - a.length)
  const rowRank = new Map(
    baseLengths.map((item, rank) => [item.connectionIndex, rank]),
  )
  const segments = (
    points: readonly Point2D[],
    layer: string,
  ): RoutedSegment[] =>
    points
      .slice(1)
      .flatMap((end, index) =>
        distance(points[index]!, end) < 1e-9
          ? []
          : [{ start: points[index]!, end, width, layer }],
      )
  const wires = (
    points: readonly Point2D[],
    layer: string,
  ): SimplifiedPcbTrace["route"] =>
    points.map((point) => ({ route_type: "wire", ...point, width, layer }))
  const viaRoute = (via: RoutedVia): SimplifiedPcbTrace["route"][number] => ({
    route_type: "via",
    ...via.center,
    from_layer: via.fromLayer,
    to_layer: via.toLayer,
    via_diameter: via.diameter,
    via_hole_diameter: via.holeDiameter,
  })
  const plans = ordered.map((connection, rank) => {
    const source = byIndex.get(connection.connectionIndex)!,
      prefix = prefixes.get(connection.connectionIndex)!,
      row = topRow - rowRank.get(connection.connectionIndex)! * crossingPitch
    const first = { x: prefix.exitPoint.x, y: row },
      second = { x: columns[oppositeSide ? count - 1 - rank : rank]!, y: row },
      exitPoint = {
        x: oppositeSide ? bus.sharedBoundary.minX : bus.sharedBoundary.maxX,
        y: tracks[rank]!,
      }
    const sourcePath = [
        source.segments[0]!.start,
        ...source.segments.map((segment) => segment.end),
      ],
      innerStart = [
        prefix.segments[0]!.start,
        ...prefix.segments.map((segment) => segment.end),
        first,
      ],
      tail = [
        second,
        {
          x: second.x,
          y: exitPoint.y - Math.sign(exitPoint.y - second.y) * width,
        },
        { x: second.x + (oppositeSide ? -width : width), y: exitPoint.y },
        exitPoint,
      ]
    const plan = buildViaMinimalWindingPlan({
      ...params,
      terminal: { connection, viaPoint: source.via.center, exitPoint },
      sourceEscapePoints: sourcePath,
      targetLayerPoints: [source.via.center, exitPoint],
      allowBlindAndBuriedVias: false,
    })
    const additionalVias: RoutedVia[] = [
      {
        center: first,
        diameter: viaDiameter,
        holeDiameter: params.viaHoleDiameter,
        spanLayers: params.layerNames,
        fromLayer: targetLayer,
        toLayer: crossoverLayer,
      },
      {
        center: second,
        diameter: viaDiameter,
        holeDiameter: params.viaHoleDiameter,
        spanLayers: params.layerNames,
        fromLayer: crossoverLayer,
        toLayer: targetLayer,
      },
    ]
    plan.segments = [
      ...source.segments,
      ...segments(innerStart, targetLayer),
      ...segments([first, second], crossoverLayer),
      ...segments(tail, targetLayer),
    ]
    plan.additionalVias = additionalVias
    plan.sourceEscapeSegmentCount = source.segments.length
    plan.length = plan.segments.reduce(
      (sum, segment) => sum + distance(segment.start, segment.end),
      0,
    )
    plan.trace.route = [
      ...wires(sourcePath, sourceLayer),
      viaRoute(plan.via!),
      ...wires(innerStart, targetLayer),
      viaRoute(additionalVias[0]!),
      ...wires([first, second], crossoverLayer),
      viaRoute(additionalVias[1]!),
      ...wires(tail, targetLayer),
    ]
    return plan
  })
  if (bus.maxLengthSkew !== undefined) {
    const lengths = plans.map((plan) => plan.length)
    if (Math.max(...lengths) - Math.min(...lengths) > bus.maxLengthSkew + 1e-6)
      return null
  }
  if (
    !fanoutPlansAreClear({
      ...params,
      plans: [...acceptedPlans, ...plans],
      sharedBoundary: bus.sharedBoundary,
    })
  )
    return null
  for (const plan of plans)
    for (const source of sourceEscapes) {
      if (plan.connectionIndex === source.connectionIndex) continue
      for (const segment of plan.segments) {
        if (
          source.via.spanLayers.includes(segment.layer) &&
          distancePointToSegment(
            source.via.center,
            segment.start,
            segment.end,
          ) <
            source.via.diameter / 2 + width / 2 + clearance - 1e-7
        )
          return null
        for (const other of source.segments)
          if (
            segment.layer === other.layer &&
            distanceSegmentToSegment(
              segment.start,
              segment.end,
              other.start,
              other.end,
            ) <
              (width + other.width) / 2 + clearance - 1e-7
          )
            return null
      }
      for (const via of plan.additionalVias!) {
        if (
          distance(via.center, source.via.center) <
          (via.diameter + source.via.diameter) / 2 + clearance - 1e-7
        )
          return null
        for (const segment of source.segments)
          if (
            via.spanLayers.includes(segment.layer) &&
            distancePointToSegment(via.center, segment.start, segment.end) <
              via.diameter / 2 + segment.width / 2 + clearance - 1e-7
          )
            return null
      }
    }
  return plans
}

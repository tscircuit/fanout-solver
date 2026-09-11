import { getCornerBandSide } from "./boundary-exit"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import { getViaSpanLayers } from "./layer-names"
import {
  fanoutPlansAreClear,
  getCornerTargetTrack,
  type RouteBusParams,
} from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingProgress,
} from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  RoutedSegment,
  RoutedVia,
} from "./types"
import {
  getViaHoleToHoleClearance,
  getViaPairMinimumCenterDistance,
} from "./via-clearance"

/** Route a right-edge bus through a peripheral crossbar on its two allowed layers. */
export function* routeLeftCrossbarBusSteps(
  params: RouteBusParams & {
    sourceEscapes: readonly PeripheralSourceEscape[]
    sourceBoundary: Bounds
  },
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  const {
    bus,
    sourceBoundary,
    sourceEscapes,
    traceWidth: w,
    clearance: c,
    targetLayer,
  } = params
  const cornerSide = getCornerBandSide(bus.exitEdge, bus.preferredExit)
  if (
    params.allowBlindAndBuriedVias ||
    bus.exitEdge !== "right" ||
    (cornerSide !== undefined && cornerSide !== "minimum") ||
    bus.connections.length < 3
  )
    return null
  const allowedLayers = bus.routableEscapeLayers ?? bus.allowedLayers ?? []
  const crossoverLayer = allowedLayers.find((layer) => layer !== targetLayer)
  if (
    !crossoverLayer ||
    !allowedLayers.includes(targetLayer) ||
    bus.connections.some((connection) => connection.sourceLayer === targetLayer)
  )
    return null
  const byIndex = new Map(
    sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  const pitch = w + c,
    padPitch = Math.min(bus.pitchX, bus.pitchY),
    viaPitch = getViaPairMinimumCenterDistance({
      first: {
        diameter: params.viaDiameter,
        holeDiameter: params.viaHoleDiameter,
      },
      second: {
        diameter: params.viaDiameter,
        holeDiameter: params.viaHoleDiameter,
      },
      copperClearance: c,
      holeToHoleClearance: getViaHoleToHoleClearance(params.srj),
    })
  const center = {
    x: (bus.componentBounds.minX + bus.componentBounds.maxX) / 2,
    y: (bus.componentBounds.minY + bus.componentBounds.maxY) / 2,
  }
  const firstColumn =
    bus.sharedBoundary.minX + Math.max(padPitch / 2, params.viaDiameter / 2 + c)
  if (
    firstColumn + (bus.connections.length - 1) * viaPitch >=
    sourceBoundary.minX
  )
    return null
  const sameCornerCount = params.acceptedPlans.filter(
    (plan) =>
      plan.exitEdge === bus.exitEdge && plan.cornerBandSide === "minimum",
  ).length
  const terminals = bus.connections.map((connection) => {
    const source = byIndex.get(connection.connectionIndex)
    if (!source)
      throw new Error(
        `FanoutSolver: missing crossbar source escape for ${connection.connection.name}`,
      )
    return {
      connection,
      viaPoint: source.via.center,
      exitPoint: {
        x: bus.sharedBoundary.maxX,
        y: cornerSide
          ? getCornerTargetTrack({
              ...params,
              connection,
              cornerExitLaneOffset: sameCornerCount,
            })
          : getCornerTargetTrack({
              ...params,
              bus: { ...bus, preferredExit: "bottom-right" },
              connection,
              cornerExitLaneOffset: sameCornerCount,
              windingOrderIndex: 0,
            }),
      },
    }
  })
  const targetOrdered = terminals.toSorted(
    (a, b) => a.exitPoint.y - b.exitPoint.y,
  )
  if (!cornerSide)
    for (const [rank, terminal] of targetOrdered.entries())
      terminal.exitPoint.y = sourceBoundary.minY + padPitch + rank * viaPitch
  const crossoverTrackByIndex = new Map(
    targetOrdered.map((terminal) => [
      terminal.connection.connectionIndex,
      terminal.exitPoint.y,
    ]),
  )
  const maxPort = Math.min(
    sourceBoundary.maxY - pitch,
    Math.max(...terminals.map((t) => t.viaPoint.y)) + 2 * padPitch,
  )
  const minPort = Math.max(
    sourceBoundary.minY + pitch,
    Math.min(...terminals.map((t) => t.viaPoint.y)) - 2 * padPitch,
    ...(cornerSide
      ? []
      : [
          Math.max(...crossoverTrackByIndex.values()) +
            params.viaDiameter / 2 +
            w / 2 +
            c +
            pitch,
        ]),
  )
  if (
    maxPort - minPort < (terminals.length - 1) * viaPitch ||
    minPort <=
      Math.max(...crossoverTrackByIndex.values()) +
        params.viaDiameter / 2 +
        w / 2 +
        c
  )
    return null
  const angle = (i: number) => {
    const p = terminals[i]!.viaPoint
    const a = Math.atan2(p.y - center.y, p.x - center.x)
    return a < 0 ? a + 2 * Math.PI : a
  }
  const order = terminals.map((_, i) => i).sort((a, b) => angle(a) - angle(b))
  const portByIndex = new Map(
    order.map((index, rank) => [
      index,
      {
        x: sourceBoundary.minX,
        y: maxPort - ((maxPort - minPort) * rank) / (terminals.length - 1),
      },
    ]),
  )
  const stageBoundary = {
    minX: sourceBoundary.minX,
    maxX: center.x,
    minY: Math.min(
      minPort - padPitch,
      Math.min(...terminals.map((terminal) => terminal.viaPoint.y)) -
        2 * padPitch,
    ),
    maxY: sourceBoundary.maxY,
  }
  const sourcePaths = new Map(
    sourceEscapes.map((source) => [
      source.connectionIndex,
      [source.segments[0]!.start, ...source.segments.map((s) => s.end)],
    ]),
  )
  const ownIndices = new Set(terminals.map((t) => t.connection.connectionIndex))
  const reservedVias = sourceEscapes
    .filter((source) => !ownIndices.has(source.connectionIndex))
    .map((source) => ({
      connectionName: source.connectionName,
      via: source.via,
    }))
  let stage: FanoutRoutePlan[] | undefined
  for (const laneBias of [0, -1, 1] as const) {
    const alternatives = yield* routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        bus: {
          ...bus,
          exitEdge: "left",
          direction: "left",
          preferredExit: undefined,
          sharedBoundary: stageBoundary,
        },
        terminals: terminals.map((t, i) => ({
          ...t,
          exitPoint: portByIndex.get(i)!,
        })),
        sourceEscapePaths: sourcePaths,
        reservedVias,
        gridStep: pitch / 4,
        gridStepDivisor: 2,
        alignGridToPads: true,
        maximumRouteOrderAttempts: 1,
        routeOrder: order,
        laneBias,
      },
      1,
      false,
    )
    if (alternatives.length) {
      stage = alternatives[0]
      break
    }
  }
  if (!stage) return null
  const sorted = stage.toSorted((a, b) =>
    cornerSide
      ? a.exitPoint.y - b.exitPoint.y
      : terminals.find(
          (t) => t.connection.connectionIndex === a.connectionIndex,
        )!.exitPoint.y -
        terminals.find(
          (t) => t.connection.connectionIndex === b.connectionIndex,
        )!.exitPoint.y,
  )
  const via = (
    point: Point2D,
    fromLayer: string,
    toLayer: string,
  ): RoutedVia => ({
    center: point,
    diameter: params.viaDiameter,
    holeDiameter: params.viaHoleDiameter,
    fromLayer,
    toLayer,
    spanLayers: getViaSpanLayers({
      fromLayer,
      toLayer,
      layerNames: params.layerNames,
      allowBlindAndBuriedVias: false,
    }),
  })
  const prefixByIndex = new Map<number, FanoutRoutePlan>()
  for (const [rank, plan] of sorted.entries()) {
    const last = plan.segments.at(-1)!,
      dx = last.end.x - last.start.x,
      dy = last.end.y - last.start.y
    if (dx >= 0 || Math.abs(dy) > -dx + 1e-7) return null
    const original = terminals.find(
      (t) => t.connection.connectionIndex === plan.connectionIndex,
    )!
    const column = firstColumn + rank * viaPitch,
      first = { x: column, y: plan.exitPoint.y },
      second = {
        x: column,
        y: crossoverTrackByIndex.get(plan.connectionIndex)!,
      }
    const additions: RoutedSegment[] = [
      { start: plan.exitPoint, end: first, width: w, layer: targetLayer },
      { start: first, end: second, width: w, layer: crossoverLayer },
    ]
    prefixByIndex.set(plan.connectionIndex, {
      ...plan,
      segments: [...plan.segments, ...additions],
      additionalVias: [
        via(first, targetLayer, crossoverLayer),
        via(second, crossoverLayer, targetLayer),
      ],
      direction: bus.direction,
      exitEdge: bus.exitEdge,
      cornerBandSide: getCornerBandSide(bus.exitEdge, bus.preferredExit),
      exitPoint: original.exitPoint,
    })
  }
  const prefixes = [...prefixByIndex.values()]
  const continuationConnections = terminals.map((t) => ({
    ...t.connection,
    sourcePoint: {
      ...prefixByIndex.get(t.connection.connectionIndex)!.additionalVias![1]!
        .center,
      layer: targetLayer,
    },
    sourceLayer: targetLayer,
  }))
  const continuations = yield* routeViaMinimalWindingAlternativesSteps(
    {
      ...params,
      bus: { ...bus, connections: continuationConnections },
      terminals: continuationConnections.map((connection, i) => ({
        connection,
        viaPoint: connection.sourcePoint,
        exitPoint: terminals[i]!.exitPoint,
      })),
      acceptedPlans: [...params.acceptedPlans, ...prefixes],
      reservedVias: [
        ...sourceEscapes.map((source) => ({
          connectionName: source.connectionName,
          via: source.via,
        })),
        ...prefixes.flatMap((plan) =>
          plan.additionalVias!.map((via) => ({
            connectionName: plan.connectionName,
            via,
          })),
        ),
      ],
      allowSourceLayerRouting: true,
      sourceEscapePaths: undefined,
      gridStep: pitch / 2,
      gridStepDivisor: 2,
      alignGridToPads: true,
      maximumRouteOrderAttempts: 12,
    },
    1,
    false,
  )
  if (!continuations.length) return null
  const plans = stage.map((original) => {
    const prefix = prefixByIndex.get(original.connectionIndex)!,
      tail = continuations[0]!.find(
        (plan) => plan.connectionIndex === original.connectionIndex,
      )!,
      [first, second] = prefix.additionalVias!
    const wire = (point: Point2D, layer: string) => ({
      route_type: "wire" as const,
      ...point,
      width: w,
      layer,
    })
    const viaPoint = (via: RoutedVia) => ({
      route_type: "via" as const,
      ...via.center,
      from_layer: via.fromLayer,
      to_layer: via.toLayer,
      via_diameter: via.diameter,
      via_hole_diameter: via.holeDiameter,
    })
    const segments = [...prefix.segments, ...tail.segments]
    return {
      ...prefix,
      segments,
      trace: {
        ...original.trace,
        route: [
          ...original.trace.route,
          wire(first!.center, targetLayer),
          viaPoint(first!),
          wire(first!.center, crossoverLayer),
          wire(second!.center, crossoverLayer),
          viaPoint(second!),
          ...tail.trace.route,
        ],
      },
      length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
    }
  })
  if (
    !fanoutPlansAreClear({
      ...params,
      plans: [...params.acceptedPlans, ...plans],
      sharedBoundary: bus.sharedBoundary,
    })
  )
    return null
  for (const plan of plans)
    for (const source of sourceEscapes) {
      if (plan.connectionIndex === source.connectionIndex) continue
      for (const s of plan.segments) {
        if (
          source.via.spanLayers.includes(s.layer) &&
          distancePointToSegment(source.via.center, s.start, s.end) <
            source.via.diameter / 2 + w / 2 + c - 1e-7
        )
          return null
        for (const other of source.segments)
          if (
            other.layer === s.layer &&
            distanceSegmentToSegment(s.start, s.end, other.start, other.end) <
              w + c - 1e-7
          )
            return null
      }
      for (const added of plan.additionalVias!) {
        if (distance(added.center, source.via.center) < viaPitch - 1e-7)
          return null
        for (const s of source.segments)
          if (
            added.spanLayers.includes(s.layer) &&
            distancePointToSegment(added.center, s.start, s.end) <
              params.viaDiameter / 2 + w / 2 + c - 1e-7
          )
            return null
      }
    }
  // The caller length-matches all complete buses before final validation.
  return plans
}

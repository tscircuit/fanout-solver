import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import { getFanoutPlanSkew } from "./get-fanout-plan-effective-length"
import { fanoutPlansAreClear } from "./route-bus"
import {
  buildViaMinimalWindingPlan,
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingProgress,
} from "./route-via-minimal-winding"
import type { Bounds, FanoutRoutePlan, Point2D, PreparedBus } from "./types"

import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
export type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"

/** Join ordered inner-layer source escapes to nested perimeter lanes. */
export function* routeStagedPerimeterBusSteps(params: {
  srj: SimpleRouteJson
  bus: PreparedBus
  targetLayer: string
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  sourceBoundary: Bounds
  sourceEscapes: readonly PeripheralSourceEscape[]
  remoteConnectionIndices: ReadonlySet<number>
}): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  const {
    srj,
    bus,
    targetLayer,
    sourceBoundary,
    sourceEscapes,
    remoteConnectionIndices,
    traceWidth: width,
    clearance,
  } = params
  if (bus.exitEdge !== "right" || bus.termination.type !== "boundary")
    return null
  const pitch = width + clearance,
    padPitch = Math.min(bus.pitchX, bus.pitchY)
  const byIndex = new Map(sourceEscapes.map((s) => [s.connectionIndex, s]))
  const terminals = bus.connections
    .map((connection) => {
      const source = byIndex.get(connection.connectionIndex)
      if (!source)
        throw new Error(
          `FanoutSolver: missing source escape for ${connection.connection.name}`,
        )
      const target = connection.exitTargetPoint ?? connection.targetPoint
      return {
        connection,
        viaPoint: source.via.center,
        exitPoint: { x: bus.sharedBoundary.maxX, y: target.y },
      }
    })
    .sort((a, b) => a.exitPoint.y - b.exitPoint.y)
  const local = terminals.filter(
    (t) => !remoteConnectionIndices.has(t.connection.connectionIndex),
  )
  if (local.length < 2 || local.length === terminals.length) return null
  const minPadX = Math.min(
    ...bus.componentObstacles.map((o) => o.center.x - o.width / 2),
  )
  const nearPort = Math.max(...local.map((t) => t.viaPoint.x)) - width / 2
  const farPort = minPadX + params.viaDiameter / 2
  if (nearPort - farPort < (local.length - 1) * pitch) return null
  const rowY = sourceBoundary.maxY
  const stageBoundary = {
    minX: minPadX - padPitch,
    maxX: Math.max(...local.map((t) => t.viaPoint.x)) + 2 * padPitch,
    minY: Math.min(...local.map((t) => t.viaPoint.y)) - 3 * padPitch,
    maxY: rowY,
  }
  const localIndices = new Set(local.map((t) => t.connection.connectionIndex))
  const stageTerminals = local.map((t, i) => ({
    ...t,
    exitPoint: {
      x: nearPort + ((farPort - nearPort) * i) / (local.length - 1),
      y: rowY,
    },
  }))
  const stageBus: PreparedBus = {
    ...bus,
    exitEdge: "top",
    direction: "up",
    preferredExit: undefined,
    sharedBoundary: stageBoundary,
    connections: local.map((t) => t.connection),
  }
  const sourcePaths = new Map(
    sourceEscapes.map((s) => [
      s.connectionIndex,
      [s.segments[0]!.start, ...s.segments.map((s) => s.end)],
    ]),
  )
  let prefixes: FanoutRoutePlan[] | undefined
  for (const laneBias of [-1, 0, 1] as const) {
    const alternatives = yield* routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        bus: stageBus,
        srj: { ...srj, bounds: stageBoundary },
        acceptedPlans: [],
        terminals: stageTerminals,
        sourceEscapePaths: sourcePaths,
        reservedVias: sourceEscapes
          .filter((s) => !localIndices.has(s.connectionIndex))
          .map((s) => ({ connectionName: s.connectionName, via: s.via })),
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
        gridStepDivisor: 2,
        gridStep: pitch / 4,
        alignGridToPads: true,
        maximumRouteOrderAttempts: 1,
        routeOrder: local.map((_, i) => local.length - i - 1),
        laneBias,
      },
      1,
      false,
    )
    if (alternatives.length) {
      prefixes = alternatives[0]
      break
    }
  }
  if (!prefixes) return null
  const prefixByIndex = new Map(prefixes.map((p) => [p.connectionIndex, p]))
  const roofStart = rowY + padPitch,
    columnStart =
      bus.sharedBoundary.maxX -
      (local.length + 1) * pitch -
      2 * params.viaDiameter
  if (
    roofStart + (local.length - 1) * pitch + width / 2 >
    bus.sharedBoundary.maxY
  )
    return null
  let lane = 0
  const plans: FanoutRoutePlan[] = []
  for (const terminal of terminals) {
    const source = byIndex.get(terminal.connection.connectionIndex)!,
      prefix = prefixByIndex.get(terminal.connection.connectionIndex)
    let points: Point2D[]
    if (prefix) {
      const ss = prefix.segments.filter((s) => s.layer === targetLayer)
      const last = ss.at(-1)!,
        dx = last.end.x - last.start.x,
        dy = last.end.y - last.start.y
      if (dy <= 0 || Math.abs(dx) > dy + 1e-7) return null
      const port = last.end,
        roof = roofStart + lane * pitch,
        column = columnStart + lane * pitch
      lane++
      const extension = chamferRightAngles(
        [
          port,
          { x: port.x, y: roof },
          { x: column, y: roof },
          { x: column, y: terminal.exitPoint.y },
          terminal.exitPoint,
        ],
        width,
      )
      points = [ss[0]!.start, ...ss.map((s) => s.end), ...extension.slice(1)]
    } else points = [source.via.center, terminal.exitPoint]
    plans.push(
      buildViaMinimalWindingPlan({
        ...params,
        bus,
        terminal,
        targetLayerPoints: points,
        sourceEscapePoints: sourcePaths.get(
          terminal.connection.connectionIndex,
        ),
        allowBlindAndBuriedVias: false,
      }),
    )
  }
  if (
    bus.maxLengthSkew !== undefined &&
    getFanoutPlanSkew(plans) > bus.maxLengthSkew + 1e-6
  )
    return null
  if (
    !fanoutPlansAreClear({
      plans,
      srj,
      sharedBoundary: bus.sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    })
  )
    return null
  // A later bus must retain the source vias and source-layer copper reserved above.
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
            source.via.diameter / 2 + segment.width / 2 + clearance - 1e-7
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
              (segment.width + other.width) / 2 + clearance - 1e-7
          )
            return null
      }
    }
  return plans
}

function chamferRightAngles(points: Point2D[], trim: number): Point2D[] {
  // A boundary track can coincide with its roof, making the vertical descent
  // disappear. Remove that repeated corner before normalizing either leg.
  const distinct = points.filter(
    (point, index) => index === 0 || distance(point, points[index - 1]!) > 1e-9,
  )
  return distinct.flatMap((p, i) => {
    if (i === 0 || i === distinct.length - 1) return [p]
    const a = distinct[i - 1]!,
      b = distinct[i + 1]!,
      d = Math.min(trim, distance(a, p) / 3, distance(p, b) / 3)
    if (Math.abs((p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)) > 1e-9)
      return [p]
    return [
      {
        x: p.x + ((a.x - p.x) * d) / distance(a, p),
        y: p.y + ((a.y - p.y) * d) / distance(a, p),
      },
      {
        x: p.x + ((b.x - p.x) * d) / distance(p, b),
        y: p.y + ((b.y - p.y) * d) / distance(p, b),
      },
    ]
  })
}

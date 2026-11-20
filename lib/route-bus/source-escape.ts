import { distance } from "../geometry"
import type {
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "../types"
import { busIsOnOutwardComponentEdge } from "./connection-order"
import {
  directionSign,
  getAxis,
  getDirectionalPitch,
  getPerpendicularAxis,
  getPerpendicularPitch,
  isHorizontal,
  makePoint,
} from "./directions"
import type { ViaHandedness } from "./types"

export function chamferOrthogonalCorners(
  points: readonly Point2D[],
  requestedChamfer: number,
): Point2D[] {
  if (points.length < 3) return [...points]
  const output: Point2D[] = [points[0]!]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!
    const current = points[index]!
    const next = points[index + 1]!
    const incoming = { x: current.x - previous.x, y: current.y - previous.y }
    const outgoing = { x: next.x - current.x, y: next.y - current.y }
    const incomingLength = Math.hypot(incoming.x, incoming.y)
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
    const incomingIsAxisAligned =
      Math.abs(incoming.x) <= 1e-9 || Math.abs(incoming.y) <= 1e-9
    const outgoingIsAxisAligned =
      Math.abs(outgoing.x) <= 1e-9 || Math.abs(outgoing.y) <= 1e-9
    const isOrthogonal =
      Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y) <= 1e-9
    if (
      incomingLength <= 1e-9 ||
      outgoingLength <= 1e-9 ||
      !incomingIsAxisAligned ||
      !outgoingIsAxisAligned ||
      !isOrthogonal
    ) {
      output.push(current)
      continue
    }
    const chamfer = Math.min(
      requestedChamfer,
      incomingLength / 3,
      outgoingLength / 3,
    )
    output.push({
      x: current.x - (incoming.x / incomingLength) * chamfer,
      y: current.y - (incoming.y / incomingLength) * chamfer,
    })
    output.push({
      x: current.x + (outgoing.x / outgoingLength) * chamfer,
      y: current.y + (outgoing.y / outgoingLength) * chamfer,
    })
  }
  output.push(points.at(-1)!)
  return output.filter(
    (point, index) => index === 0 || distance(point, output[index - 1]!) > 1e-9,
  )
}

export function getStraightOr45ConnectorVariants(
  start: Point2D,
  end: Point2D,
): Point2D[][] {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const absoluteX = Math.abs(deltaX)
  const absoluteY = Math.abs(deltaY)
  if (
    absoluteX <= 1e-9 ||
    absoluteY <= 1e-9 ||
    Math.abs(absoluteX - absoluteY) <= 1e-9
  ) {
    return [[start, end]]
  }
  if (absoluteX > absoluteY) {
    return [
      [start, { x: start.x + Math.sign(deltaX) * absoluteY, y: end.y }, end],
      [start, { x: end.x - Math.sign(deltaX) * absoluteY, y: start.y }, end],
    ]
  }
  return [
    [start, { x: end.x, y: start.y + Math.sign(deltaY) * absoluteX }, end],
    [start, { x: start.x, y: end.y - Math.sign(deltaY) * absoluteX }, end],
  ]
}

export function appendSegment({
  segments,
  start,
  end,
  width,
  layer,
}: {
  segments: RoutedSegment[]
  start: Point2D
  end: Point2D
  width: number
  layer: string
}): void {
  if (distance(start, end) < 1e-9) return
  segments.push({ start, end, width, layer })
}

export function chamferOrthogonalPolyline(
  points: Point2D[],
  requestedChamfer: number,
): Point2D[] {
  if (points.length < 3) return points
  const chamfered: Point2D[] = [points[0]!]

  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!
    const corner = points[index]!
    const next = points[index + 1]!
    const incomingLength = distance(previous, corner)
    const outgoingLength = distance(corner, next)
    if (incomingLength < 1e-9 || outgoingLength < 1e-9) continue
    const incomingUnit = {
      x: (corner.x - previous.x) / incomingLength,
      y: (corner.y - previous.y) / incomingLength,
    }
    const outgoingUnit = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    }
    const dot =
      incomingUnit.x * outgoingUnit.x + incomingUnit.y * outgoingUnit.y
    if (Math.abs(dot) > 1e-6) {
      chamfered.push(corner)
      continue
    }

    const chamfer = Math.min(
      requestedChamfer,
      incomingLength / 2,
      outgoingLength / 2,
    )
    chamfered.push({
      x: corner.x - incomingUnit.x * chamfer,
      y: corner.y - incomingUnit.y * chamfer,
    })
    chamfered.push({
      x: corner.x + outgoingUnit.x * chamfer,
      y: corner.y + outgoingUnit.y * chamfer,
    })
  }

  chamfered.push(points.at(-1)!)
  return chamfered
}

export function getInitialViaPoint(params: {
  preparedConnection: PreparedConnection
  bus: PreparedBus
  targetLayer: string
  traceWidth: number
  viaDiameter: number
  clearance: number
  viaHandedness: ViaHandedness
}): Point2D {
  const {
    preparedConnection,
    bus,
    targetLayer,
    traceWidth,
    viaDiameter,
    clearance,
    viaHandedness,
  } = params
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const targetUsesVia = targetLayer !== preparedConnection.sourceLayer
  const directionalPitch = getDirectionalPitch(bus)
  const perpendicularPitch = getPerpendicularPitch(bus)
  const directionalPadSize = isHorizontal(bus.direction)
    ? preparedConnection.sourceObstacle.width
    : preparedConnection.sourceObstacle.height
  const initialEscapeDistance =
    targetUsesVia && !busIsOnOutwardComponentEdge(bus)
      ? directionalPadSize >= directionalPitch
        ? directionalPadSize / 2 + viaDiameter / 2 + clearance + 1e-3
        : directionalPitch * 0.5
      : !targetUsesVia
        ? directionalPadSize / 2 + traceWidth / 2 + clearance + 1e-3
        : Math.max(
            directionalPitch * 0.5,
            directionalPadSize / 2 +
              (targetUsesVia ? viaDiameter : traceWidth) / 2 +
              clearance +
              1e-3,
          )
  const viaAxis =
    getAxis(sourcePoint, bus.direction) +
    directionSign(bus.direction) * initialEscapeDistance
  const viaPerpendicularAxis =
    getPerpendicularAxis(sourcePoint, bus.direction) +
    viaHandedness * perpendicularPitch * 0.5
  return makePoint({
    axis: viaAxis,
    perpendicularAxis: viaPerpendicularAxis,
    direction: bus.direction,
  })
}

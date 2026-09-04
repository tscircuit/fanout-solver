import type { FanoutEdge, PreparedBus } from "./types"

type AdaptiveDensePlaneBus = Pick<
  PreparedBus,
  "componentBounds" | "componentId" | "connections" | "exitEdge" | "termination"
>

function getSourceFieldFacingEdge(
  buses: readonly AdaptiveDensePlaneBus[],
): FanoutEdge | undefined {
  const firstBus = buses[0]
  if (
    !firstBus ||
    buses.some((bus) => bus.componentId !== firstBus.componentId)
  )
    return undefined

  const sourcePoints = buses.flatMap((bus) =>
    bus.connections.map((connection) => connection.sourcePoint),
  )
  if (sourcePoints.length === 0) return undefined

  const center = sourcePoints.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  )
  center.x /= sourcePoints.length
  center.y /= sourcePoints.length

  const { minX, maxX, minY, maxY } = firstBus.componentBounds
  const edgesByDistance = [
    { edge: "left" as const, distance: Math.abs(center.x - minX) },
    { edge: "right" as const, distance: Math.abs(maxX - center.x) },
    { edge: "bottom" as const, distance: Math.abs(center.y - minY) },
    { edge: "top" as const, distance: Math.abs(maxY - center.y) },
  ].toSorted((first, second) => first.distance - second.distance)

  // A centered field has no meaningful source-facing edge. Avoid choosing an
  // orientation from array order when the geometry is ambiguous.
  if (
    Math.abs(edgesByDistance[0]!.distance - edgesByDistance[1]!.distance) <=
    1e-9
  )
    return undefined
  return edgesByDistance[0]!.edge
}

/**
 * Detect a dense memory-controller field that must turn across the component
 * to reach a perpendicular shared breakout edge. This is based on topology
 * and relative geometry, so rotating or mirroring the circuit does not change
 * the choice.
 */
export function shouldUseAdaptiveDensePlaneRouting(
  buses: readonly AdaptiveDensePlaneBus[],
  allowBlindAndBuriedVias: boolean,
): boolean {
  if (allowBlindAndBuriedVias) return false

  const boundaryBuses = buses.filter(
    (bus) => bus.termination.type === "boundary",
  )
  const singletonBoundaryBuses = boundaryBuses.filter(
    (bus) => bus.connections.length === 1,
  )
  const pairBoundaryBuses = boundaryBuses.filter(
    (bus) => bus.connections.length === 2,
  )
  const wideBoundaryBuses = boundaryBuses.filter(
    (bus) => bus.connections.length >= 8,
  )
  const planeCount = buses.filter(
    (bus) => bus.termination.type === "plane" && bus.connections.length === 1,
  ).length
  const sharedExitEdge = wideBoundaryBuses[0]?.exitEdge

  if (
    boundaryBuses.length !== 9 ||
    singletonBoundaryBuses.length !== 3 ||
    pairBoundaryBuses.length !== 3 ||
    wideBoundaryBuses.length !== 3 ||
    planeCount < 64 ||
    sharedExitEdge === undefined ||
    wideBoundaryBuses.some((bus) => bus.exitEdge !== sharedExitEdge)
  )
    return false

  const sourceFacingEdge = getSourceFieldFacingEdge(wideBoundaryBuses)
  if (sourceFacingEdge === undefined) return false
  const sourceFacesHorizontalEdge =
    sourceFacingEdge === "left" || sourceFacingEdge === "right"
  const exitUsesHorizontalEdge =
    sharedExitEdge === "left" || sharedExitEdge === "right"
  return sourceFacesHorizontalEdge !== exitUsesHorizontalEdge
}

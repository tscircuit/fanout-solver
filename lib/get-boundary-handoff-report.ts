import type {
  BoundaryHandoffEndpoint,
  BoundaryHandoffLayerReport,
  BoundaryHandoffReport,
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
} from "./types"

function alongEdge(point: Point2D, direction: FanoutDirection): number {
  return direction === "left" || direction === "right" ? point.y : point.x
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function physicalLayer(plan: FanoutRoutePlan): string {
  return plan.segments.at(-1)?.layer ?? plan.targetLayer
}

function countInversions(requested: string[], actual: string[]): number {
  const requestedIndex = new Map(requested.map((name, index) => [name, index]))
  const ranked = actual.filter((name) => requestedIndex.has(name))
  let inversions = 0
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      if (requestedIndex.get(ranked[i]!)! > requestedIndex.get(ranked[j]!)!) {
        inversions++
      }
    }
  }
  return inversions
}

function minimumAdjacentPitch(values: number[]): number | null {
  if (values.length < 2) return null
  let minimum = Number.POSITIVE_INFINITY
  for (let i = 1; i < values.length; i++) {
    minimum = Math.min(minimum, Math.abs(values[i]! - values[i - 1]!))
  }
  return Number.isFinite(minimum) ? minimum : null
}

/**
 * Report actual boundary exits grouped by physical layer, including
 * requested-vs-actual order, pairwise inversions, and minimum pitch.
 *
 * Callers were reverse-engineering this after a successful solve. The report
 * is a read-only view of existing plans and does not change routing.
 */
export function requestedExitsFromPreparedBuses(
  buses: readonly PreparedBus[],
): Readonly<Record<string, Point2D>> {
  return Object.fromEntries(
    buses.flatMap((bus) =>
      bus.connections
        .filter((connection) => connection.hasExplicitLayeredExitTarget)
        .map((connection) => {
          const requested = connection.exitTargetPoint ?? connection.targetPoint
          return [
            connection.connection.name,
            { x: requested.x, y: requested.y },
          ] as const
        }),
    ),
  )
}

export function getBoundaryHandoffReport(params: {
  plans: readonly FanoutRoutePlan[]
  requestedExits?: Readonly<Record<string, Point2D>>
}): BoundaryHandoffReport {
  const { plans, requestedExits = {} } = params
  const endpoints: BoundaryHandoffEndpoint[] = []

  for (const plan of plans) {
    if (plan.termination.type !== "boundary") continue
    const layer = physicalLayer(plan)
    const requested = requestedExits[plan.connectionName]
    endpoints.push({
      connectionName: plan.connectionName,
      busId: plan.busId,
      layer,
      direction: plan.direction,
      actual: { x: plan.exitPoint.x, y: plan.exitPoint.y },
      ...(requested ? { requested: { x: requested.x, y: requested.y } } : {}),
      alongEdgeActual: alongEdge(plan.exitPoint, plan.direction),
      ...(requested
        ? { alongEdgeRequested: alongEdge(requested, plan.direction) }
        : {}),
      deviationMm: requested ? distance(plan.exitPoint, requested) : null,
    })
  }

  const layerNames = [...new Set(endpoints.map((endpoint) => endpoint.layer))]
  layerNames.sort()

  const layers: BoundaryHandoffLayerReport[] = layerNames.map((layer) => {
    const layerEndpoints = endpoints
      .filter((endpoint) => endpoint.layer === layer)
      .sort((a, b) => {
        const along = a.alongEdgeActual - b.alongEdgeActual
        return along !== 0
          ? along
          : a.connectionName.localeCompare(b.connectionName)
      })

    const requestedOrder = layerEndpoints
      .filter((endpoint) => endpoint.alongEdgeRequested !== undefined)
      .slice()
      .sort((a, b) => {
        const along = (a.alongEdgeRequested ?? 0) - (b.alongEdgeRequested ?? 0)
        return along !== 0
          ? along
          : a.connectionName.localeCompare(b.connectionName)
      })
      .map((endpoint) => endpoint.connectionName)

    const actualOrder = layerEndpoints.map(
      (endpoint) => endpoint.connectionName,
    )
    const inversions = countInversions(requestedOrder, actualOrder)
    const minimumPitchMm = minimumAdjacentPitch(
      layerEndpoints.map((endpoint) => endpoint.alongEdgeActual),
    )

    return {
      layer,
      endpoints: layerEndpoints,
      requestedOrder,
      actualOrder,
      inversionCount: inversions,
      minimumPitchMm,
    }
  })

  const inversionCount = layers.reduce(
    (sum, layer) => sum + layer.inversionCount,
    0,
  )
  const pitches = layers
    .map((layer) => layer.minimumPitchMm)
    .filter((pitch): pitch is number => pitch !== null)

  return {
    layers,
    endpointCount: endpoints.length,
    inversionCount,
    minimumPitchMm: pitches.length > 0 ? Math.min(...pitches) : null,
  }
}

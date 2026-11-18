import type { FanoutDirection, PreparedBus, PreparedConnection } from "../types"
import { getCornerSide, getPerpendicularAxis } from "./directions"
import type { CopperLayer } from "./types"

export function getStableConnectionIdentity(
  connection: PreparedConnection["connection"],
): string {
  if (
    "source_trace_id" in connection &&
    typeof connection.source_trace_id === "string"
  ) {
    return connection.source_trace_id
  }
  return connection.name
}

export function getWindingTargetOrders(params: {
  bus: PreparedBus
  boundaryDirection: FanoutDirection
  layerNames: readonly string[]
  targetLayer: string
}): {
  orders: PreparedConnection[][]
  legacyOrder: PreparedConnection[]
  ordinaryOrderCount: number
} {
  const { bus, boundaryDirection, layerNames, targetLayer } = params
  const legacyOrderedConnections = bus.connections.toSorted((first, second) => {
    const axisDifference =
      getPerpendicularAxis(
        first.exitTargetPoint ?? first.targetPoint,
        boundaryDirection,
      ) -
      getPerpendicularAxis(
        second.exitTargetPoint ?? second.targetPoint,
        boundaryDirection,
      )
    if (axisDifference !== 0) return axisDifference
    return (
      first.connection.name.localeCompare(second.connection.name) ||
      getStableConnectionIdentity(first.connection).localeCompare(
        getStableConnectionIdentity(second.connection),
      ) ||
      layerNames.indexOf(getTargetLayer(first)) -
        layerNames.indexOf(getTargetLayer(second)) ||
      first.connectionIndex - second.connectionIndex
    )
  })
  const connectionsByLayer = new Map<CopperLayer, PreparedConnection[]>()
  for (const candidate of bus.connections) {
    const layer = getTargetLayer(candidate)
    const layerConnections = connectionsByLayer.get(layer) ?? []
    layerConnections.push(candidate)
    connectionsByLayer.set(layer, layerConnections)
  }
  const orderedLayers = [...connectionsByLayer.keys()].toSorted(
    (first, second) =>
      Number(second === targetLayer) - Number(first === targetLayer) ||
      layerNames.indexOf(first) - layerNames.indexOf(second) ||
      first.localeCompare(second),
  )
  const layerOrderByName = new Map(
    orderedLayers.map((layer, layerOrder) => [layer, layerOrder]),
  )
  const rankWithinLayerByConnectionIndex = new Map<number, number>()
  for (const layer of orderedLayers) {
    for (const [rank, candidate] of connectionsByLayer
      .get(layer)!
      .toSorted((first, second) =>
        compareWithinLayer({ first, second }, boundaryDirection),
      )
      .entries()) {
      rankWithinLayerByConnectionIndex.set(candidate.connectionIndex, rank)
    }
  }
  // Winding targets define an order within each copper layer. Their absolute
  // offsets across different layers are not an ordering constraint: unrelated
  // buses can move those layer bands without changing this bus's topology.
  // Build a canonical interleave plus its adjacent linear extensions so a
  // via-minimal search can choose a locally routable merge without violating
  // any same-layer winding order.
  const canonicalOrderedConnections = bus.connections.toSorted(
    (first, second) =>
      (rankWithinLayerByConnectionIndex.get(first.connectionIndex) ?? 0) -
        (rankWithinLayerByConnectionIndex.get(second.connectionIndex) ?? 0) ||
      (layerOrderByName.get(getTargetLayer(first)) ?? 0) -
        (layerOrderByName.get(getTargetLayer(second)) ?? 0) ||
      compareWithinLayer({ first, second }, boundaryDirection),
  )
  const candidateOrders: PreparedConnection[][] = [canonicalOrderedConnections]
  for (let index = 0; index + 1 < canonicalOrderedConnections.length; index++) {
    const first = canonicalOrderedConnections[index]!
    const second = canonicalOrderedConnections[index + 1]!
    if (getTargetLayer(first) === getTargetLayer(second)) continue
    const adjacentExtension = [...canonicalOrderedConnections]
    adjacentExtension[index] = second
    adjacentExtension[index + 1] = first
    candidateOrders.push(adjacentExtension)
  }
  // Retain the coordinate-total-order behavior as a compatibility fallback,
  // but do not let sub-nanometer noise between unrelated layer bands choose
  // the primary topology.
  candidateOrders.push(legacyOrderedConnections)
  const ordinaryOrderCount = new Set(
    candidateOrders.map((order) =>
      order.map((candidate) => candidate.connectionIndex).join(","),
    ),
  ).size
  // Preserve each original layer's lane order while exploring other legal
  // interleavings. Keep this bounded for buses with many source layers.
  if (
    !getCornerSide(bus) &&
    bus.connections.length <= 8 &&
    orderedLayers.length > 1
  ) {
    const layerSequences = orderedLayers.map((layer) =>
      connectionsByLayer
        .get(layer)!
        .toSorted((first, second) =>
          compareWithinLayer({ first, second }, boundaryDirection),
        ),
    )
    const offsets = layerSequences.map(() => 0)
    const current: PreparedConnection[] = []
    appendWindingTargetOrders({
      candidateOrders,
      current,
      connectionCount: bus.connections.length,
      layerSequences,
      offsets,
    })
  }
  const seenOrders = new Set<string>()
  const orders = candidateOrders.filter((order) => {
    const key = order.map((candidate) => candidate.connectionIndex).join(",")
    if (seenOrders.has(key)) return false
    seenOrders.add(key)
    return true
  })
  return { orders, legacyOrder: legacyOrderedConnections, ordinaryOrderCount }
}

export function getWindingTargetRank(params: {
  bus: PreparedBus
  connection: PreparedConnection
  boundaryDirection: FanoutDirection
  layerNames: readonly string[]
  targetLayer: string
  windingOrderIndex?: number
}): { rank: number; connectionCount: number } {
  const { connection, windingOrderIndex = 0 } = params
  const { orders, legacyOrder } = getWindingTargetOrders(params)
  const orderedConnections =
    params.windingOrderIndex === undefined
      ? legacyOrder
      : (orders[windingOrderIndex] ?? orders[0] ?? legacyOrder)
  const rank = orderedConnections.findIndex(
    (candidate) => candidate.connectionIndex === connection.connectionIndex,
  )
  if (rank < 0) {
    throw new Error(
      `FanoutSolver: connection "${connection.connection.name}" is missing from winding order`,
    )
  }
  return { rank, connectionCount: orderedConnections.length }
}

export function getWindingCrossoverLayer(params: {
  bus: PreparedBus
  escapeLayer: string
}): string | undefined {
  const { bus, escapeLayer } = params
  return (bus.routableEscapeLayers ?? bus.allowedLayers)?.find(
    (layer) => layer !== escapeLayer,
  )
}

export function getPointLayer(
  point: PreparedConnection["targetPoint"],
): string {
  const layer = "layer" in point ? point.layer : point.layers[0]
  if (!layer) {
    throw new Error("FanoutSolver: plane endpoint has no copper layer")
  }
  return layer
}

export function getTargetLayer(candidate: PreparedConnection): string {
  return (
    candidate.exitTargetPoint?.layer ?? getPointLayer(candidate.targetPoint)
  )
}
export function compareWithinLayer(
  { first, second }: { first: PreparedConnection; second: PreparedConnection },
  boundaryDirection: FanoutDirection,
): number {
  const axisDifference =
    getPerpendicularAxis(
      first.exitTargetPoint ?? first.targetPoint,
      boundaryDirection,
    ) -
    getPerpendicularAxis(
      second.exitTargetPoint ?? second.targetPoint,
      boundaryDirection,
    )
  if (axisDifference !== 0) return axisDifference

  const firstStableId = getStableConnectionIdentity(first.connection)
  const secondStableId = getStableConnectionIdentity(second.connection)
  const stableIdentityDifference = firstStableId.localeCompare(secondStableId)
  if (stableIdentityDifference !== 0) return stableIdentityDifference

  return (
    first.connection.name.localeCompare(second.connection.name) ||
    first.connectionIndex - second.connectionIndex
  )
}

export function appendWindingTargetOrders({
  candidateOrders,
  current,
  connectionCount,
  layerSequences,
  offsets,
}: {
  candidateOrders: PreparedConnection[][]
  current: PreparedConnection[]
  connectionCount: number
  layerSequences: PreparedConnection[][]
  offsets: number[]
}): void {
  if (candidateOrders.length >= 128) return
  if (current.length === connectionCount) {
    candidateOrders.push([...current])
    return
  }
  for (let layer = 0; layer < layerSequences.length; layer++) {
    const offset = offsets[layer]!
    const next = layerSequences[layer]![offset]
    if (!next) continue
    offsets[layer] = offset + 1
    current.push(next)
    appendWindingTargetOrders({
      candidateOrders,
      current,
      connectionCount,
      layerSequences,
      offsets,
    })
    current.pop()
    offsets[layer] = offset
  }
}

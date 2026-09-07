import type { Point2D, PreparedBus } from "./types"

/**
 * A peripheral source field turning into an exit interval narrower than its
 * via envelope benefits from choosing the first vias together. Restrict this
 * choice to competing wide buses that also permit an internal transit layer;
 * narrow pairs and ordinary, separated boundary intervals keep their routing.
 */
export function hasCompressedExitConvergence(params: {
  buses: readonly PreparedBus[]
  targetLayer: string
  exits: ReadonlyMap<number, Point2D>
  layerNames: readonly string[]
  viaDiameter: number
  clearance: number
}): boolean {
  const { buses, targetLayer, exits, layerNames, viaDiameter, clearance } =
    params
  const first = buses[0]
  if (
    !first?.exitEdge ||
    buses.length < 2 ||
    buses.some(
      (bus) =>
        bus.termination.type !== "boundary" ||
        bus.connections.length <= 2 ||
        bus.componentId !== first.componentId ||
        bus.exitEdge !== first.exitEdge ||
        bus.connections.some((connection) => connection.sourceLayer !== "top"),
    )
  )
    return false
  const allowed = (bus: PreparedBus) =>
    bus.routableEscapeLayers ?? bus.allowedLayers ?? layerNames
  if (
    targetLayer === "top" ||
    buses.some((bus) => !allowed(bus).includes(targetLayer)) ||
    !layerNames.some(
      (layer) =>
        layer !== "top" &&
        layer !== targetLayer &&
        buses.every((bus) => allowed(bus).includes(layer)),
    )
  )
    return false

  const connections = buses.flatMap((bus) => bus.connections)
  const tangent =
    first.exitEdge === "left" || first.exitEdge === "right" ? "y" : "x"
  const tracks = connections.map(
    (connection) => exits.get(connection.connectionIndex)?.[tangent],
  )
  if (tracks.some((track) => track === undefined || !Number.isFinite(track)))
    return false
  const span =
    Math.max(...(tracks as number[])) - Math.min(...(tracks as number[]))
  if (span >= (connections.length - 1) * (viaDiameter + clearance) - 1e-8)
    return false

  const center = connections.reduce(
    (sum, connection) => ({
      x: sum.x + connection.sourcePoint.x / connections.length,
      y: sum.y + connection.sourcePoint.y / connections.length,
    }),
    { x: 0, y: 0 },
  )
  const bounds = first.componentBounds
  const xDistance = Math.min(
    Math.abs(center.x - bounds.minX),
    Math.abs(center.x - bounds.maxX),
  )
  const yDistance = Math.min(
    Math.abs(center.y - bounds.minY),
    Math.abs(center.y - bounds.maxY),
  )
  // Compare axes, so rotating or reflecting the complete circuit preserves
  // the decision. A centered or corner-balanced field has no preferred axis.
  return tangent === "x"
    ? xDistance + 1e-8 < yDistance
    : yDistance + 1e-8 < xDistance
}

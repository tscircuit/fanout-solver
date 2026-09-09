import type { Point2D, PreparedBus } from "./types"

/**
 * Select a constrained pair group whose fixed source escapes repeatedly send
 * paired lanes in opposite directions. A remote via beyond the far component
 * edge makes its lane return across the package, while its local mate already
 * advances toward the exit. Choose first vias jointly when multiple pairs
 * have this geometry; a lone affected pair keeps the ordinary routing path.
 */
export function hasOpposedPairSourceEscapes(params: {
  buses: readonly PreparedBus[]
  fixedViaPointsByConnectionIndex: ReadonlyMap<number, Point2D>
  clearance: number
}): boolean {
  const { buses, fixedViaPointsByConnectionIndex: sites, clearance } = params
  const first = buses[0]
  if (
    !first?.exitEdge ||
    buses.some(
      (bus) =>
        bus.componentId !== first.componentId ||
        bus.exitEdge !== first.exitEdge ||
        bus.termination.type !== "boundary" ||
        bus.connections.length > 2 ||
        bus.allowedLayers?.length !== 1 ||
        bus.allowedLayers[0] === "top" ||
        bus.connections.some((connection) => connection.sourceLayer !== "top"),
    )
  )
    return false
  const normal =
    first.exitEdge === "left" || first.exitEdge === "right" ? "x" : "y"
  const sign = first.exitEdge === "top" || first.exitEdge === "right" ? 1 : -1
  let opposedPairs = 0
  for (const bus of buses) {
    if (
      bus.connections.length !== 2 ||
      bus.maxLengthSkew === undefined ||
      bus.maxLengthSkew >= Math.min(bus.pitchX, bus.pitchY)
    )
      continue
    const bounds = bus.componentBounds
    const oppositeEdge =
      normal === "x"
        ? sign > 0
          ? bounds.minX
          : bounds.maxX
        : sign > 0
          ? bounds.minY
          : bounds.maxY
    const pair = bus.connections.map((connection) => ({
      source: connection.sourcePoint,
      via: sites.get(connection.connectionIndex),
    }))
    if (
      pair.some((far, index) => {
        const local = pair[1 - index]!
        if (!far.via || !local.via) return false
        return (
          sign * (far.via[normal] - oppositeEdge) < -1e-7 &&
          local.via.x >= bounds.minX &&
          local.via.x <= bounds.maxX &&
          local.via.y >= bounds.minY &&
          local.via.y <= bounds.maxY &&
          sign * (local.via[normal] - local.source[normal]) > clearance
        )
      })
    )
      opposedPairs++
  }
  return opposedPairs >= 2
}

/** Preserve layer-group boundaries when inspecting the initial source map. */
export function getOpposedPairSourceGroups(params: {
  groups: readonly (readonly PreparedBus[])[]
  fixedViaPointsByConnectionIndex: ReadonlyMap<number, Point2D>
  clearance: number
}): readonly (readonly PreparedBus[])[] {
  return params.groups.filter((buses) =>
    hasOpposedPairSourceEscapes({ ...params, buses }),
  )
}

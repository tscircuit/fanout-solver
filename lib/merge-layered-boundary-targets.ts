import type { Point2D, PreparedBus, PreparedConnection } from "./types"

interface Params {
  buses: readonly PreparedBus[]
  exits: ReadonlyMap<number, Point2D>
  /** Bounds the product of the original layer-sequence lengths. */
  maximumSearchStates?: number
}

function targetLayer(connection: PreparedConnection): string {
  if (connection.exitTargetPoint)
    return connection.exitTargetPoint.layer ?? "top"
  const target = connection.targetPoint
  return "layer" in target
    ? (target.layer ?? "top")
    : (target.layers[0] ?? "top")
}

function layerSequences(bus: PreparedBus) {
  const axis = bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
  const groups = new Map<string, PreparedConnection[]>()
  for (const connection of bus.connections) {
    const layer = targetLayer(connection)
    groups.set(layer, [...(groups.get(layer) ?? []), connection])
  }
  return [...groups.values()].map((connections) =>
    connections.toSorted((a, b) => {
      const delta =
        (a.exitTargetPoint ?? a.targetPoint)[axis] -
        (b.exitTargetPoint ?? b.targetPoint)[axis]
      if (delta !== 0) return delta
      const identity = (c: PreparedConnection) =>
        "source_trace_id" in c.connection &&
        typeof c.connection.source_trace_id === "string"
          ? c.connection.source_trace_id
          : c.connection.name
      return (
        identity(a).localeCompare(identity(b)) ||
        a.connection.name.localeCompare(b.connection.name) ||
        a.connectionIndex - b.connectionIndex
      )
    }),
  )
}

/** Different original target layers may interleave; each layer retains its lane order. */
export function boundaryTargetsPreserveLayerOrder(
  bus: PreparedBus,
  exits: ReadonlyMap<number, Point2D>,
): boolean {
  const axis = bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
  return layerSequences(bus).every((connections) =>
    connections.every((connection, index) => {
      const point = exits.get(connection.connectionIndex)
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        return false
      return (
        index === 0 ||
        point[axis] > exits.get(connections[index - 1]!.connectionIndex)![axis]
      )
    }),
  )
}

/** Select a legal merge with fewer source-order inversions, retaining every packed track. */
export function mergeLayeredBoundaryTargets(
  params: Params,
): Map<number, Point2D> {
  const maximumStates = params.maximumSearchStates ?? 4096
  if (!Number.isSafeInteger(maximumStates) || maximumStates < 1)
    throw new Error("FanoutSolver: invalid boundary merge work bound")
  const exits = new Map(params.exits)
  for (const bus of params.buses) {
    if (
      bus.termination.type !== "boundary" ||
      !bus.exitEdge ||
      bus.connections.length < 3
    )
      continue
    // Unlayered endpoint coordinates do not grant freedom to change lane order.
    if (bus.connections.some((c) => !c.hasExplicitLayeredExitTarget)) continue
    const sequences = layerSequences(bus)
    if (sequences.length < 2) continue
    const stateCount = sequences.reduce(
      (count, sequence) => count * (sequence.length + 1),
      1,
    )
    if (stateCount > maximumStates) continue
    const axis =
        bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x",
      normal = axis === "x" ? "y" : "x",
      sign = bus.exitEdge === "left" || bus.exitEdge === "bottom" ? -1 : 1,
      center = {
        x: (bus.componentBounds.minX + bus.componentBounds.maxX) / 2,
        y: (bus.componentBounds.minY + bus.componentBounds.maxY) / 2,
      }
    const angle = new Map(
      bus.connections.map((c) => [
        c.connectionIndex,
        Math.atan2(
          c.sourcePoint[axis] - center[axis],
          sign * (c.sourcePoint[normal] - center[normal]),
        ),
      ]),
    )
    const tracks = bus.connections
      .map((connection) => {
        const point = exits.get(connection.connectionIndex)
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
          throw new Error("FanoutSolver: missing packed boundary target")
        return point[axis]
      })
      .sort((a, b) => a - b)
    if (tracks.some((track, index) => index > 0 && track <= tracks[index - 1]!))
      throw new Error("FanoutSolver: duplicate packed boundary tracks")
    interface Choice {
      inversions: number
      length: number
      order: PreparedConnection[]
    }
    const memo = new Map<string, Choice>()
    const visit = (offsets: number[]): Choice => {
      const key = offsets.join(","),
        cached = memo.get(key)
      if (cached) return cached
      const index = offsets.reduce((sum, offset) => sum + offset, 0)
      if (index === tracks.length)
        return { inversions: 0, length: 0, order: [] }
      let best: Choice | undefined
      for (const [layer, sequence] of sequences.entries()) {
        const connection = sequence[offsets[layer]!]
        if (!connection) continue
        const inversions = sequences.reduce(
          (sum, group, j) =>
            sum +
            group
              .slice(0, offsets[j])
              .filter(
                (c) =>
                  angle.get(c.connectionIndex)! >
                  angle.get(connection.connectionIndex)! + 1e-9,
              ).length,
          0,
        )
        const next = [...offsets]
        next[layer]!++
        const tail = visit(next),
          target = {
            ...exits.get(connection.connectionIndex)!,
            [axis]: tracks[index]!,
          }
        const choice: Choice = {
          inversions: inversions + tail.inversions,
          length:
            Math.hypot(
              connection.sourcePoint.x - target.x,
              connection.sourcePoint.y - target.y,
            ) + tail.length,
          order: [connection, ...tail.order],
        }
        if (
          !best ||
          choice.inversions < best.inversions ||
          (choice.inversions === best.inversions && choice.length < best.length)
        )
          best = choice
      }
      if (!best)
        throw new Error("FanoutSolver: incomplete boundary merge state")
      memo.set(key, best)
      return best
    }
    const candidate = new Map(exits)
    for (const [index, connection] of visit(
      sequences.map(() => 0),
    ).order.entries())
      candidate.set(connection.connectionIndex, {
        ...exits.get(connection.connectionIndex)!,
        [axis]: tracks[index]!,
      })
    if (!boundaryTargetsPreserveLayerOrder(bus, candidate))
      throw new Error(
        "FanoutSolver: boundary merge changed a layer's lane order",
      )
    for (const connection of bus.connections)
      exits.set(
        connection.connectionIndex,
        candidate.get(connection.connectionIndex)!,
      )
  }
  return exits
}

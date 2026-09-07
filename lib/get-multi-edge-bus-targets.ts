import {
  packBoundaryBusIntervals,
  type PackedBoundaryBusInterval,
} from "./pack-boundary-bus-intervals"
import type { LayerReservedBusesParams } from "./route-layer-reserved-buses"
import { mergeLayeredBoundaryTargets } from "./merge-layered-boundary-targets"
import type { Point2D, PreparedBus } from "./types"

const boundaryPoint = (bus: PreparedBus, track: number): Point2D => {
  const bounds = bus.sharedBoundary
  switch (bus.exitEdge) {
    case "left":
      return { x: bounds.minX, y: track }
    case "right":
      return { x: bounds.maxX, y: track }
    case "top":
      return { x: track, y: bounds.maxY }
    case "bottom":
      return { x: track, y: bounds.minY }
    default:
      throw new Error(`FanoutSolver: bus ${bus.busId} has no boundary edge`)
  }
}

function crosses(a: Point2D, b: Point2D, c: Point2D, d: Point2D) {
  const side = (p: Point2D, q: Point2D, r: Point2D) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return (
    side(a, b, c) * side(a, b, d) < -1e-12 &&
    side(c, d, a) * side(c, d, b) < -1e-12
  )
}

/** Assign intact buses before packing a package's independent boundary edges.
 * Constrained buses reserve capacity first; flexible buses account for every
 * earlier assignment instead of all choosing the same otherwise empty layer.
 */
export function getMultiEdgeBusTargets(params: LayerReservedBusesParams) {
  const { buses, layerNames, traceWidth, clearance } = params
  const pitch = traceWidth + clearance
  const targetLayerByBusId = new Map<string, string>()
  const choices: Array<{
    bus: PreparedBus
    source: Point2D
    intervals: PackedBoundaryBusInterval[]
  }> = []
  for (const bus of buses) {
    if (bus.termination.type === "plane") {
      targetLayerByBusId.set(bus.busId, bus.termination.layer)
      continue
    }
    const sourceLayers = new Set(bus.connections.map((c) => c.sourceLayer))
    const layers = (
      bus.routableEscapeLayers ??
      bus.allowedLayers ??
      layerNames
    ).filter((layer) => !sourceLayers.has(layer))
    if (!layers.length) return null
    const intervals = layers.map(
      (layer) =>
        packBoundaryBusIntervals({
          ...params,
          buses: [bus],
          targetLayerByBusId: new Map([[bus.busId, layer]]),
        }).intervals[0]!,
    )
    const count = bus.connections.length
    const source = bus.connections.reduce(
      (point, connection) => ({
        x: point.x + connection.sourcePoint.x / count,
        y: point.y + connection.sourcePoint.y / count,
      }),
      { x: 0, y: 0 },
    )
    choices.push({ bus, source, intervals })
  }
  choices.sort(
    (a, b) =>
      a.intervals.length - b.intervals.length ||
      Math.max(...b.intervals.map((i) => i.end - i.start)) -
        Math.max(...a.intervals.map((i) => i.end - i.start)) ||
      b.bus.connections.length - a.bus.connections.length,
  )
  const assigned: Array<{
    bus: PreparedBus
    source: Point2D
    target: Point2D
    interval: PackedBoundaryBusInterval
  }> = []
  for (const { bus, source, intervals } of choices) {
    let best: { interval: PackedBoundaryBusInterval; score: number } | undefined
    for (const interval of intervals) {
      const sameLayer = assigned.filter(
        (a) => a.interval.layer === interval.layer,
      )
      const sameEdge = sameLayer.filter(
        (a) => a.interval.edge === interval.edge,
      )
      const minimum = Math.max(
        interval.minimum,
        ...sameEdge.map((a) => a.interval.minimum),
      )
      const maximum = Math.min(
        interval.maximum,
        ...sameEdge.map((a) => a.interval.maximum),
      )
      const occupied =
        interval.end -
        interval.start +
        sameEdge.reduce(
          (sum, a) => sum + a.interval.end - a.interval.start + pitch,
          0,
        )
      if (occupied > maximum - minimum + 1e-8) continue
      const target = boundaryPoint(bus, (interval.start + interval.end) / 2)
      const crossingLoad = sameLayer.reduce(
        (sum, other) =>
          sum +
          (crosses(source, target, other.source, other.target)
            ? Math.min(bus.connections.length, other.bus.connections.length)
            : 0),
        0,
      )
      const edgeLoad = sameEdge.reduce(
        (sum, a) => sum + a.bus.connections.length,
        0,
      )
      const totalLoad = sameLayer.reduce(
        (sum, a) => sum + a.bus.connections.length,
        0,
      )
      const score =
        crossingLoad * 4 +
        edgeLoad +
        totalLoad / 4 +
        (10 * occupied) / Math.max(pitch, maximum - minimum)
      if (
        !best ||
        score < best.score ||
        (score === best.score &&
          layerNames.indexOf(interval.layer) >
            layerNames.indexOf(best.interval.layer))
      )
        best = { interval, score }
    }
    if (!best) return null
    targetLayerByBusId.set(bus.busId, best.interval.layer)
    assigned.push({
      bus,
      source,
      interval: best.interval,
      target: boundaryPoint(bus, (best.interval.start + best.interval.end) / 2),
    })
  }
  const packed = packBoundaryBusIntervals({ ...params, targetLayerByBusId })
  const exits = new Map<number, Point2D>()
  for (const { bus } of choices)
    for (const connection of bus.connections)
      exits.set(
        connection.connectionIndex,
        boundaryPoint(
          bus,
          packed.tracksByConnectionIndex.get(connection.connectionIndex)!,
        ),
      )
  return {
    targetLayerByBusId,
    exits: mergeLayeredBoundaryTargets({ buses, exits }),
  }
}

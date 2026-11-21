import { fitLocalViaGrid } from "./fit-local-via-grid"
import type {
  SimpleRouteJson,
  SimpleRouteConnection,
} from "@tscircuit/capacity-autorouter"
import { distancePointToObstacle } from "./geometry"
import { prepareFanoutBuses } from "./prepare-buses"
import {
  candidatesAreMutuallyClear,
  matchDogboneViaSites,
} from "./match-component-dogbone-via-sites"
import {
  getCopperLayerNames,
  getViaSpanLayers,
  getRouteViaSpanLayers,
} from "./layer-names"
import type {
  Bounds,
  FanoutSimplifiedPcbTrace,
  FanoutBusSpec,
  Point2D,
  RoutedSegment,
} from "./types"

export interface LocalSignalDogboneOptions {
  targetLayers: ReadonlyMap<SimpleRouteConnection["name"], string>
  viaDiameter: number
  viaHoleDiameter: number
  traceWidth: number
  clearance: number
  holeToHoleClearance?: number
  boardEdgeClearance?: number
}

function outlineMatchesBounds(outline: readonly Point2D[], bounds: Bounds) {
  const [first, second, third, fourth, closing] = outline
  if (!first || !second || !third || !fourth || outline.length > 5) return false
  if (closing && (closing.x !== first.x || closing.y !== first.y)) return false

  const corners = [first, second, third, fourth]
  return corners.every((corner, index) => {
    const next = corners[(index + 1) % corners.length]!
    const opposite = corners[(index + 2) % corners.length]!
    return (
      (corner.x === bounds.minX || corner.x === bounds.maxX) &&
      (corner.y === bounds.minY || corner.y === bounds.maxY) &&
      (corner.x === next.x || corner.y === next.y) &&
      corner.x !== opposite.x &&
      corner.y !== opposite.y
    )
  })
}

/** Local signal escapes in board-world mm (+X right, +Y up). All geometry is
 * points, not directions. Signals remain unresolved at the returned handoffs;
 * no shared-boundary routing or plane termination is performed. Input is immutable.
 * The SRJ allowBlindAndBuriedVias flag is authoritative and defaults to false;
 * neither routing options nor supplied via metadata enable the capability. */
export function routeLocalSignalDogbones(
  input: SimpleRouteJson & { allowBlindAndBuriedVias?: boolean },
  options: LocalSignalDogboneOptions,
) {
  const allowBlindAndBuriedVias = input.allowBlindAndBuriedVias ?? false
  const connections = structuredClone(input.connections)
  const endpoints: Array<{ connectionIndex: number; pointIndex: number }> = []
  const virtualConnections: SimpleRouteConnection[] = []
  const buses: FanoutBusSpec[] = []
  const layers = getCopperLayerNames(input.layerCount)
  for (const [connectionIndex, connection] of connections.entries()) {
    const target = options.targetLayers.get(connection.name)
    if (!target || !layers.includes(target))
      throw Error(`Missing or invalid target layer for ${connection.name}`)
    if (connection.pointsToConnect.length !== 2)
      throw Error(`${connection.name}: two terminals required`)
    for (const [pointIndex, point] of connection.pointsToConnect.entries()) {
      if ("layer" in point) {
        if (point.layer === target) continue
      } else if (point.layers.includes(target)) {
        const { layers: _layers, ...metadata } = point
        connection.pointsToConnect[pointIndex] = { ...metadata, layer: target }
        continue
      }
      const sourceObstacle = input.obstacles.find(
        (o) =>
          o.componentId &&
          distancePointToObstacle(point, o) < 1e-8 &&
          o.connectedTo.some(
            (id) =>
              id === point.pcb_port_id ||
              id === point.pointId ||
              id === connection.name,
          ),
      )
      if (!sourceObstacle?.componentId)
        throw Error(
          `${connection.name}: local dogbone requires a component pad terminal`,
        )
      const name = `dogbone_endpoint_${endpoints.length}`
      endpoints.push({ connectionIndex, pointIndex })
      virtualConnections.push({
        ...connection,
        name,
        pointsToConnect: [point, connection.pointsToConnect[1 - pointIndex]!],
      })
      buses.push({
        busId: name,
        connectionNames: [name],
        sourceComponentId: sourceObstacle.componentId,
      })
    }
  }
  if (!endpoints.length)
    return { connections, traces: [] as FanoutSimplifiedPcbTrace[] }
  const prepared = prepareFanoutBuses(
    { ...input, connections: virtualConnections, buses: [] },
    { buses },
  )
  // Imported pad grids can differ by sub-micron rounding between rows. Cluster
  // candidate grid coordinates only; physical pads and terminals stay unchanged.
  for (const bus of prepared) {
    const tolerance =
      Math.min(...bus.componentObstacles.flatMap((o) => [o.width, o.height])) /
      100
    const cluster = (values: number[]) => {
      const groups: number[][] = []
      for (const value of [...values].sort((a, b) => a - b)) {
        if (groups.length && value - groups.at(-1)![0]! < tolerance)
          groups.at(-1)!.push(value)
        else groups.push([value])
      }
      return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length)
    }
    bus.xCoordinates = cluster(bus.xCoordinates)
    bus.yCoordinates = cluster(bus.yCoordinates)
    const pitch = (coordinates: number[], fallback: number) =>
      coordinates.length > 1
        ? Math.min(...coordinates.slice(1).map((v, i) => v - coordinates[i]!))
        : fallback
    bus.pitchX = pitch(bus.xCoordinates, bus.pitchX)
    bus.pitchY = pitch(bus.yCoordinates, bus.pitchY)
    const fillMissingRows = (coordinates: number[], step: number) =>
      coordinates.flatMap((value, i) => {
        if (i === coordinates.length - 1) return [value]
        const gap = coordinates[i + 1]! - value,
          count = Math.max(1, Math.round(gap / step))
        // Only infer omitted rows when the gap is an integer multiple of pitch.
        if (Math.abs(gap / count - step) > tolerance) return [value]
        return Array.from(
          { length: count },
          (_, j) => value + (gap * j) / count,
        )
      })
    bus.xCoordinates = fillMissingRows(bus.xCoordinates, bus.pitchX)
    bus.yCoordinates = fillMissingRows(bus.yCoordinates, bus.pitchY)
    const xGrid = fitLocalViaGrid(bus.xCoordinates, tolerance)
    const yGrid = fitLocalViaGrid(bus.yCoordinates, tolerance)
    if (xGrid) {
      bus.xCoordinates = xGrid.coordinates
      bus.pitchX = xGrid.pitch
    }
    if (yGrid) {
      bus.yCoordinates = yGrid.coordinates
      bus.pitchY = yGrid.pitch
    }
  }
  const blockingSegments: Array<{
    connectionIndex: number
    segment: RoutedSegment
  }> = []
  const blockingVias: Array<{
    connectionIndex: number
    center: { x: number; y: number }
    diameter: number
    spanLayers: string[]
  }> = []
  const fixedTraces: readonly FanoutSimplifiedPcbTrace[] = input.traces ?? []
  for (const trace of fixedTraces) {
    for (const [i, point] of trace.route.entries()) {
      if (point.route_type === "via") {
        blockingVias.push({
          connectionIndex: -1,
          center: point,
          diameter: point.via_diameter ?? options.viaDiameter,
          spanLayers: getRouteViaSpanLayers({
            fromLayer: point.from_layer,
            toLayer: point.to_layer,
            layers: point.layers,
            layerNames: layers,
            allowBlindAndBuriedVias,
          }),
        })
        const next = trace.route[i + 1]
        if (next?.route_type === "wire")
          blockingSegments.push({
            connectionIndex: -1,
            segment: {
              start: point,
              end: next,
              layer: next.layer,
              width: next.width,
            },
          })
      } else if (point.route_type === "wire") {
        const next = trace.route[i + 1]
        if (next?.route_type === "wire")
          blockingSegments.push({
            connectionIndex: -1,
            segment: {
              start: point,
              end: next,
              layer: point.layer,
              width: point.width,
            },
          })
        else if (next?.route_type === "via")
          blockingSegments.push({
            connectionIndex: -1,
            segment: {
              start: point,
              end: next,
              layer: point.layer,
              width: point.width,
            },
          })
      } else
        throw Error("Unsupported fixed copper primitive for local dogbones")
    }
  }
  const allPrepared = prepared.flatMap((bus) => bus.connections)
  const preparedByIndex = new Map(
    allPrepared.map((connection) => [connection.connectionIndex, connection]),
  )
  const viaLayersByConnectionIndex = new Map(
    endpoints.map((endpoint, index) => {
      const connection = connections[endpoint.connectionIndex]!
      const source = preparedByIndex.get(index)!
      return [
        index,
        getViaSpanLayers({
          fromLayer: source.sourceLayer,
          toLayer: options.targetLayers.get(connection.name)!,
          layerNames: layers,
          allowBlindAndBuriedVias,
        }),
      ] as const
    }),
  )
  const margin = options.viaDiameter / 2 + (options.boardEdgeClearance ?? 0)
  const viaBounds = {
    minX: input.bounds.minX + margin,
    maxX: input.bounds.maxX - margin,
    minY: input.bounds.minY + margin,
    maxY: input.bounds.maxY - margin,
  }
  let rectangularViaBounds: Bounds | undefined
  // An inset rectangle is sufficient only when it matches the board outline.
  if (
    !input.outline?.length ||
    outlineMatchesBounds(input.outline, input.bounds)
  ) {
    rectangularViaBounds = viaBounds
  }
  const geometryRules = {
    viaLayersByConnectionIndex,
    viaDiameter: options.viaDiameter,
    viaHoleDiameter: options.viaHoleDiameter,
    traceWidth: options.traceWidth,
    clearance: options.clearance,
    holeToHoleClearance: options.holeToHoleClearance,
    additionalObstacles: input.obstacles,
    blockingSegments,
    blockingVias,
  }
  const sites = matchDogboneViaSites(prepared, {
    ...geometryRules,
    localSignal: { rectangularViaBounds },
  })
  if (!sites) throw Error("No collision-free local dogbone assignment")
  // The matcher works component by component. Check interactions across those
  // assignments too: through vias can collide even on different signal layers.
  const assigned = allPrepared.map(
    ({ connectionIndex, sourcePoint, sourceLayer }) => {
      const point = sites.get(connectionIndex)!
      return {
        connectionIndex,
        point,
        viaLayers: viaLayersByConnectionIndex.get(connectionIndex)!,
        sourceSegment: {
          start: sourcePoint,
          end: point,
          layer: sourceLayer,
          width: options.traceWidth,
        },
      }
    },
  )
  for (const [index, first] of assigned.entries())
    for (let previousIndex = 0; previousIndex < index; previousIndex++) {
      if (
        !candidatesAreMutuallyClear({
          first,
          second: assigned[previousIndex]!,
          rules: geometryRules,
        })
      )
        throw Error("Local dogbones collide between components")
    }
  const traces: FanoutSimplifiedPcbTrace[] = []
  for (const [endpointIndex, endpoint] of endpoints.entries()) {
    const connection = connections[endpoint.connectionIndex]!
    const source = connection.pointsToConnect[endpoint.pointIndex]!
    const preparedConnection = preparedByIndex.get(endpointIndex)!
    const fromLayer = preparedConnection.sourceLayer
    const toLayer = options.targetLayers.get(connection.name)!
    const site = sites.get(endpointIndex)!
    if (
      site.x < viaBounds.minX ||
      site.x > viaBounds.maxX ||
      site.y < viaBounds.minY ||
      site.y > viaBounds.maxY
    )
      throw Error(`${connection.name}: dogbone outside board bounds`)
    const span = viaLayersByConnectionIndex.get(endpointIndex)!
    traces.push({
      type: "pcb_trace",
      pcb_trace_id: `local_dogbone_${connection.name}_${endpoint.pointIndex}`,
      connection_name: connection.name,
      route: [
        {
          route_type: "wire",
          x: source.x,
          y: source.y,
          layer: fromLayer,
          width: options.traceWidth,
        },
        {
          route_type: "wire",
          ...site,
          layer: fromLayer,
          width: options.traceWidth,
        },
        {
          route_type: "via",
          ...site,
          from_layer: fromLayer,
          to_layer: toLayer,
          layers: span,
          via_diameter: options.viaDiameter,
          via_hole_diameter: options.viaHoleDiameter,
        },
        {
          route_type: "wire",
          ...site,
          layer: toLayer,
          width: options.traceWidth,
        },
      ],
    })
    connection.pointsToConnect[endpoint.pointIndex] = {
      ...site,
      layer: toLayer,
    }
  }
  return { connections, traces }
}

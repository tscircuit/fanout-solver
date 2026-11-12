import { getViaToViaClearance } from "./get-via-to-via-clearance"
import { fitLocalViaGrid } from "./fit-local-via-grid"
import type {
  SimpleRouteJson,
  SimpleRouteConnection,
} from "@tscircuit/capacity-autorouter"
import {
  distancePointToObstacle,
  distance,
  distancePointToSegment,
  segmentsAreClear,
} from "./geometry"
import { prepareFanoutBuses } from "./prepare-buses"
import {
  matchComponentDogboneViaSites,
  getComponentDogboneViaSiteCandidates,
} from "./match-component-dogbone-via-sites"
import {
  getCopperLayerNames,
  getViaSpanLayers,
  getRouteViaSpanLayers,
} from "./layer-names"
import type {
  FanoutSimplifiedPcbTrace,
  FanoutBusSpec,
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
      const available = "layer" in point ? [point.layer] : point.layers
      if (available.includes(target)) {
        const { layers: _layers, ...metadata } = point as typeof point & {
          layers?: string[]
        }
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
  for (const trace of input.traces ?? []) {
    for (const [i, point] of trace.route.entries()) {
      if (point.route_type === "via") {
        blockingVias.push({
          connectionIndex: -1,
          center: point,
          diameter: point.via_diameter ?? options.viaDiameter,
          spanLayers: getRouteViaSpanLayers({
            fromLayer: point.from_layer,
            toLayer: point.to_layer,
            layers: (point as typeof point & { layers?: string[] }).layers,
            layerNames: layers,
            allowBlindAndBuriedVias: allowBlindAndBuriedVias,
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
  const viaLayersByConnectionIndex = new Map(
    endpoints.map((endpoint, index) => {
      const connection = connections[endpoint.connectionIndex]!
      const source = allPrepared.find((c) => c.connectionIndex === index)!
      return [
        index,
        getViaSpanLayers({
          fromLayer: source.sourceLayer,
          toLayer: options.targetLayers.get(connection.name)!,
          layerNames: layers,
          allowBlindAndBuriedVias: allowBlindAndBuriedVias,
        }),
      ] as const
    }),
  )
  const viaToViaClearance = getViaToViaClearance(input, options.clearance)
  const geometryRules = {
    viaToViaClearance,
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
  const candidates = getComponentDogboneViaSiteCandidates(
    prepared,
    geometryRules,
  )
  const preferredViaPointsByConnectionIndex = new Map<
    number,
    { x: number; y: number }
  >()
  // A consistent interstitial quadrant avoids opposing stubs competing for
  // the same via site. These are preferences, not forced assignments.
  for (const connection of prepared.flatMap((b) => b.connections)) {
    const choices = candidates.filter(
      (c) => c.connectionIndex === connection.connectionIndex,
    )
    const origin = connection.sourcePoint
    const rank = (p: { x: number; y: number }) =>
      Number(p.x < origin.x) * 2 +
      Number(p.y > origin.y) * 2 +
      Math.hypot(p.x - origin.x, p.y - origin.y)
    choices.sort((a, b) => rank(a.point) - rank(b.point))
    if (choices[0])
      preferredViaPointsByConnectionIndex.set(
        connection.connectionIndex,
        choices[0].point,
      )
  }
  const sites = matchComponentDogboneViaSites(prepared, {
    ...geometryRules,
    preferredViaPointsByConnectionIndex,
  })
  if (!sites) throw Error("No collision-free local dogbone assignment")
  // The matcher works component by component. Check interactions across those
  // assignments too: through vias can collide even on different signal layers.
  for (let i = 0; i < allPrepared.length; i++)
    for (let j = 0; j < i; j++) {
      const a = allPrepared[i]!,
        b = allPrepared[j]!,
        p = sites.get(a.connectionIndex)!,
        q = sites.get(b.connectionIndex)!
      const stubA = {
        start: a.sourcePoint,
        end: p,
        layer: a.sourceLayer,
        width: options.traceWidth,
      }
      const stubB = {
        start: b.sourcePoint,
        end: q,
        layer: b.sourceLayer,
        width: options.traceWidth,
      }
      const viaSeparation = Math.max(
        options.viaDiameter + viaToViaClearance,
        options.viaHoleDiameter +
          (options.holeToHoleClearance ?? options.clearance),
      )
      const viaTrace =
        options.viaDiameter / 2 + options.traceWidth / 2 + options.clearance
      if (
        (viaLayersByConnectionIndex
          .get(a.connectionIndex)!
          .some((layer) =>
            viaLayersByConnectionIndex.get(b.connectionIndex)!.includes(layer),
          ) &&
          distance(p, q) < viaSeparation - 1e-9) ||
        (viaLayersByConnectionIndex
          .get(a.connectionIndex)!
          .includes(stubB.layer) &&
          distancePointToSegment(p, stubB.start, stubB.end) <
            viaTrace - 1e-9) ||
        (viaLayersByConnectionIndex
          .get(b.connectionIndex)!
          .includes(stubA.layer) &&
          distancePointToSegment(q, stubA.start, stubA.end) <
            viaTrace - 1e-9) ||
        (a.sourceLayer === b.sourceLayer &&
          !segmentsAreClear(stubA, stubB, options.clearance))
      )
        throw Error("Local dogbones collide between components")
    }
  const traces: FanoutSimplifiedPcbTrace[] = []
  for (const [endpointIndex, endpoint] of endpoints.entries()) {
    const connection = connections[endpoint.connectionIndex]!
    const source = connection.pointsToConnect[endpoint.pointIndex]!
    const preparedConnection = prepared
      .flatMap((b) => b.connections)
      .find((c) => c.connectionIndex === endpointIndex)!
    const fromLayer = preparedConnection.sourceLayer
    const toLayer = options.targetLayers.get(connection.name)!
    const site = sites.get(endpointIndex)!
    const margin = options.viaDiameter / 2 + (options.boardEdgeClearance ?? 0)
    if (
      site.x < input.bounds.minX + margin ||
      site.x > input.bounds.maxX - margin ||
      site.y < input.bounds.minY + margin ||
      site.y > input.bounds.maxY - margin
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

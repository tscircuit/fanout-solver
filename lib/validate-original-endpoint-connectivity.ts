import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
  pointIsInsideObstacle,
} from "./geometry"
import { getCopperLayerNames, getLayerSpan } from "./layer-names"
import {
  connectionsShareElectricalNet,
  getConnectionNetKey,
  obstacleSharesElectricalNet,
} from "./net-identity"
import type { Point2D, RoutedSegment } from "./types"

const EPSILON = 1e-6

export interface OriginalEndpointConnectivityIssue {
  code: "original-endpoints-disconnected"
  connectionName: string
  disconnectedEndpointIndices: number[]
  message: string
}

export interface OriginalEndpointConnectivityReport {
  valid: boolean
  checkedConnectionCount: number
  connectedConnectionCount: number
  checkedEndpointCount: number
  connectedEndpointCount: number
  issues: OriginalEndpointConnectivityIssue[]
}

interface EndpointCopper {
  type: "endpoint"
  connectionName: string
  endpointIndex: number
  point: ConnectionPoint
  layers: string[]
}

interface ObstacleCopper {
  type: "obstacle"
  obstacle: Obstacle
}

interface SegmentCopper {
  type: "segment"
  segment: RoutedSegment
}

interface ViaCopper {
  type: "via"
  center: Point2D
  diameter: number
  layers: string[]
}

type CopperPrimitive =
  | EndpointCopper
  | ObstacleCopper
  | SegmentCopper
  | ViaCopper

function getPointLayers(point: ConnectionPoint): string[] {
  return "layer" in point ? [point.layer] : point.layers
}

function layersOverlap(first: readonly string[], second: readonly string[]) {
  return first.some((layer) => second.includes(layer))
}

function extractTraceCopper(
  trace: SimplifiedPcbTrace,
  layerNames: string[],
): Array<SegmentCopper | ViaCopper> {
  const copper: Array<SegmentCopper | ViaCopper> = []
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined

  for (const routePoint of trace.route) {
    if (routePoint.route_type === "via") {
      copper.push({
        type: "via",
        center: { x: routePoint.x, y: routePoint.y },
        diameter: routePoint.via_diameter ?? 0,
        layers: getLayerSpan(
          routePoint.from_layer,
          routePoint.to_layer,
          layerNames,
        ),
      })
      previousWire = undefined
      continue
    }
    if (routePoint.route_type !== "wire") continue
    if (
      previousWire &&
      previousWire.layer === routePoint.layer &&
      distance(previousWire, routePoint) > EPSILON
    ) {
      copper.push({
        type: "segment",
        segment: {
          start: { x: previousWire.x, y: previousWire.y },
          end: { x: routePoint.x, y: routePoint.y },
          width: routePoint.width,
          layer: routePoint.layer,
        },
      })
    }
    previousWire = routePoint
  }
  return copper
}

function primitivesTouch(first: CopperPrimitive, second: CopperPrimitive) {
  if (first.type === "endpoint" && second.type === "endpoint") {
    return (
      layersOverlap(first.layers, second.layers) &&
      distance(first.point, second.point) <= EPSILON
    )
  }
  if (first.type === "endpoint" && second.type === "obstacle") {
    return (
      layersOverlap(first.layers, second.obstacle.layers) &&
      pointIsInsideObstacle(first.point, second.obstacle, EPSILON)
    )
  }
  if (first.type === "obstacle" && second.type === "endpoint") {
    return primitivesTouch(second, first)
  }
  if (first.type === "endpoint" && second.type === "segment") {
    return (
      first.layers.includes(second.segment.layer) &&
      distancePointToSegment(
        first.point,
        second.segment.start,
        second.segment.end,
      ) <=
        second.segment.width / 2 + EPSILON
    )
  }
  if (first.type === "segment" && second.type === "endpoint") {
    return primitivesTouch(second, first)
  }
  if (first.type === "endpoint" && second.type === "via") {
    return (
      layersOverlap(first.layers, second.layers) &&
      distance(first.point, second.center) <= second.diameter / 2 + EPSILON
    )
  }
  if (first.type === "via" && second.type === "endpoint") {
    return primitivesTouch(second, first)
  }
  if (first.type === "obstacle" && second.type === "segment") {
    return (
      first.obstacle.layers.includes(second.segment.layer) &&
      distanceSegmentToObstacle(second.segment, first.obstacle) <=
        second.segment.width / 2 + EPSILON
    )
  }
  if (first.type === "segment" && second.type === "obstacle") {
    return primitivesTouch(second, first)
  }
  if (first.type === "obstacle" && second.type === "via") {
    return (
      layersOverlap(first.obstacle.layers, second.layers) &&
      distancePointToObstacle(second.center, first.obstacle) <=
        second.diameter / 2 + EPSILON
    )
  }
  if (first.type === "via" && second.type === "obstacle") {
    return primitivesTouch(second, first)
  }
  if (first.type === "segment" && second.type === "segment") {
    return (
      first.segment.layer === second.segment.layer &&
      distanceSegmentToSegment(
        first.segment.start,
        first.segment.end,
        second.segment.start,
        second.segment.end,
      ) <=
        (first.segment.width + second.segment.width) / 2 + EPSILON
    )
  }
  if (first.type === "segment" && second.type === "via") {
    return (
      second.layers.includes(first.segment.layer) &&
      distancePointToSegment(
        second.center,
        first.segment.start,
        first.segment.end,
      ) <=
        second.diameter / 2 + first.segment.width / 2 + EPSILON
    )
  }
  if (first.type === "via" && second.type === "segment") {
    return primitivesTouch(second, first)
  }
  if (first.type === "via" && second.type === "via") {
    return (
      layersOverlap(first.layers, second.layers) &&
      distance(first.center, second.center) <=
        (first.diameter + second.diameter) / 2 + EPSILON
    )
  }
  return false
}

class DisjointSet {
  private readonly parent: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(index: number): number {
    const parent = this.parent[index]!
    if (parent === index) return index
    const root = this.find(parent)
    this.parent[index] = root
    return root
  }

  union(first: number, second: number): void {
    const firstRoot = this.find(first)
    const secondRoot = this.find(second)
    if (firstRoot !== secondRoot) this.parent[secondRoot] = firstRoot
  }
}

function traceBelongsToNet(
  inputSrj: SimpleRouteJson,
  trace: SimplifiedPcbTrace,
  representativeConnection: SimpleRouteConnection,
): boolean {
  return Boolean(
    trace.connection_name &&
      connectionsShareElectricalNet(
        inputSrj,
        trace.connection_name,
        representativeConnection.name,
      ),
  )
}

/**
 * Independently proves that emitted copper connects every original SRJ
 * endpoint. Merely reaching a boundary or retaining an endpoint in the output
 * connection metadata does not count as connectivity.
 */
export function validateOriginalEndpointConnectivity(params: {
  inputSrj: SimpleRouteJson
  routedSrj: SimpleRouteJson
}): OriginalEndpointConnectivityReport {
  const { inputSrj, routedSrj } = params
  const layerNames = getCopperLayerNames(routedSrj.layerCount)
  const connectionsByNet = new Map<string, SimpleRouteConnection[]>()
  for (const connection of inputSrj.connections) {
    const netKey = getConnectionNetKey(connection)
    const connections = connectionsByNet.get(netKey) ?? []
    connections.push(connection)
    connectionsByNet.set(netKey, connections)
  }

  const issues: OriginalEndpointConnectivityIssue[] = []
  let connectedConnectionCount = 0
  let connectedEndpointCount = 0

  for (const connections of connectionsByNet.values()) {
    const representativeConnection = connections[0]!
    const endpointCopper: EndpointCopper[] = connections.flatMap((connection) =>
      connection.pointsToConnect.map((point, endpointIndex) => ({
        type: "endpoint" as const,
        connectionName: connection.name,
        endpointIndex,
        point,
        layers: getPointLayers(point),
      })),
    )
    const obstacleCopper: ObstacleCopper[] = inputSrj.obstacles
      .filter((obstacle) =>
        obstacleSharesElectricalNet(
          inputSrj,
          obstacle,
          representativeConnection.name,
        ),
      )
      .map((obstacle) => ({ type: "obstacle", obstacle }))
    const routeCopper = (routedSrj.traces ?? [])
      .filter((trace) =>
        traceBelongsToNet(inputSrj, trace, representativeConnection),
      )
      .flatMap((trace) => extractTraceCopper(trace, layerNames))
    const copper: CopperPrimitive[] = [
      ...endpointCopper,
      ...obstacleCopper,
      ...routeCopper,
    ]
    const connectedCopper = new DisjointSet(copper.length)
    for (let firstIndex = 0; firstIndex < copper.length; firstIndex++) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < copper.length;
        secondIndex++
      ) {
        if (primitivesTouch(copper[firstIndex]!, copper[secondIndex]!)) {
          connectedCopper.union(firstIndex, secondIndex)
        }
      }
    }

    const endpointIndexByConnection = new Map<string, number[]>()
    for (let index = 0; index < endpointCopper.length; index++) {
      const endpoint = endpointCopper[index]!
      const indices =
        endpointIndexByConnection.get(endpoint.connectionName) ?? []
      indices[endpoint.endpointIndex] = index
      endpointIndexByConnection.set(endpoint.connectionName, indices)
    }
    for (const connection of connections) {
      const endpointIndices =
        endpointIndexByConnection.get(connection.name) ?? []
      const firstEndpointIndex = endpointIndices[0]
      const firstRoot =
        firstEndpointIndex === undefined
          ? undefined
          : connectedCopper.find(firstEndpointIndex)
      const disconnectedEndpointIndices = endpointIndices.flatMap(
        (endpointIndex, index) =>
          firstRoot === undefined ||
          connectedCopper.find(endpointIndex) !== firstRoot
            ? [index]
            : [],
      )
      connectedEndpointCount +=
        endpointIndices.length - disconnectedEndpointIndices.length
      if (disconnectedEndpointIndices.length === 0) {
        connectedConnectionCount++
      } else {
        issues.push({
          code: "original-endpoints-disconnected",
          connectionName: connection.name,
          disconnectedEndpointIndices,
          message: `Connection ${connection.name} has no physical copper path from endpoint 0 to original endpoint${disconnectedEndpointIndices.length === 1 ? "" : "s"} ${disconnectedEndpointIndices.join(", ")}`,
        })
      }
    }
  }

  const checkedEndpointCount = inputSrj.connections.reduce(
    (count, connection) => count + connection.pointsToConnect.length,
    0,
  )
  return {
    valid: issues.length === 0,
    checkedConnectionCount: inputSrj.connections.length,
    connectedConnectionCount,
    checkedEndpointCount,
    connectedEndpointCount,
    issues,
  }
}

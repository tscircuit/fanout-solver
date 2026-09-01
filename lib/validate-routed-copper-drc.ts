import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  circleFitsInsideObstacle,
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  pointIsInsideObstacle,
  segmentsAreClear,
} from "./geometry"
import { getCopperLayerNames, getRouteViaSpanLayers } from "./layer-names"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import type { Point2D, RoutedSegment } from "./types"

const EPSILON = 1e-6

export type RoutedCopperDrcIssueCode =
  | "unknown-trace-connection"
  | "unsupported-route-point"
  | "disconnected-trace"
  | "via-at-endpoint"
  | "trace-obstacle-clearance"
  | "via-obstacle-clearance"
  | "different-net-trace-clearance"
  | "different-net-trace-via-clearance"
  | "different-net-via-clearance"
  | "via-hole-clearance"

export interface RoutedCopperDrcIssue {
  code: RoutedCopperDrcIssueCode
  message: string
  traceId: string
  connectionName?: string
  otherTraceId?: string
  otherConnectionName?: string
  layer?: string
  obstacleId?: string
}

export interface RoutedCopperDrcReport {
  valid: boolean
  checkedTraceCount: number
  checkedSegmentCount: number
  checkedViaCount: number
  issues: RoutedCopperDrcIssue[]
}

interface RoutedVia {
  center: Point2D
  diameter: number
  holeDiameter: number
  spanLayers: string[]
}

interface TraceCopper {
  trace: SimplifiedPcbTrace
  connectionName: string
  segments: RoutedSegment[]
  vias: RoutedVia[]
}

export function segmentIsLegalTerminalBodyEscape(params: {
  inputSrj: SimpleRouteJson
  segment: RoutedSegment
  bodyObstacle: SimpleRouteJson["obstacles"][number]
  connectionName: string
}): boolean {
  const { inputSrj, segment, bodyObstacle, connectionName } = params
  if (bodyObstacle.connectedTo.length > 0 || !bodyObstacle.componentId) {
    return false
  }
  const sameNetComponentPads = inputSrj.obstacles.filter(
    (obstacle) =>
      obstacle.componentId === bodyObstacle.componentId &&
      obstacle.layers.includes(segment.layer) &&
      obstacleSharesElectricalNet(inputSrj, obstacle, connectionName),
  )
  for (const pad of sameNetComponentPads) {
    for (const [terminal, other] of [
      [segment.start, segment.end],
      [segment.end, segment.start],
    ] as const) {
      if (!pointIsInsideObstacle(terminal, pad, EPSILON)) continue
      const outwardFromBody = {
        x: terminal.x - bodyObstacle.center.x,
        y: terminal.y - bodyObstacle.center.y,
      }
      const terminalToOther = {
        x: other.x - terminal.x,
        y: other.y - terminal.y,
      }
      if (
        outwardFromBody.x * terminalToOther.x +
          outwardFromBody.y * terminalToOther.y >
        EPSILON
      ) {
        return true
      }
    }
  }
  return false
}

function pointsMatch(first: Point2D, second: Point2D): boolean {
  return distance(first, second) <= EPSILON
}

function addIssue(
  issues: RoutedCopperDrcIssue[],
  issue: RoutedCopperDrcIssue,
): void {
  issues.push(issue)
}

function extractTraceCopper(params: {
  srj: SimpleRouteJson
  trace: SimplifiedPcbTrace
  connectionName: string
  layerNames: string[]
  allowBlindAndBuriedVias: boolean
  issues: RoutedCopperDrcIssue[]
}): TraceCopper {
  const {
    srj,
    trace,
    connectionName,
    layerNames,
    allowBlindAndBuriedVias,
    issues,
  } = params
  const segments: RoutedSegment[] = []
  const vias: RoutedVia[] = []
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined
  let pendingVia:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "via" }>
    | undefined

  for (const routePoint of trace.route) {
    if (routePoint.route_type === "via") {
      const diameter =
        routePoint.via_diameter ?? srj.minViaPadDiameter ?? srj.minTraceWidth
      const spanLayers = getRouteViaSpanLayers({
        fromLayer: routePoint.from_layer,
        toLayer: routePoint.to_layer,
        layers:
          "layers" in routePoint && Array.isArray(routePoint.layers)
            ? (routePoint.layers as string[])
            : undefined,
        layerNames,
        allowBlindAndBuriedVias,
      })
      vias.push({
        center: { x: routePoint.x, y: routePoint.y },
        diameter,
        holeDiameter:
          routePoint.via_hole_diameter ??
          srj.minViaHoleDiameter ??
          srj.min_via_hole_diameter ??
          // An unknown drill must not make mechanical validation less
          // conservative than the known outer via geometry.
          diameter,
        spanLayers,
      })
      if (
        !previousWire ||
        !pointsMatch(previousWire, routePoint) ||
        previousWire.layer !== routePoint.from_layer
      ) {
        addIssue(issues, {
          code: "disconnected-trace",
          traceId: trace.pcb_trace_id,
          connectionName,
          message: `Trace ${trace.pcb_trace_id} reaches a via without a matching ${routePoint.from_layer} wire endpoint`,
        })
      }
      pendingVia = routePoint
      continue
    }

    if (routePoint.route_type !== "wire") {
      addIssue(issues, {
        code: "unsupported-route-point",
        traceId: trace.pcb_trace_id,
        connectionName,
        message: `Trace ${trace.pcb_trace_id} contains unsupported ${routePoint.route_type} geometry`,
      })
      previousWire = undefined
      pendingVia = undefined
      continue
    }

    if (pendingVia) {
      if (
        !pointsMatch(routePoint, pendingVia) ||
        routePoint.layer !== pendingVia.to_layer
      ) {
        addIssue(issues, {
          code: "disconnected-trace",
          traceId: trace.pcb_trace_id,
          connectionName,
          message: `Trace ${trace.pcb_trace_id} does not continue from its via on ${pendingVia.to_layer}`,
        })
      }
      previousWire = routePoint
      pendingVia = undefined
      continue
    }

    if (previousWire) {
      if (previousWire.layer !== routePoint.layer) {
        addIssue(issues, {
          code: "disconnected-trace",
          traceId: trace.pcb_trace_id,
          connectionName,
          message: `Trace ${trace.pcb_trace_id} changes from ${previousWire.layer} to ${routePoint.layer} without a via`,
        })
      } else if (!pointsMatch(previousWire, routePoint)) {
        segments.push({
          start: { x: previousWire.x, y: previousWire.y },
          end: { x: routePoint.x, y: routePoint.y },
          width: routePoint.width,
          layer: routePoint.layer,
        })
      }
    }
    previousWire = routePoint
  }

  if (pendingVia) {
    addIssue(issues, {
      code: "disconnected-trace",
      traceId: trace.pcb_trace_id,
      connectionName,
      message: `Trace ${trace.pcb_trace_id} ends at a via without a wire on ${pendingVia.to_layer}`,
    })
  }

  return { trace, connectionName, segments, vias }
}

function getViaHoleEdgeClearance(
  srj: SimpleRouteJson,
  fallbackClearance: number,
): number {
  const rules = srj as SimpleRouteJson & {
    minViaHoleEdgeToViaHoleEdgeClearance?: number
    min_via_hole_edge_to_via_hole_edge_clearance?: number
  }
  const configuredClearance =
    rules.minViaHoleEdgeToViaHoleEdgeClearance ??
    rules.min_via_hole_edge_to_via_hole_edge_clearance
  return typeof configuredClearance === "number" &&
    Number.isFinite(configuredClearance) &&
    configuredClearance >= 0
    ? configuredClearance
    : fallbackClearance
}

function addViaHoleClearanceIssue(params: {
  issues: RoutedCopperDrcIssue[]
  first: TraceCopper
  firstVia: RoutedVia
  second: TraceCopper
  secondVia: RoutedVia
  requiredEdgeClearance: number
}): void {
  const { issues, first, firstVia, second, secondVia, requiredEdgeClearance } =
    params
  if (
    !firstVia.spanLayers.some((layer) => secondVia.spanLayers.includes(layer))
  ) {
    return
  }
  const centerDistance = distance(firstVia.center, secondVia.center)
  const requiredCenterDistance =
    (firstVia.holeDiameter + secondVia.holeDiameter) / 2 + requiredEdgeClearance
  if (centerDistance >= requiredCenterDistance - EPSILON) return
  const actualEdgeClearance =
    centerDistance - (firstVia.holeDiameter + secondVia.holeDiameter) / 2
  addIssue(issues, {
    code: "via-hole-clearance",
    traceId: first.trace.pcb_trace_id,
    connectionName: first.connectionName,
    otherTraceId: second.trace.pcb_trace_id,
    otherConnectionName: second.connectionName,
    message: `Drilled holes in ${first.trace.pcb_trace_id} and ${second.trace.pcb_trace_id} are ${actualEdgeClearance.toFixed(4)}mm edge-to-edge; ${requiredEdgeClearance.toFixed(4)}mm is required`,
  })
}

/**
 * Independently audits every emitted trace and via against the original SRJ
 * obstacle field and every other emitted net. This deliberately does not rely
 * on the solver's accepted route-plan objects.
 */
export function validateRoutedCopperDrc(params: {
  inputSrj: SimpleRouteJson
  routedSrj: SimpleRouteJson
  clearance: number
  allowBlindAndBuriedVias?: boolean
}): RoutedCopperDrcReport {
  const {
    inputSrj,
    routedSrj,
    clearance,
    allowBlindAndBuriedVias = true,
  } = params
  const issues: RoutedCopperDrcIssue[] = []
  const layerNames = getCopperLayerNames(routedSrj.layerCount)
  const traceCopper: TraceCopper[] = []
  const originalAndRoutedEndpoints = [inputSrj, routedSrj].flatMap((srj) =>
    srj.connections.flatMap((connection) =>
      connection.pointsToConnect.map((point) => ({
        connectionName: connection.name,
        point,
      })),
    ),
  )

  for (const trace of routedSrj.traces ?? []) {
    const connectionName = trace.connection_name
    if (
      !connectionName ||
      !inputSrj.connections.some(
        (connection) => connection.name === connectionName,
      )
    ) {
      addIssue(issues, {
        code: "unknown-trace-connection",
        traceId: trace.pcb_trace_id,
        ...(connectionName ? { connectionName } : {}),
        message: `Trace ${trace.pcb_trace_id} does not identify an input connection`,
      })
      continue
    }
    traceCopper.push(
      extractTraceCopper({
        srj: routedSrj,
        trace,
        connectionName,
        layerNames,
        allowBlindAndBuriedVias,
        issues,
      }),
    )
  }

  for (const copper of traceCopper) {
    for (const segment of copper.segments) {
      for (const obstacle of inputSrj.obstacles) {
        if (
          !obstacle.layers.includes(segment.layer) ||
          obstacleSharesElectricalNet(inputSrj, obstacle, copper.connectionName)
        ) {
          continue
        }
        if (
          segmentIsLegalTerminalBodyEscape({
            inputSrj,
            segment,
            bodyObstacle: obstacle,
            connectionName: copper.connectionName,
          })
        ) {
          continue
        }
        const actual = distanceSegmentToObstacle(segment, obstacle)
        const required = segment.width / 2 + clearance
        if (actual < required - EPSILON) {
          addIssue(issues, {
            code: "trace-obstacle-clearance",
            traceId: copper.trace.pcb_trace_id,
            connectionName: copper.connectionName,
            layer: segment.layer,
            obstacleId: obstacle.obstacleId,
            message: `Trace ${copper.trace.pcb_trace_id} on ${segment.layer} is ${actual.toFixed(4)}mm from different-net obstacle ${obstacle.obstacleId}; ${required.toFixed(4)}mm is required`,
          })
        }
      }
    }
    for (const via of copper.vias) {
      const coincidentEndpoint = originalAndRoutedEndpoints.find(
        ({ point }) => distance(via.center, point) <= EPSILON,
      )
      const isAllowedContainedViaInPad =
        (inputSrj as SimpleRouteJson & { allowViaInPad?: boolean })
          .allowViaInPad === true &&
        inputSrj.obstacles.some(
          (obstacle) =>
            obstacle.layers.some((layer) => via.spanLayers.includes(layer)) &&
            obstacleSharesElectricalNet(
              inputSrj,
              obstacle,
              copper.connectionName,
            ) &&
            circleFitsInsideObstacle({
              center: via.center,
              diameter: via.diameter,
              obstacle,
              tolerance: EPSILON,
            }),
        )
      if (coincidentEndpoint && !isAllowedContainedViaInPad) {
        addIssue(issues, {
          code: "via-at-endpoint",
          traceId: copper.trace.pcb_trace_id,
          connectionName: copper.connectionName,
          otherConnectionName: coincidentEndpoint.connectionName,
          message: `Via in ${copper.trace.pcb_trace_id} is placed directly at an original or routed connection endpoint`,
        })
      }
      for (const obstacle of inputSrj.obstacles) {
        if (
          !obstacle.layers.some((layer) => via.spanLayers.includes(layer)) ||
          obstacleSharesElectricalNet(inputSrj, obstacle, copper.connectionName)
        ) {
          continue
        }
        const actual = distancePointToObstacle(via.center, obstacle)
        const required = via.diameter / 2 + clearance
        if (actual < required - EPSILON) {
          addIssue(issues, {
            code: "via-obstacle-clearance",
            traceId: copper.trace.pcb_trace_id,
            connectionName: copper.connectionName,
            obstacleId: obstacle.obstacleId,
            message: `Via in ${copper.trace.pcb_trace_id} is ${actual.toFixed(4)}mm from different-net obstacle ${obstacle.obstacleId} on its layer span; ${required.toFixed(4)}mm is required`,
          })
        }
      }
    }
  }

  const requiredViaHoleEdgeClearance = getViaHoleEdgeClearance(
    inputSrj,
    clearance,
  )
  for (const copper of traceCopper) {
    for (
      let firstViaIndex = 0;
      firstViaIndex < copper.vias.length;
      firstViaIndex++
    ) {
      for (
        let secondViaIndex = firstViaIndex + 1;
        secondViaIndex < copper.vias.length;
        secondViaIndex++
      ) {
        addViaHoleClearanceIssue({
          issues,
          first: copper,
          firstVia: copper.vias[firstViaIndex]!,
          second: copper,
          secondVia: copper.vias[secondViaIndex]!,
          requiredEdgeClearance: requiredViaHoleEdgeClearance,
        })
      }
    }
  }
  for (let firstIndex = 0; firstIndex < traceCopper.length; firstIndex++) {
    const first = traceCopper[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < traceCopper.length;
      secondIndex++
    ) {
      const second = traceCopper[secondIndex]!
      for (const firstVia of first.vias) {
        for (const secondVia of second.vias) {
          addViaHoleClearanceIssue({
            issues,
            first,
            firstVia,
            second,
            secondVia,
            requiredEdgeClearance: requiredViaHoleEdgeClearance,
          })
        }
      }
      if (
        connectionsShareElectricalNet(
          inputSrj,
          first.connectionName,
          second.connectionName,
        )
      ) {
        continue
      }

      for (const firstSegment of first.segments) {
        for (const secondSegment of second.segments) {
          if (segmentsAreClear(firstSegment, secondSegment, clearance)) continue
          addIssue(issues, {
            code: "different-net-trace-clearance",
            traceId: first.trace.pcb_trace_id,
            connectionName: first.connectionName,
            otherTraceId: second.trace.pcb_trace_id,
            otherConnectionName: second.connectionName,
            layer: firstSegment.layer,
            message: `Different-net traces ${first.trace.pcb_trace_id} and ${second.trace.pcb_trace_id} intersect or violate clearance on ${firstSegment.layer}`,
          })
        }
        for (const secondVia of second.vias) {
          if (
            !secondVia.spanLayers.includes(firstSegment.layer) ||
            distancePointToSegment(
              secondVia.center,
              firstSegment.start,
              firstSegment.end,
            ) >=
              secondVia.diameter / 2 +
                firstSegment.width / 2 +
                clearance -
                EPSILON
          ) {
            continue
          }
          addIssue(issues, {
            code: "different-net-trace-via-clearance",
            traceId: first.trace.pcb_trace_id,
            connectionName: first.connectionName,
            otherTraceId: second.trace.pcb_trace_id,
            otherConnectionName: second.connectionName,
            layer: firstSegment.layer,
            message: `Trace ${first.trace.pcb_trace_id} violates via clearance to ${second.trace.pcb_trace_id} on ${firstSegment.layer}`,
          })
        }
      }

      for (const firstVia of first.vias) {
        for (const secondSegment of second.segments) {
          if (
            !firstVia.spanLayers.includes(secondSegment.layer) ||
            distancePointToSegment(
              firstVia.center,
              secondSegment.start,
              secondSegment.end,
            ) >=
              firstVia.diameter / 2 +
                secondSegment.width / 2 +
                clearance -
                EPSILON
          ) {
            continue
          }
          addIssue(issues, {
            code: "different-net-trace-via-clearance",
            traceId: first.trace.pcb_trace_id,
            connectionName: first.connectionName,
            otherTraceId: second.trace.pcb_trace_id,
            otherConnectionName: second.connectionName,
            layer: secondSegment.layer,
            message: `Via in ${first.trace.pcb_trace_id} violates trace clearance to ${second.trace.pcb_trace_id} on ${secondSegment.layer}`,
          })
        }
        for (const secondVia of second.vias) {
          if (
            !firstVia.spanLayers.some((layer) =>
              secondVia.spanLayers.includes(layer),
            ) ||
            distance(firstVia.center, secondVia.center) >=
              (firstVia.diameter + secondVia.diameter) / 2 + clearance - EPSILON
          ) {
            continue
          }
          addIssue(issues, {
            code: "different-net-via-clearance",
            traceId: first.trace.pcb_trace_id,
            connectionName: first.connectionName,
            otherTraceId: second.trace.pcb_trace_id,
            otherConnectionName: second.connectionName,
            message: `Different-net vias in ${first.trace.pcb_trace_id} and ${second.trace.pcb_trace_id} violate clearance on an overlapping layer span`,
          })
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    checkedTraceCount: routedSrj.traces?.length ?? 0,
    checkedSegmentCount: traceCopper.reduce(
      (count, copper) => count + copper.segments.length,
      0,
    ),
    checkedViaCount: traceCopper.reduce(
      (count, copper) => count + copper.vias.length,
      0,
    ),
    issues,
  }
}

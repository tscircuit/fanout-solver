import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { createFanoutCompletionTraceId } from "./fanout-output-ids"
import {
  distance,
  distancePointToSegment,
  pointIsInsideObstacle,
} from "./geometry"
import { obstacleSharesElectricalNet } from "./net-identity"
import type {
  FanoutDownstreamRouter,
  FanoutEndpointCompletionReport,
  FanoutRoutePlan,
  Point2D,
} from "./types"
import { validateOriginalEndpointConnectivity } from "./validate-original-endpoint-connectivity"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

const EPSILON = 1e-9

interface CompletionAttempt {
  traces: SimplifiedPcbTrace[]
  failedConnectionNames: string[]
  blockingConnectionNames: string[]
  connectivity: ReturnType<typeof validateOriginalEndpointConnectivity>
  drc: ReturnType<typeof validateRoutedCopperDrc>
}

export interface CompleteOriginalEndpointsResult {
  simpleRouteJson: SimpleRouteJson
  traces: SimplifiedPcbTrace[]
  report: FanoutEndpointCompletionReport
}

function getPointLayer(
  point: ConnectionPoint,
  preferredLayer?: string,
): string {
  if ("layer" in point) return point.layer
  if (preferredLayer && point.layers.includes(preferredLayer)) {
    return preferredLayer
  }
  const layer = point.layers[0]
  if (!layer) throw new Error("Endpoint completion received a layerless point")
  return layer
}

function uniquePoints(points: Point2D[]): Point2D[] {
  const unique: Point2D[] = []
  for (const point of points) {
    if (unique.at(-1) && distance(unique.at(-1)!, point) < EPSILON) continue
    unique.push(point)
  }
  return unique
}

function chamferOrthogonalPolyline(
  rawPoints: Point2D[],
  requestedChamfer: number,
): Point2D[] {
  const points = uniquePoints(rawPoints)
  if (points.length < 3) return points
  const chamfered: Point2D[] = [points[0]!]

  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!
    const corner = points[index]!
    const next = points[index + 1]!
    const incomingLength = distance(previous, corner)
    const outgoingLength = distance(corner, next)
    const incoming = {
      x: (corner.x - previous.x) / incomingLength,
      y: (corner.y - previous.y) / incomingLength,
    }
    const outgoing = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    }
    if (Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y) > 1e-6) {
      chamfered.push(corner)
      continue
    }
    const chamfer = Math.min(
      requestedChamfer,
      incomingLength / 2,
      outgoingLength / 2,
    )
    chamfered.push({
      x: corner.x - incoming.x * chamfer,
      y: corner.y - incoming.y * chamfer,
    })
    chamfered.push({
      x: corner.x + outgoing.x * chamfer,
      y: corner.y + outgoing.y * chamfer,
    })
  }
  chamfered.push(points.at(-1)!)
  return uniquePoints(chamfered)
}

function findEndpointPad(params: {
  inputSrj: SimpleRouteJson
  connectionName: string
  target: ConnectionPoint
  targetLayer: string
}): Obstacle | undefined {
  const { inputSrj, connectionName, target, targetLayer } = params
  return inputSrj.obstacles.find(
    (obstacle) =>
      obstacle.layers.includes(targetLayer) &&
      obstacleSharesElectricalNet(inputSrj, obstacle, connectionName) &&
      pointIsInsideObstacle(target, obstacle, 1e-6),
  )
}

function getTerminalDirections(params: {
  inputSrj: SimpleRouteJson
  plan: FanoutRoutePlan
}): { outward: Point2D; perpendicular: Point2D } {
  const { inputSrj, plan } = params
  const targetLayer = getPointLayer(plan.targetPoint)
  const targetPad = findEndpointPad({
    inputSrj,
    connectionName: plan.connectionName,
    target: plan.targetPoint,
    targetLayer,
  })
  const body = inputSrj.obstacles.find(
    (obstacle) =>
      obstacle.componentId === targetPad?.componentId &&
      obstacle.connectedTo.length === 0,
  )
  const rawOutward = body
    ? {
        x: plan.targetPoint.x - body.center.x,
        y: plan.targetPoint.y - body.center.y,
      }
    : {
        x: plan.targetPoint.x - plan.sourcePoint.x,
        y: plan.targetPoint.y - plan.sourcePoint.y,
      }
  const length = Math.hypot(rawOutward.x, rawOutward.y)
  const outward =
    length > EPSILON
      ? { x: rawOutward.x / length, y: rawOutward.y / length }
      : { x: 1, y: 0 }
  return {
    outward,
    perpendicular: { x: -outward.y, y: outward.x },
  }
}

function createBranchTrace(params: {
  plan: FanoutRoutePlan
  branchStart: Point2D & { layer: string }
  viaPoint: Point2D
  assignedLayerPath: Point2D[]
  terminalApproach?: Point2D
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  candidateIndex: number
  chamfer: number
}): SimplifiedPcbTrace {
  const {
    plan,
    branchStart,
    viaPoint,
    assignedLayerPath,
    terminalApproach,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    candidateIndex,
    chamfer,
  } = params
  const targetLayer = getPointLayer(plan.targetPoint)
  const firstPath = chamferOrthogonalPolyline(assignedLayerPath, chamfer)
  const terminalPath = chamferOrthogonalPolyline(
    [
      viaPoint,
      ...(terminalApproach ? [terminalApproach] : []),
      plan.targetPoint,
    ],
    chamfer,
  )
  const route: SimplifiedPcbTrace["route"] = firstPath.map((point) => ({
    route_type: "wire" as const,
    x: point.x,
    y: point.y,
    width: traceWidth,
    layer: branchStart.layer,
  }))

  if (branchStart.layer !== targetLayer) {
    route.push({
      route_type: "via",
      x: viaPoint.x,
      y: viaPoint.y,
      from_layer: branchStart.layer,
      to_layer: targetLayer,
      via_diameter: viaDiameter,
      via_hole_diameter: viaHoleDiameter,
    })
    route.push({
      route_type: "wire",
      x: viaPoint.x,
      y: viaPoint.y,
      width: traceWidth,
      layer: targetLayer,
    })
  }
  for (const point of terminalPath.slice(1)) {
    route.push({
      route_type: "wire",
      x: point.x,
      y: point.y,
      width: traceWidth,
      layer: targetLayer,
    })
  }

  return {
    type: "pcb_trace",
    pcb_trace_id: createFanoutCompletionTraceId({
      connectionName: plan.connectionName,
      sourcePointIndex: plan.sourcePointIndex,
      candidateIndex,
    }),
    connection_name: plan.connectionName,
    route,
  }
}

function connectionIsComplete(
  report: ReturnType<typeof validateOriginalEndpointConnectivity>,
  connectionName: string,
): boolean {
  return !report.issues.some((issue) => issue.connectionName === connectionName)
}

function traceHasViaAtEndpoint(params: {
  trace: SimplifiedPcbTrace
  endpointSrjs: SimpleRouteJson[]
}): boolean {
  const { trace, endpointSrjs } = params
  const endpoints = endpointSrjs.flatMap((srj) =>
    srj.connections.flatMap((connection) => connection.pointsToConnect),
  )
  return trace.route.some(
    (routePoint) =>
      routePoint.route_type === "via" &&
      endpoints.some((endpoint) => distance(routePoint, endpoint) <= 1e-6),
  )
}

function findLocalBranch(params: {
  inputSrj: SimpleRouteJson
  fanoutSrj: SimpleRouteJson
  plan: FanoutRoutePlan
  acceptedTraces: SimplifiedPcbTrace[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowBlindAndBuriedVias: boolean
}): {
  trace?: SimplifiedPcbTrace
  blockingConnectionNames: string[]
} {
  const {
    inputSrj,
    fanoutSrj,
    plan,
    acceptedTraces,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias,
  } = params
  const { outward, perpendicular } = getTerminalDirections({ inputSrj, plan })
  const branchStarts: Array<Point2D & { layer: string }> = [
    ...(plan.via
      ? [
          {
            x: plan.via.center.x,
            y: plan.via.center.y,
            layer: plan.targetLayer,
          },
        ]
      : []),
    {
      x: plan.sourcePoint.x,
      y: plan.sourcePoint.y,
      layer: plan.sourceLayer,
    },
  ]
  let bestBlockingConnectionNames: string[] = []
  let bestIssueCount = Number.POSITIVE_INFINITY
  let candidateIndex = 0
  const maximumCandidateCount =
    inputSrj.connections.length > 32 ? 600 : Number.POSITIVE_INFINITY

  const planeTraceTransitionPoints =
    plan.termination.type === "plane"
      ? getPointsBackAlongTrace({
          trace: plan.trace,
          endpoint: plan.exitPoint,
          layer: plan.sourceLayer,
          distances: [0.2, 0.3, 0.4],
        })
      : []
  const candidateViaPoints: Point2D[] = [
    ...(plan.termination.type === "plane" && plan.via
      ? [{ ...plan.via.center }]
      : []),
    ...planeTraceTransitionPoints,
    ...[0.4, 0.8, 1.2, 1.6].flatMap((outwardDistance) =>
      [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6].map(
        (perpendicularDistance) => ({
          x:
            plan.sourcePoint.x +
            outward.x * outwardDistance +
            perpendicular.x * perpendicularDistance,
          y:
            plan.sourcePoint.y +
            outward.y * outwardDistance +
            perpendicular.y * perpendicularDistance,
        }),
      ),
    ),
  ]
  for (const viaPoint of candidateViaPoints) {
    const candidateBranchStarts = [
      ...(plan.termination.type === "plane"
        ? [{ ...viaPoint, layer: plan.targetLayer }]
        : []),
      ...branchStarts,
      ...planeTraceTransitionPoints.flatMap((transitionPoint) =>
        distance(transitionPoint, viaPoint) <= 1e-6
          ? [{ ...transitionPoint, layer: plan.sourceLayer }]
          : [],
      ),
    ]
    for (const branchStart of candidateBranchStarts) {
      const assignedLayerPaths =
        distance(branchStart, viaPoint) <= 1e-6
          ? [[branchStart]]
          : [
              [branchStart, viaPoint],
              [branchStart, { x: viaPoint.x, y: branchStart.y }, viaPoint],
              [branchStart, { x: branchStart.x, y: viaPoint.y }, viaPoint],
              ...[0.4, -0.4].map((corridorOffset) => [
                branchStart,
                { x: branchStart.x + corridorOffset, y: branchStart.y },
                { x: branchStart.x + corridorOffset, y: viaPoint.y },
                viaPoint,
              ]),
            ]
      for (const assignedLayerPath of assignedLayerPaths) {
        const terminalApproaches: Array<Point2D | undefined> = [
          undefined,
          ...[0.4, 0.8].map((terminalDistance) => ({
            x: plan.targetPoint.x + outward.x * terminalDistance,
            y: plan.targetPoint.y + outward.y * terminalDistance,
          })),
          ...[0.4, -0.4].map((sideDistance) => ({
            x:
              plan.targetPoint.x +
              outward.x * 0.4 +
              perpendicular.x * sideDistance,
            y:
              plan.targetPoint.y +
              outward.y * 0.4 +
              perpendicular.y * sideDistance,
          })),
        ]
        for (const terminalApproach of terminalApproaches) {
          if (candidateIndex >= maximumCandidateCount) {
            return {
              blockingConnectionNames: bestBlockingConnectionNames,
            }
          }
          const trace = createBranchTrace({
            plan,
            branchStart,
            viaPoint,
            assignedLayerPath,
            terminalApproach,
            traceWidth,
            viaDiameter,
            viaHoleDiameter,
            candidateIndex: candidateIndex++,
            // Preserve the raw Manhattan alternative. Some dense escape
            // slots disappear when both sides of a short corner are moved.
            chamfer: 0,
          })
          if (
            traceHasViaAtEndpoint({
              trace,
              endpointSrjs: [inputSrj, fanoutSrj],
            })
          ) {
            continue
          }
          const candidateSrj = {
            ...fanoutSrj,
            traces: [...(fanoutSrj.traces ?? []), ...acceptedTraces, trace],
          }
          const drc = validateRoutedCopperDrc({
            inputSrj,
            routedSrj: candidateSrj,
            clearance,
            allowBlindAndBuriedVias,
          })
          if (!drc.valid) {
            if (drc.issues.length < bestIssueCount) {
              bestIssueCount = drc.issues.length
              bestBlockingConnectionNames = [
                ...new Set(
                  drc.issues.flatMap((issue) =>
                    [issue.connectionName, issue.otherConnectionName].flatMap(
                      (connectionName) =>
                        connectionName && connectionName !== plan.connectionName
                          ? [connectionName]
                          : [],
                    ),
                  ),
                ),
              ]
            }
            continue
          }
          const connectivity = validateOriginalEndpointConnectivity({
            inputSrj,
            routedSrj: candidateSrj,
          })
          if (connectionIsComplete(connectivity, plan.connectionName)) {
            return { trace, blockingConnectionNames: [] }
          }
        }
      }
    }
  }
  return {
    blockingConnectionNames: bestBlockingConnectionNames,
  }
}

function runLocalCompletionPass(params: {
  inputSrj: SimpleRouteJson
  fanoutSrj: SimpleRouteJson
  plans: FanoutRoutePlan[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowBlindAndBuriedVias: boolean
}): CompletionAttempt {
  const {
    inputSrj,
    fanoutSrj,
    plans,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias,
  } = params
  const traces: SimplifiedPcbTrace[] = []
  const failedConnectionNames: string[] = []
  const blockingConnectionNames = new Set<string>()
  for (const plan of plans) {
    const result = findLocalBranch({
      inputSrj,
      fanoutSrj,
      plan,
      acceptedTraces: traces,
      traceWidth,
      viaDiameter,
      viaHoleDiameter,
      clearance,
      allowBlindAndBuriedVias,
    })
    if (result.trace) {
      traces.push(result.trace)
    } else {
      failedConnectionNames.push(plan.connectionName)
      for (const connectionName of result.blockingConnectionNames) {
        blockingConnectionNames.add(connectionName)
      }
    }
  }
  const simpleRouteJson = {
    ...fanoutSrj,
    traces: [...(fanoutSrj.traces ?? []), ...traces],
  }
  return {
    traces,
    failedConnectionNames,
    blockingConnectionNames: [...blockingConnectionNames],
    connectivity: validateOriginalEndpointConnectivity({
      inputSrj,
      routedSrj: simpleRouteJson,
    }),
    drc: validateRoutedCopperDrc({
      inputSrj,
      routedSrj: simpleRouteJson,
      clearance,
      allowBlindAndBuriedVias,
    }),
  }
}

function traceLength(trace: SimplifiedPcbTrace): number {
  let length = 0
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined
  for (const point of trace.route) {
    if (point.route_type !== "wire") {
      previousWire = undefined
      continue
    }
    if (previousWire?.layer === point.layer)
      length += distance(previousWire, point)
    previousWire = point
  }
  return length
}

function trimCompletedFanoutTails(params: {
  fanoutSrj: SimpleRouteJson
  completionTraces: SimplifiedPcbTrace[]
}): SimpleRouteJson {
  const { fanoutSrj, completionTraces } = params
  const branchStartByConnectionName = new Map(
    completionTraces.flatMap((trace) => {
      const firstWire = trace.route.find(
        (point): point is Extract<typeof point, { route_type: "wire" }> =>
          point.route_type === "wire",
      )
      return firstWire
        ? [
            [
              trace.connection_name,
              {
                x: firstWire.x,
                y: firstWire.y,
                layer: firstWire.layer,
              },
            ] as const,
          ]
        : []
    }),
  )
  const traces = (fanoutSrj.traces ?? []).map((trace) => {
    if (!trace.pcb_trace_id.startsWith("fanout:")) return trace
    const branchStart = branchStartByConnectionName.get(trace.connection_name)
    if (!branchStart) return trace

    let previousWireIndex: number | undefined
    for (let index = 0; index < trace.route.length; index++) {
      const point = trace.route[index]
      if (point?.route_type !== "wire") {
        previousWireIndex = undefined
        continue
      }
      if (previousWireIndex !== undefined) {
        const previous = trace.route[previousWireIndex]
        if (
          previous?.route_type === "wire" &&
          previous.layer === branchStart.layer &&
          point.layer === branchStart.layer &&
          distancePointToSegment(branchStart, previous, point) <= 1e-6
        ) {
          const route = trace.route.slice(0, previousWireIndex + 1)
          if (distance(previous, branchStart) > 1e-6) {
            route.push({
              route_type: "wire",
              x: branchStart.x,
              y: branchStart.y,
              width: point.width,
              layer: branchStart.layer,
            })
          }
          return { ...trace, route }
        }
      }
      previousWireIndex = index
    }
    return trace
  })
  return { ...fanoutSrj, traces }
}

function acceptDownstreamTraces(params: {
  inputSrj: SimpleRouteJson
  fanoutSrj: SimpleRouteJson
  localTraces: SimplifiedPcbTrace[]
  candidates: SimplifiedPcbTrace[]
  clearance: number
  allowBlindAndBuriedVias: boolean
}): SimplifiedPcbTrace[] {
  const {
    inputSrj,
    fanoutSrj,
    localTraces,
    candidates,
    clearance,
    allowBlindAndBuriedVias,
  } = params
  const baselineTraces = [...(fanoutSrj.traces ?? []), ...localTraces]
  const baselineSrj = { ...fanoutSrj, traces: baselineTraces }
  const baselineConnectivity = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: baselineSrj,
  })
  const physicalCandidates = candidates.filter(
    (trace) =>
      trace.route.length > 1 &&
      trace.route.every(
        (routePoint) =>
          routePoint.route_type === "wire" || routePoint.route_type === "via",
      ) &&
      !traceHasViaAtEndpoint({
        trace,
        endpointSrjs: [inputSrj, fanoutSrj],
      }),
  )
  const usefulCandidates = physicalCandidates.filter((trace) => {
    const report = validateOriginalEndpointConnectivity({
      inputSrj,
      routedSrj: { ...fanoutSrj, traces: [...baselineTraces, trace] },
    })
    return (
      report.connectedConnectionCount >
        baselineConnectivity.connectedConnectionCount &&
      connectionIsComplete(report, trace.connection_name)
    )
  })
  const combinedSrj = {
    ...fanoutSrj,
    traces: [...baselineTraces, ...usefulCandidates],
  }
  if (
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: combinedSrj,
      clearance,
      allowBlindAndBuriedVias,
    }).valid
  ) {
    return usefulCandidates
  }

  const accepted: SimplifiedPcbTrace[] = []
  for (const trace of usefulCandidates.toSorted(
    (first, second) => traceLength(first) - traceLength(second),
  )) {
    const candidateSrj = {
      ...fanoutSrj,
      traces: [...baselineTraces, ...accepted, trace],
    }
    const drc = validateRoutedCopperDrc({
      inputSrj,
      routedSrj: candidateSrj,
      clearance,
      allowBlindAndBuriedVias,
    })
    if (!drc.valid) continue
    const before = validateOriginalEndpointConnectivity({
      inputSrj,
      routedSrj: {
        ...fanoutSrj,
        traces: [...baselineTraces, ...accepted],
      },
    })
    const after = validateOriginalEndpointConnectivity({
      inputSrj,
      routedSrj: candidateSrj,
    })
    if (
      after.connectedConnectionCount > before.connectedConnectionCount &&
      connectionIsComplete(after, trace.connection_name)
    ) {
      accepted.push(trace)
    }
  }
  return accepted
}

function getPointsBackAlongTrace(params: {
  trace: SimplifiedPcbTrace
  endpoint: Point2D
  layer: string
  distances: number[]
}): Point2D[] {
  const { trace, endpoint, layer, distances } = params
  const endpointIndex = trace.route.findLastIndex(
    (routePoint) =>
      routePoint.route_type === "wire" &&
      routePoint.layer === layer &&
      distance(routePoint, endpoint) <= 1e-6,
  )
  if (endpointIndex < 0) return []

  return distances.flatMap((requestedDistance) => {
    let remainingDistance = requestedDistance
    let current = endpoint
    for (let index = endpointIndex - 1; index >= 0; index--) {
      const previous = trace.route[index]
      if (previous?.route_type !== "wire" || previous.layer !== layer) break
      const segmentLength = distance(current, previous)
      if (segmentLength <= EPSILON) continue
      if (remainingDistance < segmentLength - 1e-6) {
        return [
          {
            x:
              current.x +
              ((previous.x - current.x) * remainingDistance) / segmentLength,
            y:
              current.y +
              ((previous.y - current.y) * remainingDistance) / segmentLength,
          },
        ]
      }
      remainingDistance -= segmentLength
      current = previous
    }
    return []
  })
}

function findDownstreamTerminalBranch(params: {
  inputSrj: SimpleRouteJson
  fanoutSrj: SimpleRouteJson
  plan: FanoutRoutePlan
  acceptedTraces: SimplifiedPcbTrace[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowBlindAndBuriedVias: boolean
}): SimplifiedPcbTrace | undefined {
  const {
    inputSrj,
    fanoutSrj,
    plan,
    acceptedTraces,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias,
  } = params
  const branchStart = {
    x: plan.exitPoint.x,
    y: plan.exitPoint.y,
    layer: plan.targetLayer,
  }
  const target = plan.targetPoint
  const targetLayer = getPointLayer(target)
  let candidateIndex = 0
  const tryCandidate = (candidate: {
    start: Point2D & { layer: string }
    viaPoint: Point2D
    terminalApproach?: Point2D
  }): SimplifiedPcbTrace | undefined => {
    const trace = createBranchTrace({
      plan,
      branchStart: candidate.start,
      viaPoint: candidate.viaPoint,
      assignedLayerPath: [candidate.start, candidate.viaPoint],
      terminalApproach: candidate.terminalApproach,
      traceWidth,
      viaDiameter,
      viaHoleDiameter,
      candidateIndex: 10_000 + candidateIndex++,
      chamfer: Math.max(traceWidth, 0.1),
    })
    if (
      traceHasViaAtEndpoint({
        trace,
        endpointSrjs: [inputSrj, fanoutSrj],
      })
    ) {
      return undefined
    }
    const candidateSrj = {
      ...fanoutSrj,
      traces: [...(fanoutSrj.traces ?? []), ...acceptedTraces, trace],
    }
    if (
      !validateRoutedCopperDrc({
        inputSrj,
        routedSrj: candidateSrj,
        clearance,
        allowBlindAndBuriedVias,
      }).valid
    ) {
      return undefined
    }
    if (
      connectionIsComplete(
        validateOriginalEndpointConnectivity({
          inputSrj,
          routedSrj: candidateSrj,
        }),
        plan.connectionName,
      )
    ) {
      return trace
    }
    return undefined
  }

  if (branchStart.layer !== targetLayer) {
    const existingTraceTransitionPoints = getPointsBackAlongTrace({
      trace: plan.trace,
      endpoint: plan.exitPoint,
      layer: plan.targetLayer,
      distances: [0.4, 0.8, 1.2, 1.6],
    })
    for (const viaPoint of existingTraceTransitionPoints) {
      const transitionStart = { ...viaPoint, layer: plan.targetLayer }
      for (const terminalApproach of [
        undefined,
        { x: target.x, y: viaPoint.y },
        { x: viaPoint.x, y: target.y },
      ]) {
        const trace = tryCandidate({
          start: transitionStart,
          viaPoint,
          terminalApproach,
        })
        if (trace) return trace
      }
    }
  }

  const routePaths: Point2D[][] = [
    [target],
    [{ x: target.x, y: branchStart.y }, target],
    [{ x: branchStart.x, y: target.y }, target],
  ]
  for (const routePath of routePaths) {
    const firstTarget = routePath[0]!
    const firstSegmentLength = distance(branchStart, firstTarget)
    const transitionDistances =
      branchStart.layer === targetLayer ? [0] : [0.4, 0.8, 1.2, 1.6]
    for (const transitionDistance of transitionDistances) {
      if (
        branchStart.layer !== targetLayer &&
        (firstSegmentLength <= transitionDistance + 0.2 ||
          transitionDistance <= 1e-6)
      ) {
        continue
      }
      const viaPoint =
        branchStart.layer === targetLayer
          ? { x: branchStart.x, y: branchStart.y }
          : {
              x:
                branchStart.x +
                ((firstTarget.x - branchStart.x) * transitionDistance) /
                  firstSegmentLength,
              y:
                branchStart.y +
                ((firstTarget.y - branchStart.y) * transitionDistance) /
                  firstSegmentLength,
            }
      const trace = tryCandidate({
        start: branchStart,
        viaPoint,
        terminalApproach: routePath.length > 1 ? firstTarget : undefined,
      })
      if (trace) return trace
    }
  }
  return undefined
}

/**
 * Connects short opposite-layer terminal pairs with constrained interstitial
 * vias, then delegates remaining long routes to an optional host-provided
 * router. Only metric-improving, independently DRC-clean physical copper is
 * retained.
 */
export function completeOriginalEndpoints(params: {
  inputSrj: SimpleRouteJson
  fanoutSrj: SimpleRouteJson
  plans: FanoutRoutePlan[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowBlindAndBuriedVias?: boolean
  effort?: number
  routeDownstreamConnections?: FanoutDownstreamRouter
}): CompleteOriginalEndpointsResult {
  const {
    inputSrj,
    fanoutSrj,
    plans,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias = true,
    effort = 1,
    routeDownstreamConnections,
  } = params
  const errors: string[] = []
  const baselineDrc = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: fanoutSrj,
    clearance,
    allowBlindAndBuriedVias,
  })
  const baselineConnectivity = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: fanoutSrj,
  })
  const localPlans = plans.filter((plan) => {
    const sourceLayer = getPointLayer(plan.sourcePoint)
    const targetLayer = getPointLayer(plan.targetPoint)
    return (
      sourceLayer !== targetLayer &&
      distance(plan.sourcePoint, plan.targetPoint) <= 0.25 &&
      !connectionIsComplete(baselineConnectivity, plan.connectionName)
    )
  })
  let bestLocalAttempt: CompletionAttempt = {
    traces: [],
    failedConnectionNames: localPlans.map((plan) => plan.connectionName),
    blockingConnectionNames: [],
    connectivity: baselineConnectivity,
    drc: baselineDrc,
  }
  let searchPassCount = 0

  if (!baselineDrc.valid) {
    errors.push("Fanout prefix failed emitted-copper DRC; skipped completion")
  } else {
    let priorityConnectionNames: string[] = []
    const originalOrder = new Map(
      localPlans.map((plan, index) => [plan.connectionName, index]),
    )
    const maximumLocalPasses = inputSrj.connections.length > 32 ? 1 : 3
    for (let passIndex = 0; passIndex < maximumLocalPasses; passIndex++) {
      const priority = new Map(
        priorityConnectionNames.map((connectionName, index) => [
          connectionName,
          index,
        ]),
      )
      const orderedPlans = localPlans.toSorted(
        (first, second) =>
          (priority.get(first.connectionName) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(second.connectionName) ?? Number.MAX_SAFE_INTEGER) ||
          (originalOrder.get(first.connectionName) ?? 0) -
            (originalOrder.get(second.connectionName) ?? 0),
      )
      const attempt = runLocalCompletionPass({
        inputSrj,
        fanoutSrj,
        plans: orderedPlans,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        clearance,
        allowBlindAndBuriedVias,
      })
      searchPassCount++
      if (
        attempt.drc.valid &&
        (attempt.connectivity.connectedConnectionCount >
          bestLocalAttempt.connectivity.connectedConnectionCount ||
          (attempt.connectivity.connectedConnectionCount ===
            bestLocalAttempt.connectivity.connectedConnectionCount &&
            attempt.traces.length < bestLocalAttempt.traces.length))
      ) {
        bestLocalAttempt = attempt
      }
      priorityConnectionNames = [
        ...new Set([
          ...attempt.failedConnectionNames,
          ...attempt.blockingConnectionNames,
          ...priorityConnectionNames,
        ]),
      ]
      if (attempt.failedConnectionNames.length === 0) break
    }
  }

  const localConnectionNames = new Set(
    localPlans.map((plan) => plan.connectionName),
  )
  const downstreamPlans = plans.filter(
    (plan) =>
      !localConnectionNames.has(plan.connectionName) &&
      !connectionIsComplete(baselineConnectivity, plan.connectionName),
  )
  const directDownstreamTraces: SimplifiedPcbTrace[] = []
  if (baselineDrc.valid) {
    for (const plan of downstreamPlans) {
      const terminalBranch = findDownstreamTerminalBranch({
        inputSrj,
        fanoutSrj,
        plan,
        acceptedTraces: [...bestLocalAttempt.traces, ...directDownstreamTraces],
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        clearance,
        allowBlindAndBuriedVias,
      })
      if (terminalBranch) directDownstreamTraces.push(terminalBranch)
    }
  }
  const directSrj = {
    ...fanoutSrj,
    traces: [
      ...(fanoutSrj.traces ?? []),
      ...bestLocalAttempt.traces,
      ...directDownstreamTraces,
    ],
  }
  const unresolvedConnectionNames = new Set(
    validateOriginalEndpointConnectivity({
      inputSrj,
      routedSrj: directSrj,
    }).issues.map((issue) => issue.connectionName),
  )
  const downstreamConnections = fanoutSrj.connections.filter(
    (connection) =>
      !localConnectionNames.has(connection.name) &&
      unresolvedConnectionNames.has(connection.name),
  )
  let downstreamTraces: SimplifiedPcbTrace[] = []
  if (
    baselineDrc.valid &&
    downstreamConnections.length > 0 &&
    downstreamConnections.length <= 12 &&
    routeDownstreamConnections
  ) {
    const downstreamConnectionNames = new Set(
      downstreamConnections.map((connection) => connection.name),
    )
    const downstreamInput: SimpleRouteJson = {
      ...fanoutSrj,
      connections: downstreamConnections,
      buses: fanoutSrj.buses
        ?.map((bus) => ({
          ...bus,
          connectionNames: bus.connectionNames.filter((connectionName) =>
            downstreamConnectionNames.has(connectionName),
          ),
        }))
        .filter((bus) => bus.connectionNames.length > 0),
      obstacles: fanoutSrj.obstacles,
      traces: directSrj.traces,
    }
    try {
      const candidates = routeDownstreamConnections(downstreamInput, { effort })
      downstreamTraces = acceptDownstreamTraces({
        inputSrj,
        fanoutSrj,
        localTraces: [...bestLocalAttempt.traces, ...directDownstreamTraces],
        candidates: candidates.filter((trace) =>
          downstreamConnectionNames.has(trace.connection_name),
        ),
        clearance,
        allowBlindAndBuriedVias,
      })
    } catch (error) {
      errors.push(
        `Downstream router failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else if (!baselineDrc.valid && downstreamConnections.length > 0) {
    errors.push(
      "Skipped downstream router because the endpoint-completion baseline failed emitted-copper DRC",
    )
  } else if (downstreamConnections.length > 12) {
    errors.push(
      `Skipped downstream router for ${downstreamConnections.length} unresolved connections (bounded at 12)`,
    )
  } else if (downstreamConnections.length > 0 && !routeDownstreamConnections) {
    errors.push(
      `Skipped downstream router for ${downstreamConnections.length} unresolved connections because no routeDownstreamConnections callback was provided`,
    )
  }

  const traces = [
    ...bestLocalAttempt.traces,
    ...directDownstreamTraces,
    ...downstreamTraces,
  ]
  for (const plan of downstreamPlans) {
    const currentSrj = {
      ...fanoutSrj,
      traces: [...(fanoutSrj.traces ?? []), ...traces],
    }
    if (
      connectionIsComplete(
        validateOriginalEndpointConnectivity({
          inputSrj,
          routedSrj: currentSrj,
        }),
        plan.connectionName,
      )
    ) {
      continue
    }
    const terminalBranch = findDownstreamTerminalBranch({
      inputSrj,
      fanoutSrj,
      plan,
      acceptedTraces: traces,
      traceWidth,
      viaDiameter,
      viaHoleDiameter,
      clearance,
      allowBlindAndBuriedVias,
    })
    if (terminalBranch) traces.push(terminalBranch)
  }
  const untrimmedSimpleRouteJson = {
    ...fanoutSrj,
    traces: [...(fanoutSrj.traces ?? []), ...traces],
  }
  const simpleRouteJson = trimCompletedFanoutTails({
    fanoutSrj: untrimmedSimpleRouteJson,
    completionTraces: traces,
  })
  const connectivity = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: simpleRouteJson,
  })
  const drc = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: simpleRouteJson,
    clearance,
    allowBlindAndBuriedVias,
  })
  if (!drc.valid) {
    errors.push("Final endpoint-completion output failed emitted-copper DRC")
    return {
      simpleRouteJson: fanoutSrj,
      traces: [],
      report: {
        attemptedLocalConnectionCount: localPlans.length,
        attemptedDownstreamConnectionCount: downstreamPlans.length,
        completionTraceCount: 0,
        searchPassCount,
        errors,
        connectivity: validateOriginalEndpointConnectivity({
          inputSrj,
          routedSrj: fanoutSrj,
        }),
        drc: baselineDrc,
      },
    }
  }
  return {
    simpleRouteJson,
    traces,
    report: {
      attemptedLocalConnectionCount: localPlans.length,
      attemptedDownstreamConnectionCount: downstreamPlans.length,
      completionTraceCount: traces.length,
      searchPassCount,
      errors,
      connectivity,
      drc,
    },
  }
}

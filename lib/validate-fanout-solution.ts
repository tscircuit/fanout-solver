import type {
  ConnectionPoint,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
  segmentsAreClear,
} from "./geometry"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import type {
  Bounds,
  FanoutRoutePlan,
  FanoutValidationIssue,
  FanoutValidationReport,
  Point2D,
  PreparedBus,
  RoutedSegment,
} from "./types"

const EPSILON = 1e-6

function pointsMatch(first: Point2D, second: Point2D): boolean {
  return distance(first, second) <= EPSILON
}

function getPointLayers(point: ConnectionPoint): string[] {
  return "layer" in point ? [point.layer] : point.layers
}

function connectionPointsMatch(
  first: ConnectionPoint,
  second: ConnectionPoint,
): boolean {
  return (
    pointsMatch(first, second) &&
    getPointLayers(first).join("\0") === getPointLayers(second).join("\0") &&
    first.pointId === second.pointId &&
    first.pcb_port_id === second.pcb_port_id
  )
}

function pointIsOnBoundary(point: Point2D, boundary: Bounds): boolean {
  const inside =
    point.x >= boundary.minX - EPSILON &&
    point.x <= boundary.maxX + EPSILON &&
    point.y >= boundary.minY - EPSILON &&
    point.y <= boundary.maxY + EPSILON
  const onEdge =
    Math.abs(point.x - boundary.minX) <= EPSILON ||
    Math.abs(point.x - boundary.maxX) <= EPSILON ||
    Math.abs(point.y - boundary.minY) <= EPSILON ||
    Math.abs(point.y - boundary.maxY) <= EPSILON
  return inside && onEdge
}

function pointIsInsideBounds(point: Point2D, bounds: Bounds): boolean {
  return (
    point.x >= bounds.minX - EPSILON &&
    point.x <= bounds.maxX + EPSILON &&
    point.y >= bounds.minY - EPSILON &&
    point.y <= bounds.maxY + EPSILON
  )
}

function addIssue(
  issues: FanoutValidationIssue[],
  code: FanoutValidationIssue["code"],
  message: string,
  plan?: FanoutRoutePlan,
  otherConnectionName?: string,
): void {
  issues.push({
    code,
    message,
    ...(plan
      ? {
          connectionName: plan.connectionName,
          busId: plan.busId,
        }
      : {}),
    ...(otherConnectionName ? { otherConnectionName } : {}),
  })
}

function extractTraceSegments(params: {
  trace: SimplifiedPcbTrace
  plan: FanoutRoutePlan
  issues: FanoutValidationIssue[]
}): RoutedSegment[] {
  const { trace, plan, issues } = params
  const segments: RoutedSegment[] = []
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined
  let pendingVia:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "via" }>
    | undefined

  for (const routePoint of trace.route) {
    if (routePoint.route_type === "via") {
      if (
        !previousWire ||
        !pointsMatch(previousWire, routePoint) ||
        previousWire.layer !== routePoint.from_layer
      ) {
        addIssue(
          issues,
          "disconnected-trace",
          `Trace ${trace.pcb_trace_id} reaches a via without a matching ${routePoint.from_layer} wire endpoint`,
          plan,
        )
      }
      pendingVia = routePoint
      continue
    }
    if (routePoint.route_type !== "wire") {
      addIssue(
        issues,
        "unsupported-route-point",
        `Trace ${trace.pcb_trace_id} contains unsupported ${routePoint.route_type} geometry`,
        plan,
      )
      continue
    }

    if (pendingVia) {
      if (
        !pointsMatch(routePoint, pendingVia) ||
        routePoint.layer !== pendingVia.to_layer
      ) {
        addIssue(
          issues,
          "disconnected-trace",
          `Trace ${trace.pcb_trace_id} does not continue from its via on ${pendingVia.to_layer}`,
          plan,
        )
      }
      previousWire = routePoint
      pendingVia = undefined
      continue
    }

    if (previousWire) {
      if (previousWire.layer !== routePoint.layer) {
        addIssue(
          issues,
          "disconnected-trace",
          `Trace ${trace.pcb_trace_id} changes from ${previousWire.layer} to ${routePoint.layer} without a via`,
          plan,
        )
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
    addIssue(
      issues,
      "disconnected-trace",
      `Trace ${trace.pcb_trace_id} ends at a via without a wire on ${pendingVia.to_layer}`,
      plan,
    )
  }
  return segments
}

function validatePlanStructure(params: {
  plan: FanoutRoutePlan
  preparedBus: PreparedBus | undefined
  inputSrj: SimpleRouteJson
  outputSrj: SimpleRouteJson
  sharedBoundary: Bounds
  issues: FanoutValidationIssue[]
}): void {
  const { plan, preparedBus, inputSrj, outputSrj, sharedBoundary, issues } =
    params
  const inputConnection = inputSrj.connections[plan.connectionIndex]
  if (!inputConnection || inputConnection.name !== plan.connectionName) {
    addIssue(
      issues,
      "connection-mismatch",
      `Plan index ${plan.connectionIndex} does not identify connection ${plan.connectionName}`,
      plan,
    )
    return
  }
  const preparedConnection = preparedBus?.connections.find(
    (connection) => connection.connectionIndex === plan.connectionIndex,
  )
  if (
    !preparedConnection ||
    preparedConnection.sourcePointIndex !== plan.sourcePointIndex ||
    !connectionPointsMatch(preparedConnection.sourcePoint, plan.sourcePoint) ||
    preparedConnection.sourceObstacle.obstacleId !==
      plan.sourceObstacle.obstacleId
  ) {
    addIssue(
      issues,
      "source-mismatch",
      `Plan ${plan.connectionName} does not start at its prepared component endpoint`,
      plan,
    )
  }
  if (preparedBus?.termination.type !== plan.termination.type) {
    addIssue(
      issues,
      "termination-mismatch",
      `Plan ${plan.connectionName} does not use its bus termination`,
      plan,
    )
  }
  if (plan.segments.length === 0 || plan.length <= EPSILON) {
    addIssue(
      issues,
      "not-broken-out",
      `Plan ${plan.connectionName} has no non-zero escape geometry`,
      plan,
    )
  } else {
    const routableBounds = {
      minX: Math.min(inputSrj.bounds.minX, sharedBoundary.minX),
      maxX: Math.max(inputSrj.bounds.maxX, sharedBoundary.maxX),
      minY: Math.min(inputSrj.bounds.minY, sharedBoundary.minY),
      maxY: Math.max(inputSrj.bounds.maxY, sharedBoundary.maxY),
    }
    if (
      plan.segments.some(
        (segment) =>
          !pointIsInsideBounds(segment.start, routableBounds) ||
          !pointIsInsideBounds(segment.end, routableBounds),
      )
    ) {
      addIssue(
        issues,
        "outside-routing-bounds",
        `Plan ${plan.connectionName} leaves the routable SRJ/shared-boundary area`,
        plan,
      )
    }
    if (!pointsMatch(plan.segments[0]!.start, plan.sourcePoint)) {
      addIssue(
        issues,
        "disconnected-trace",
        `Plan ${plan.connectionName} does not start at its source pad`,
        plan,
      )
    }
    if (!pointsMatch(plan.segments.at(-1)!.end, plan.exitPoint)) {
      addIssue(
        issues,
        "disconnected-trace",
        `Plan ${plan.connectionName} does not end at its declared exit`,
        plan,
      )
    }
    for (let index = 1; index < plan.segments.length; index++) {
      const previous = plan.segments[index - 1]!
      const current = plan.segments[index]!
      if (!pointsMatch(previous.end, current.start)) {
        addIssue(
          issues,
          "disconnected-trace",
          `Plan ${plan.connectionName} has a gap between route segments`,
          plan,
        )
      }
      if (
        previous.layer !== current.layer &&
        (!plan.via ||
          !pointsMatch(previous.end, plan.via.center) ||
          !plan.via.spanLayers.includes(previous.layer) ||
          !plan.via.spanLayers.includes(current.layer))
      ) {
        addIssue(
          issues,
          "disconnected-trace",
          `Plan ${plan.connectionName} changes layers without a connecting via`,
          plan,
        )
      }
    }
  }

  const traceSegments = extractTraceSegments({
    trace: plan.trace,
    plan,
    issues,
  })
  if (
    traceSegments.length !== plan.segments.length ||
    traceSegments.some((segment, index) => {
      const declared = plan.segments[index]
      return (
        !declared ||
        segment.layer !== declared.layer ||
        Math.abs(segment.width - declared.width) > EPSILON ||
        !pointsMatch(segment.start, declared.start) ||
        !pointsMatch(segment.end, declared.end)
      )
    })
  ) {
    addIssue(
      issues,
      "trace-plan-mismatch",
      `Trace ${plan.trace.pcb_trace_id} does not encode its declared route segments`,
      plan,
    )
  }

  const firstRoutePoint = plan.trace.route.find(
    (routePoint): routePoint is Extract<typeof routePoint, { x: number }> =>
      "x" in routePoint && "y" in routePoint,
  )
  const lastRoutePoint = [...plan.trace.route]
    .reverse()
    .find(
      (routePoint): routePoint is Extract<typeof routePoint, { x: number }> =>
        "x" in routePoint && "y" in routePoint,
    )
  if (
    !firstRoutePoint ||
    !lastRoutePoint ||
    !pointsMatch(firstRoutePoint, plan.sourcePoint) ||
    !pointsMatch(lastRoutePoint, plan.exitPoint)
  ) {
    addIssue(
      issues,
      "disconnected-trace",
      `Trace ${plan.trace.pcb_trace_id} does not span its source and exit`,
      plan,
    )
  }

  const outputConnection = outputSrj.connections.find(
    (connection) => connection.name === plan.connectionName,
  )
  if (plan.termination.type === "boundary") {
    if (!outputConnection) {
      addIssue(
        issues,
        "output-connection-missing",
        `Boundary connection ${plan.connectionName} was removed from the output`,
        plan,
      )
    } else {
      const outputSource =
        outputConnection.pointsToConnect[plan.sourcePointIndex]
      if (
        !outputSource ||
        !pointsMatch(outputSource, plan.exitPoint) ||
        !("layer" in outputSource) ||
        outputSource.layer !== plan.targetLayer
      ) {
        addIssue(
          issues,
          "output-exit-mismatch",
          `Output connection ${plan.connectionName} is not attached to its fanout exit`,
          plan,
        )
      }
      for (
        let index = 0;
        index < inputConnection.pointsToConnect.length;
        index++
      ) {
        if (index === plan.sourcePointIndex) continue
        const inputPoint = inputConnection.pointsToConnect[index]
        const outputPoint = outputConnection.pointsToConnect[index]
        if (
          !inputPoint ||
          !outputPoint ||
          !connectionPointsMatch(inputPoint, outputPoint)
        ) {
          addIssue(
            issues,
            "downstream-endpoint-lost",
            `Output connection ${plan.connectionName} did not retain downstream endpoint ${index}`,
            plan,
          )
        }
      }
    }
  } else if (outputConnection) {
    addIssue(
      issues,
      "plane-connection-retained",
      `Plane-terminated connection ${plan.connectionName} remains in the output`,
      plan,
    )
  }
}

function plansHaveConnectedCopper(
  first: FanoutRoutePlan,
  second: FanoutRoutePlan,
): boolean {
  for (const firstSegment of first.segments) {
    for (const secondSegment of second.segments) {
      if (
        firstSegment.layer === secondSegment.layer &&
        distanceSegmentToSegment(
          firstSegment.start,
          firstSegment.end,
          secondSegment.start,
          secondSegment.end,
        ) <=
          (firstSegment.width + secondSegment.width) / 2 + EPSILON
      ) {
        return true
      }
    }
    if (
      second.via?.spanLayers.includes(firstSegment.layer) &&
      distancePointToSegment(
        second.via.center,
        firstSegment.start,
        firstSegment.end,
      ) <=
        second.via.diameter / 2 + firstSegment.width / 2 + EPSILON
    ) {
      return true
    }
  }
  if (first.via) {
    for (const secondSegment of second.segments) {
      if (
        first.via.spanLayers.includes(secondSegment.layer) &&
        distancePointToSegment(
          first.via.center,
          secondSegment.start,
          secondSegment.end,
        ) <=
          first.via.diameter / 2 + secondSegment.width / 2 + EPSILON
      ) {
        return true
      }
    }
    if (
      second.via &&
      first.via.spanLayers.some((layer) =>
        second.via!.spanLayers.includes(layer),
      ) &&
      distance(first.via.center, second.via.center) <=
        (first.via.diameter + second.via.diameter) / 2 + EPSILON
    ) {
      return true
    }
  }
  return false
}

function validateBreakoutConnectivity(params: {
  plans: readonly FanoutRoutePlan[]
  inputSrj: SimpleRouteJson
  sharedBoundary: Bounds
  issues: FanoutValidationIssue[]
}): Set<FanoutRoutePlan> {
  const { plans, inputSrj, sharedBoundary, issues } = params
  const connectedPlans = new Set<FanoutRoutePlan>()
  const neighboringPlans = new Map<FanoutRoutePlan, FanoutRoutePlan[]>()
  for (const plan of plans) neighboringPlans.set(plan, [])

  for (let firstIndex = 0; firstIndex < plans.length; firstIndex++) {
    const first = plans[firstIndex]!
    if (
      first.termination.type === "plane"
        ? Boolean(first.via)
        : first.segments.some(
            (segment) =>
              pointIsOnBoundary(segment.start, sharedBoundary) ||
              pointIsOnBoundary(segment.end, sharedBoundary),
          )
    ) {
      connectedPlans.add(first)
    }
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < plans.length;
      secondIndex++
    ) {
      const second = plans[secondIndex]!
      if (
        !connectionsShareElectricalNet(
          inputSrj,
          first.connectionName,
          second.connectionName,
        ) ||
        !plansHaveConnectedCopper(first, second)
      ) {
        continue
      }
      neighboringPlans.get(first)!.push(second)
      neighboringPlans.get(second)!.push(first)
    }
  }

  const queue = [...connectedPlans]
  while (queue.length > 0) {
    const plan = queue.shift()!
    for (const neighbor of neighboringPlans.get(plan) ?? []) {
      if (connectedPlans.has(neighbor)) continue
      connectedPlans.add(neighbor)
      queue.push(neighbor)
    }
  }

  for (const plan of plans) {
    if (connectedPlans.has(plan)) continue
    addIssue(
      issues,
      "not-broken-out",
      plan.termination.type === "boundary"
        ? `Connection ${plan.connectionName} has no continuous same-net copper path to the shared boundary`
        : `Plane connection ${plan.connectionName} has no terminating via`,
      plan,
    )
  }
  return connectedPlans
}

function validateClearances(params: {
  plans: readonly FanoutRoutePlan[]
  inputSrj: SimpleRouteJson
  clearance: number
  issues: FanoutValidationIssue[]
}): void {
  const { plans, inputSrj, clearance, issues } = params
  for (const plan of plans) {
    for (
      let segmentIndex = 0;
      segmentIndex < plan.segments.length;
      segmentIndex++
    ) {
      const segment = plan.segments[segmentIndex]!
      for (const obstacle of inputSrj.obstacles) {
        if (!obstacle.layers.includes(segment.layer)) continue
        if (
          obstacleSharesElectricalNet(inputSrj, obstacle, plan.connectionName)
        ) {
          continue
        }
        if (
          segmentIndex === 0 &&
          obstacle.obstacleId === plan.sourceObstacle.obstacleId &&
          segment.layer === plan.sourceLayer
        ) {
          continue
        }
        const actual = distanceSegmentToObstacle(segment, obstacle)
        const required = segment.width / 2 + clearance
        if (actual < required - 1e-9) {
          addIssue(
            issues,
            "obstacle-clearance",
            `Trace ${plan.connectionName} on ${segment.layer} is ${actual.toFixed(4)}mm from different-net obstacle ${obstacle.obstacleId}; ${required.toFixed(4)}mm is required`,
            plan,
          )
        }
      }
    }
    if (plan.via) {
      for (const obstacle of inputSrj.obstacles) {
        if (
          !obstacle.layers.some((layer) =>
            plan.via!.spanLayers.includes(layer),
          ) ||
          obstacleSharesElectricalNet(inputSrj, obstacle, plan.connectionName)
        ) {
          continue
        }
        const actual = distancePointToObstacle(plan.via.center, obstacle)
        const required = plan.via.diameter / 2 + clearance
        if (actual < required - 1e-9) {
          addIssue(
            issues,
            "via-obstacle-clearance",
            `Via ${plan.connectionName} is ${actual.toFixed(4)}mm from different-net obstacle ${obstacle.obstacleId} on its layer span; ${required.toFixed(4)}mm is required`,
            plan,
          )
        }
      }
    }
  }

  for (let firstIndex = 0; firstIndex < plans.length; firstIndex++) {
    const first = plans[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < plans.length;
      secondIndex++
    ) {
      const second = plans[secondIndex]!
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
          if (!segmentsAreClear(firstSegment, secondSegment, clearance)) {
            addIssue(
              issues,
              "different-net-trace-clearance",
              `Different-net traces ${first.connectionName} and ${second.connectionName} intersect or violate clearance on ${firstSegment.layer}`,
              first,
              second.connectionName,
            )
          }
        }
        if (
          second.via?.spanLayers.includes(firstSegment.layer) &&
          distancePointToSegment(
            second.via.center,
            firstSegment.start,
            firstSegment.end,
          ) <
            second.via.diameter / 2 + firstSegment.width / 2 + clearance - 1e-9
        ) {
          addIssue(
            issues,
            "different-net-trace-via-clearance",
            `Trace ${first.connectionName} violates via clearance to ${second.connectionName} on ${firstSegment.layer}`,
            first,
            second.connectionName,
          )
        }
      }
      if (first.via) {
        for (const secondSegment of second.segments) {
          if (
            first.via.spanLayers.includes(secondSegment.layer) &&
            distancePointToSegment(
              first.via.center,
              secondSegment.start,
              secondSegment.end,
            ) <
              first.via.diameter / 2 +
                secondSegment.width / 2 +
                clearance -
                1e-9
          ) {
            addIssue(
              issues,
              "different-net-trace-via-clearance",
              `Via ${first.connectionName} violates trace clearance to ${second.connectionName} on ${secondSegment.layer}`,
              first,
              second.connectionName,
            )
          }
        }
        if (
          second.via &&
          first.via.spanLayers.some((layer) =>
            second.via!.spanLayers.includes(layer),
          ) &&
          distance(first.via.center, second.via.center) <
            (first.via.diameter + second.via.diameter) / 2 + clearance - 1e-9
        ) {
          addIssue(
            issues,
            "different-net-via-clearance",
            `Vias ${first.connectionName} and ${second.connectionName} violate clearance on an overlapping layer span`,
            first,
            second.connectionName,
          )
        }
      }
    }
  }
}

export function validateFanoutSolution(params: {
  inputSrj: SimpleRouteJson
  outputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  sharedBoundary: Bounds
  clearance: number
}): FanoutValidationReport {
  const {
    inputSrj,
    outputSrj,
    plans,
    preparedBuses,
    sharedBoundary,
    clearance,
  } = params
  const issues: FanoutValidationIssue[] = []
  const plansByConnection = new Map<string, FanoutRoutePlan[]>()
  const preparedBusById = new Map(preparedBuses.map((bus) => [bus.busId, bus]))
  for (const plan of plans) {
    const connectionPlans = plansByConnection.get(plan.connectionName) ?? []
    connectionPlans.push(plan)
    plansByConnection.set(plan.connectionName, connectionPlans)
  }

  for (const connection of inputSrj.connections) {
    const connectionPlans = plansByConnection.get(connection.name) ?? []
    if (connectionPlans.length === 0) {
      addIssue(
        issues,
        "missing-plan",
        `Connection ${connection.name} has no fanout plan`,
      )
    } else if (connectionPlans.length > 1) {
      addIssue(
        issues,
        "duplicate-plan",
        `Connection ${connection.name} has ${connectionPlans.length} fanout plans`,
        connectionPlans[0],
      )
    }
  }
  for (const plan of plans) {
    if (
      !inputSrj.connections.some(
        (connection) => connection.name === plan.connectionName,
      )
    ) {
      addIssue(
        issues,
        "unknown-plan",
        `Plan ${plan.connectionName} is not an input connection`,
        plan,
      )
      continue
    }
    validatePlanStructure({
      plan,
      preparedBus: preparedBusById.get(plan.busId),
      inputSrj,
      outputSrj,
      sharedBoundary,
      issues,
    })
  }
  const connectedPlans = validateBreakoutConnectivity({
    plans,
    inputSrj,
    sharedBoundary,
    issues,
  })
  validateClearances({ plans, inputSrj, clearance, issues })

  return {
    valid: issues.length === 0,
    checkedConnectionCount: inputSrj.connections.length,
    brokenOutConnectionCount: new Set(
      [...connectedPlans].map((plan) => plan.connectionName),
    ).size,
    issues,
  }
}

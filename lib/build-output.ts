import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { createFanoutOutputIds } from "./fanout-output-ids"
import type { FanoutRoutePlan, SimpleRouteJsonWithFanoutPlanes } from "./types"

function createViaObstacle(
  plan: FanoutRoutePlan,
  layerNames: string[],
  endpoint = false,
): Obstacle | null {
  const via = endpoint ? plan.planeEndpointVia : plan.via
  if (!via) return null
  const zLayers = via.spanLayers.map((layer) => {
    const layerIndex = layerNames.indexOf(layer)
    if (layerIndex < 0) {
      throw new Error(
        `FanoutSolver: via for "${plan.connectionName}" uses unknown layer "${layer}"`,
      )
    }
    return layerIndex
  })
  const outputIds = createFanoutOutputIds(plan)
  return {
    obstacleId: endpoint
      ? outputIds.planeEndpointViaObstacleId
      : outputIds.viaObstacleId,
    type: "rect",
    center: via.center,
    width: via.diameter,
    height: via.diameter,
    layers: via.spanLayers,
    zLayers,
    __zLayers: zLayers,
    connectedTo: [plan.connectionName, plan.trace.pcb_trace_id],
  }
}

export function buildOutputSimpleRouteJson(params: {
  inputSrj: SimpleRouteJson
  plans: FanoutRoutePlan[]
  layerNames: string[]
}): SimpleRouteJsonWithFanoutPlanes {
  const { inputSrj, plans, layerNames } = params
  const outputConnections = inputSrj.connections.map((connection) => ({
    ...connection,
    pointsToConnect: connection.pointsToConnect.map((point) => ({ ...point })),
  }))
  const viaObstacles: Obstacle[] = []
  const planeTerminatedConnectionNames = new Set<string>()

  for (const plan of plans) {
    const connection = outputConnections[plan.connectionIndex]
    if (!connection) {
      throw new Error(
        `FanoutSolver: output connection index ${plan.connectionIndex} is missing`,
      )
    }
    const outputIds = createFanoutOutputIds(plan)
    connection.pointsToConnect[plan.sourcePointIndex] = {
      x: plan.exitPoint.x,
      y: plan.exitPoint.y,
      layer: plan.targetLayer,
      pointId:
        plan.termination.type === "plane"
          ? outputIds.planeExitPointId
          : outputIds.boundaryExitPointId,
    }
    if (plan.termination.type === "plane") {
      planeTerminatedConnectionNames.add(plan.connectionName)
    }
    const viaObstacle = createViaObstacle(plan, layerNames)
    if (viaObstacle) viaObstacles.push(viaObstacle)
    const endpointViaObstacle = createViaObstacle(plan, layerNames, true)
    if (endpointViaObstacle) viaObstacles.push(endpointViaObstacle)
  }
  const planTraces = plans.flatMap((plan) => [
    plan.trace,
    ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
  ])
  const coordinateRoutePoints = planTraces.flatMap((trace) =>
    trace.route.filter(
      (
        routePoint,
      ): routePoint is Extract<typeof routePoint, { x: number; y: number }> =>
        "x" in routePoint && "y" in routePoint,
    ),
  )
  const boundsMargin = Math.max(
    inputSrj.defaultObstacleMargin ?? 0,
    inputSrj.minTraceWidth,
  )
  const outputBounds =
    coordinateRoutePoints.length === 0
      ? { ...inputSrj.bounds }
      : {
          minX: Math.min(
            inputSrj.bounds.minX,
            ...coordinateRoutePoints.map(
              (routePoint) => routePoint.x - boundsMargin,
            ),
          ),
          maxX: Math.max(
            inputSrj.bounds.maxX,
            ...coordinateRoutePoints.map(
              (routePoint) => routePoint.x + boundsMargin,
            ),
          ),
          minY: Math.min(
            inputSrj.bounds.minY,
            ...coordinateRoutePoints.map(
              (routePoint) => routePoint.y - boundsMargin,
            ),
          ),
          maxY: Math.max(
            inputSrj.bounds.maxY,
            ...coordinateRoutePoints.map(
              (routePoint) => routePoint.y + boundsMargin,
            ),
          ),
        }

  return {
    ...inputSrj,
    fanoutPlaneConnectivity: plans.flatMap((plan) =>
      plan.termination.type === "plane"
        ? [
            {
              connectionName: plan.connectionName,
              layer: plan.termination.layer,
            },
          ]
        : [],
    ),
    bounds: outputBounds,
    connections: outputConnections.filter(
      (connection) => !planeTerminatedConnectionNames.has(connection.name),
    ),
    buses: inputSrj.buses
      ?.map((bus) => ({
        ...bus,
        connectionNames: bus.connectionNames.filter(
          (connectionName) =>
            !planeTerminatedConnectionNames.has(connectionName),
        ),
      }))
      .filter((bus) => bus.connectionNames.length > 0),
    obstacles: [
      ...inputSrj.obstacles.map((obstacle) => ({
        ...obstacle,
        center: { ...obstacle.center },
        layers: [...obstacle.layers],
        connectedTo: [...obstacle.connectedTo],
      })),
      ...viaObstacles,
    ],
    traces: [
      ...(inputSrj.traces ?? []).map((trace) => ({
        ...trace,
        route: trace.route.map((routePoint) => ({ ...routePoint })),
      })),
      ...planTraces,
    ],
  }
}

import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutRoutePlan } from "./types"

function createViaObstacle(
  plan: FanoutRoutePlan,
  layerNames: string[],
): Obstacle | null {
  if (!plan.via) return null
  const zLayers = plan.via.spanLayers.map((layer) => {
    const layerIndex = layerNames.indexOf(layer)
    if (layerIndex < 0) {
      throw new Error(
        `FanoutSolver: via for "${plan.connectionName}" uses unknown layer "${layer}"`,
      )
    }
    return layerIndex
  })
  return {
    obstacleId: `fanout-via:${plan.connectionName}`,
    type: "rect",
    center: plan.via.center,
    width: plan.via.diameter,
    height: plan.via.diameter,
    layers: plan.via.spanLayers,
    zLayers,
    __zLayers: zLayers,
    connectedTo: [plan.connectionName, plan.trace.pcb_trace_id],
  }
}

export function buildOutputSimpleRouteJson(params: {
  inputSrj: SimpleRouteJson
  plans: FanoutRoutePlan[]
  layerNames: string[]
}): SimpleRouteJson {
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
    connection.pointsToConnect[plan.sourcePointIndex] = {
      x: plan.exitPoint.x,
      y: plan.exitPoint.y,
      layer: plan.targetLayer,
      pointId:
        plan.termination.type === "plane"
          ? `fanout-plane:${plan.connectionName}`
          : `fanout-exit:${plan.connectionName}`,
    }
    if (plan.termination.type === "plane") {
      planeTerminatedConnectionNames.add(plan.connectionName)
    }
    const viaObstacle = createViaObstacle(plan, layerNames)
    if (viaObstacle) viaObstacles.push(viaObstacle)
  }
  const coordinateRoutePoints = plans.flatMap((plan) =>
    plan.trace.route.filter(
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
      ...plans.map((plan) => plan.trace),
    ],
  }
}

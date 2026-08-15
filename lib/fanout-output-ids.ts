export interface FanoutOutputIds {
  boundaryExitPointId: string
  planeExitPointId: string
  traceId: string
  viaObstacleId: string
  planeEndpointPointId: string
  planeEndpointTraceId: string
  planeEndpointViaObstacleId: string
}

export function createFanoutOutputIds(input: {
  connectionName: string
  sourcePointIndex: number
}): FanoutOutputIds {
  const endpointKey = `${input.connectionName}:source-${input.sourcePointIndex}`
  return {
    boundaryExitPointId: `fanout-exit:${endpointKey}`,
    planeExitPointId: `fanout-plane:${endpointKey}`,
    traceId: `fanout:${endpointKey}`,
    viaObstacleId: `fanout-via:${endpointKey}`,
    planeEndpointPointId: `fanout-plane-endpoint-point:${endpointKey}`,
    planeEndpointTraceId: `fanout-plane-endpoint:${endpointKey}`,
    planeEndpointViaObstacleId: `fanout-plane-endpoint-via:${endpointKey}`,
  }
}

export function createFanoutCompletionTraceId(input: {
  connectionName: string
  sourcePointIndex: number
  candidateIndex: number
}): string {
  return `fanout-completion:${input.connectionName}:source-${input.sourcePointIndex}:${input.candidateIndex}`
}

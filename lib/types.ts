import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteBus,
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"

export type FanoutDirection = "left" | "right" | "up" | "down"

export interface FanoutBusSpec extends SimpleRouteBus {
  direction?: FanoutDirection
}

export interface FanoutSolverOptions {
  buses?: FanoutBusSpec[]
  busDirections?: Readonly<Record<string, FanoutDirection>>
  escapeLayers?: string[]
  maxLayerCombinations?: number
  traceWidth?: number
  viaDiameter?: number
  viaHoleDiameter?: number
  clearance?: number
  breakoutMargin?: number
}

export interface FanoutAttemptSummary {
  assignmentIndex: number
  busLayerAssignments: Readonly<Record<string, string>>
  routedBusCount: number
  routedConnectionCount: number
  failedBusIds: string[]
  score: number
}

export interface FanoutSolverOutput {
  simpleRouteJson: SimpleRouteJson
  fanoutTraces: SimplifiedPcbTrace[]
  busLayerAssignments: Readonly<Record<string, string>>
  busDirections: Readonly<Record<string, FanoutDirection>>
  attempts: FanoutAttemptSummary[]
}

export interface Point2D {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface PreparedConnection {
  connection: SimpleRouteConnection
  connectionIndex: number
  sourcePoint: ConnectionPoint
  sourcePointIndex: number
  sourceLayer: string
  sourceObstacle: Obstacle
  targetPoint: ConnectionPoint
}

export interface PreparedBus {
  busId: string
  direction: FanoutDirection
  connections: PreparedConnection[]
  componentId: string
  componentObstacles: Obstacle[]
  componentBounds: Bounds
  pitchX: number
  pitchY: number
}

export interface RoutedSegment {
  start: Point2D
  end: Point2D
  width: number
  layer: string
}

export interface RoutedVia {
  center: Point2D
  diameter: number
  holeDiameter: number
  fromLayer: string
  toLayer: string
  spanLayers: string[]
}

export interface FanoutRoutePlan {
  busId: string
  connectionName: string
  connectionIndex: number
  sourcePointIndex: number
  sourcePoint: ConnectionPoint
  sourceObstacle: Obstacle
  sourceLayer: string
  targetLayer: string
  direction: FanoutDirection
  exitPoint: Point2D
  trace: SimplifiedPcbTrace
  segments: RoutedSegment[]
  via?: RoutedVia
  length: number
}

export interface AssignmentAttempt {
  summary: FanoutAttemptSummary
  plans: FanoutRoutePlan[]
  outputSrj: SimpleRouteJson
}

import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteBus,
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"

export type FanoutDirection = "left" | "right" | "up" | "down"

export type FanoutEdge = "left" | "right" | "top" | "bottom"

export type FanoutCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"

export type FanoutBorderTarget = FanoutEdge | FanoutCorner

/**
 * A directed region of the shared fanout boundary. Corner regions are named
 * after the edge they belong to, so `top_left` exits through the top edge and
 * `left_top` exits through the left edge.
 */
export type FanoutAvailableCornerAndSide =
  | "top_left"
  | "top_middle"
  | "top_right"
  | "right_top"
  | "right_middle"
  | "right_bottom"
  | "bottom_right"
  | "bottom_middle"
  | "bottom_left"
  | "left_bottom"
  | "left_middle"
  | "left_top"

/** Convenient aliases for the middle region of each boundary edge. */
export type FanoutAvailableCornerAndSideAlias = FanoutEdge

export type FanoutAvailableCornerAndSideInput =
  | FanoutAvailableCornerAndSide
  | FanoutAvailableCornerAndSideAlias

export type FanoutBorderDistribution = "preserve" | "even"

export type FanoutBusTermination =
  | {
      type: "boundary"
    }
  | {
      type: "plane"
      layer: string
    }

export interface FanoutBusSpec extends SimpleRouteBus {
  /** Component whose connection endpoints should be escaped. */
  sourceComponentId?: string
  direction?: FanoutDirection
  preferredExit?: FanoutBorderTarget
  /**
   * Defaults to `{ type: "boundary" }`.
   *
   * Plane-terminated connections are considered complete at their escaped via
   * and are removed from the downstream SimpleRouteJson connection list.
   */
  termination?: FanoutBusTermination
}

export interface FanoutSolverOptions {
  buses?: FanoutBusSpec[]
  /** Default source component for every bus in this fanout operation. */
  sourceComponentId?: string
  /** Default direction for every bus in this fanout operation. */
  defaultDirection?: FanoutDirection
  /** Default boundary target for every bus in this fanout operation. */
  defaultPreferredExit?: FanoutBorderTarget
  /**
   * Restricts boundary-terminated buses to these directed boundary regions.
   *
   * For example, `["top_left", "top", "top_right"]` permits exits only
   * through the top edge. `top`, `right`, `bottom`, and `left` are aliases for
   * their respective `*_middle` regions. Omit this option to leave every edge
   * available.
   */
  availableCornersAndSides?: readonly FanoutAvailableCornerAndSideInput[]
  busDirections?: Readonly<Record<string, FanoutDirection>>
  busExitPreferences?: Readonly<Record<string, FanoutBorderTarget>>
  componentBounds?: Readonly<Record<string, Bounds>>
  sharedBoundary?: Bounds
  escapeLayers?: string[]
  maxLayerCombinations?: number
  traceWidth?: number
  viaDiameter?: number
  viaHoleDiameter?: number
  clearance?: number
  compactBusTracks?: boolean
  /** Allow branches belonging to the same electrical net to share copper. */
  allowSameNetMerges?: boolean
  singleLayerPushAndShove?: boolean
  /**
   * When preferred single-layer exits cannot coexist, allow a global
   * same-net-aware pass to choose alternate shared-boundary sides. This
   * fallback currently applies to singleton buses only.
   */
  singleLayerAdaptiveExits?: boolean
  borderDistribution?: FanoutBorderDistribution
}

export interface FanoutAttemptSummary {
  assignmentIndex: number
  busLayerAssignments: Readonly<Record<string, string>>
  routedBusCount: number
  routedConnectionCount: number
  failedBusIds: string[]
  score: number
  validationIssues?: FanoutValidationIssue[]
}

export interface FanoutSolverOutput {
  simpleRouteJson: SimpleRouteJson
  fanoutTraces: SimplifiedPcbTrace[]
  planeTerminations: FanoutPlaneTermination[]
  busLayerAssignments: Readonly<Record<string, string>>
  busDirections: Readonly<Record<string, FanoutDirection>>
  attempts: FanoutAttemptSummary[]
  validation: FanoutValidationReport
}

export interface FanoutValidationIssue {
  code:
    | "missing-plan"
    | "duplicate-plan"
    | "unknown-plan"
    | "connection-mismatch"
    | "source-mismatch"
    | "termination-mismatch"
    | "not-broken-out"
    | "outside-routing-bounds"
    | "disconnected-trace"
    | "unsupported-route-point"
    | "trace-plan-mismatch"
    | "output-connection-missing"
    | "output-exit-mismatch"
    | "downstream-endpoint-lost"
    | "plane-connection-retained"
    | "obstacle-clearance"
    | "via-obstacle-clearance"
    | "different-net-trace-clearance"
    | "different-net-trace-via-clearance"
    | "different-net-via-clearance"
  message: string
  connectionName?: string
  otherConnectionName?: string
  busId?: string
}

export interface FanoutValidationReport {
  valid: boolean
  checkedConnectionCount: number
  brokenOutConnectionCount: number
  issues: FanoutValidationIssue[]
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
  preferredExit?: FanoutBorderTarget
  termination: FanoutBusTermination
  connections: PreparedConnection[]
  componentId: string
  componentObstacles: Obstacle[]
  componentBounds: Bounds
  sharedBoundary: Bounds
  xCoordinates: number[]
  yCoordinates: number[]
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
  termination: FanoutBusTermination
  direction: FanoutDirection
  exitPoint: Point2D
  trace: SimplifiedPcbTrace
  segments: RoutedSegment[]
  via?: RoutedVia
  length: number
}

export interface FanoutPlaneTermination {
  busId: string
  connectionName: string
  layer: string
  via: RoutedVia
}

export interface AssignmentAttempt {
  summary: FanoutAttemptSummary
  plans: FanoutRoutePlan[]
  outputSrj: SimpleRouteJson
}

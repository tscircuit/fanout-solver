import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteBus,
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import type { OriginalEndpointConnectivityReport } from "./validate-original-endpoint-connectivity"
import type { RoutedCopperDrcReport } from "./validate-routed-copper-drc"

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

export interface FanoutDownstreamRouterOptions {
  effort: number
}

/**
 * Optional host-provided router for unresolved connections after the fanout
 * solver's local endpoint-completion passes.
 */
export type FanoutDownstreamRouter = (
  inputSrj: SimpleRouteJson,
  options: FanoutDownstreamRouterOptions,
) => SimplifiedPcbTrace[]

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
   * Preferred downstream routing point for each connection after it leaves the
   * fanout boundary. This is routing guidance only and does not replace the
   * connection's electrical endpoint in SimpleRouteJson.
   *
   * A caller coordinating two fanouts can pass the paired fanout's selected
   * exit here so both sides aim toward the same track.
   */
  connectionExitTargets?: Readonly<Record<string, Point2D>>
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
  /** Balance layer congestion by routed connection count instead of bus count. */
  balanceLayerLoadByConnectionCount?: boolean
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
  /**
   * After every source pad is escaped, attempt to physically join the fanout
   * copper to each original downstream endpoint. Every added trace is audited
   * with the independent endpoint-connectivity and emitted-copper validators.
   */
  completeOriginalEndpoints?: boolean
  /** Effort passed to the optional bounded downstream-router pass. */
  endpointCompletionEffort?: number
  /**
   * Host-provided fallback for unresolved endpoint connections. The fanout
   * package deliberately does not import a board-level autorouter at runtime.
   */
  routeDownstreamConnections?: FanoutDownstreamRouter
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
  completionTraces: SimplifiedPcbTrace[]
  endpointCompletion?: FanoutEndpointCompletionReport
  planeTerminations: FanoutPlaneTermination[]
  busLayerAssignments: Readonly<Record<string, string>>
  busDirections: Readonly<Record<string, FanoutDirection>>
  attempts: FanoutAttemptSummary[]
  validation: FanoutValidationReport
}

export interface FanoutEndpointCompletionReport {
  attemptedLocalConnectionCount: number
  attemptedDownstreamConnectionCount: number
  completionTraceCount: number
  searchPassCount: number
  errors: string[]
  connectivity: OriginalEndpointConnectivityReport
  drc: RoutedCopperDrcReport
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
  /** Preferred downstream point used to choose the boundary exit track. */
  exitTargetPoint?: Point2D
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
  targetPoint: ConnectionPoint
  targetLayer: string
  termination: FanoutBusTermination
  direction: FanoutDirection
  exitPoint: Point2D
  trace: SimplifiedPcbTrace
  segments: RoutedSegment[]
  via?: RoutedVia
  /** Optional capacitor-side dogbone reserved and emitted with a plane escape. */
  planeEndpointTrace?: SimplifiedPcbTrace
  planeEndpointSegments?: RoutedSegment[]
  planeEndpointVia?: RoutedVia
  length: number
}

export interface FanoutPlaneTermination {
  busId: string
  connectionName: string
  layer: string
  via: RoutedVia
}

/**
 * Declares an ideal copper plane used by emitted fanout traces. This metadata
 * lets independent connectivity validation join same-net vias on the named
 * layer without inventing a long point-to-point trace across the plane.
 */
export interface FanoutPlaneConnectivity {
  connectionName: string
  layer: string
}

export type SimpleRouteJsonWithFanoutPlanes = SimpleRouteJson & {
  fanoutPlaneConnectivity?: FanoutPlaneConnectivity[]
}

export interface AssignmentAttempt {
  summary: FanoutAttemptSummary
  plans: FanoutRoutePlan[]
  outputSrj: SimpleRouteJson
}

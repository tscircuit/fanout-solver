import type {
  RouteViaMinimalWindingProgress,
  ViaMinimalWindingReservedVia,
} from "../route-via-minimal-winding"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
} from "../types"
import type { getCornerLaneOffsets } from "./boundary-tracks"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export type RouteBusStaticClearanceCache = Map<PlanClearanceKey, boolean>

export interface RouteBusParams {
  srj: SimpleRouteJson
  /** Prefer source-aligned tracks for compact automatic boundary handoffs. */
  preferSourceTracks?: boolean
  bus: PreparedBus
  targetLayer: string
  acceptedPlans: FanoutRoutePlan[]
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  compactBusTracks: boolean
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  allowSameNetPlaneMerges?: boolean
  staticClearanceCache?: RouteBusStaticClearanceCache
  blockingBusCounts?: Map<BusId, number>
  rejectedViaMinimalCandidates?: FanoutRoutePlan[][]
  stopAfterFirstRejectedViaMinimalCandidate?: boolean
  fixedViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
  /** Complete boundary tracks for this bus, keyed by stable connection identity. */
  fixedBoundaryTracksByConnectionIndex?: ReadonlyMap<number, number>
  /** Actual copper before the first via for previously reserved source escapes. */
  sourceEscapePaths?: ReadonlyMap<number, readonly Point2D[]>
  /** Exact winding spacing for staged narrow-channel routing. */
  windingGridStep?: number
  reservedVias?: readonly ViaMinimalWindingReservedVia[]
  /** Provisional site preferences; successful callers must rematch future vias. */
  softReservedVias?: readonly ViaMinimalWindingReservedVia[]
  viaMinimalOnly?: boolean
  /** Permit a singleton or pair to move provisional vias near the boundary. */
  allowBoundarySideViaFallback?: boolean
  /** Reserve corner tuning space when selecting a boundary-side via. */
  preferCornerBoundaryVia?: boolean
  /** Retry blocked winding terminals ahead of already-routed terminals. */
  adaptiveWindingRouteOrder?: boolean
  /** Preserve pad-lattice channels in the automatic dense routing path. */
  alignWindingGridToPads?: boolean
  /** Bounds the final fixed-via winding fallback after ordered attempts. */
  fixedViaFallbackRouteOrderAttempts?: number
  /** Retry caller-fixed sites while preserving future exit gaps during recovery. */
  allowFixedViaReservedExitFallback?: boolean
  /** Skip this many otherwise-clear plane escapes when enumerating alternatives. */
  planeCandidateSkipCount?: number
  /** Dense corner-band phase that preserves existing lane centers when leading lanes are prepended. */
  cornerBandTargetTrackOffset?: number
  /** Fixed first corner slot, independent of the order in which buses route. */
  cornerExitLaneOffset?: number
  /** Optional search weighting for winding; does not change route validation. */
  windingHeuristicWeight?: number
  /** Permit contact with the shared boundary only at the declared exit. */
  forbidEarlyExitBoundaryContact?: boolean
}

export interface RouteBusAlternativesProgress {
  phase: "via-minimal-winding"
  busId: string
  targetLayer: string
  winding: RouteViaMinimalWindingProgress
}

export type ViaHandedness = -1 | 0 | 1

export interface BuildPlanParams {
  preparedConnection: PreparedConnection
  bus: PreparedBus
  targetLayer: string
  track: number
  exitAxis: number
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  viaHandedness: ViaHandedness
  interstitialEscape: boolean
  spreadLaneIndex: number
  cornerExitLaneOffset: number
  cornerLocalChannelLaneOffset: number
  cornerBoundaryChannelLaneOffset: number
  clearance: number
  terminateAtVia: boolean
  allowBlindAndBuriedVias: boolean
  initialViaPoint?: Point2D
  sourceEscapePath?: readonly Point2D[]
  cornerBandTargetTrackOffset?: number
  fixedBoundaryTracksByConnectionIndex?: ReadonlyMap<number, number>
}

export interface RouteBusBoundaryContext extends RouteBusParams {
  allowBlindAndBuriedVias: NonNullable<
    RouteBusParams["allowBlindAndBuriedVias"]
  >
  allowSameNetMerges: NonNullable<RouteBusParams["allowSameNetMerges"]>
  stopAfterFirstRejectedViaMinimalCandidate: NonNullable<
    RouteBusParams["stopAfterFirstRejectedViaMinimalCandidate"]
  >
  reservedVias: NonNullable<RouteBusParams["reservedVias"]>
  softReservedVias: NonNullable<RouteBusParams["softReservedVias"]>
  viaMinimalOnly: NonNullable<RouteBusParams["viaMinimalOnly"]>
  allowBoundarySideViaFallback: NonNullable<
    RouteBusParams["allowBoundarySideViaFallback"]
  >
  preferCornerBoundaryVia: NonNullable<
    RouteBusParams["preferCornerBoundaryVia"]
  >
  adaptiveWindingRouteOrder: NonNullable<
    RouteBusParams["adaptiveWindingRouteOrder"]
  >
  alignWindingGridToPads: NonNullable<RouteBusParams["alignWindingGridToPads"]>
  fixedViaFallbackRouteOrderAttempts: NonNullable<
    RouteBusParams["fixedViaFallbackRouteOrderAttempts"]
  >
  allowFixedViaReservedExitFallback: NonNullable<
    RouteBusParams["allowFixedViaReservedExitFallback"]
  >
  forbidEarlyExitBoundaryContact: NonNullable<
    RouteBusParams["forbidEarlyExitBoundaryContact"]
  >
  maxAlternatives: number
  includeVisualization: boolean
  exitAxis: number
  targetUsesVia: boolean
  interstitialEscape: boolean
  viaHandednesses: readonly ViaHandedness[]
  alternatives: FanoutRoutePlan[][]
  seenAlternativeKeys: Set<string>
  cornerLaneOffsets: ReturnType<typeof getCornerLaneOffsets>
}

export type CoordinatedTerminalPattern = {
  label: string
  useViaInPad: boolean
  getViaHandedness: (preparedConnection: PreparedConnection) => ViaHandedness
  getViaPoint?: (preparedConnection: PreparedConnection) => Point2D
  maximumRouteOrderAttempts?: number
  windingOrderIndex?: number
  preferTargetDirectedLaneBias?: boolean
  localDogboneRepair?: boolean
  reserveTerminalExitPoints?: boolean
  cornerExitLaneOffset?: number
  allowLayerInterleaving?: boolean
}

export type BusId = PreparedBus["busId"]
export type PlanClearanceKey = string
export type CopperLayer = PreparedConnection["sourceLayer"]

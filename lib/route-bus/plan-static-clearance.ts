import type { CopperLayer } from "./types"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "../geometry"
import { getAllRoutedTraceCopper } from "../get-routed-trace-copper"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "../net-identity"
import type { Bounds, FanoutRoutePlan, RoutedSegment } from "../types"
import { segmentIsLegalTerminalBodyEscape } from "../validate-routed-copper-drc"
import {
  allowsViaInPad,
  getRoutableBounds,
  pointIsInsideBounds,
} from "./directions"
import {
  getPlanSegments,
  getPlanVias,
  viaFitsInsidePlanSourcePad,
} from "./plan-copper"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getBoundsFromPoints } from "@tscircuit/math-utils"

export function segmentIsClearOfObstacles(params: {
  segment: RoutedSegment
  plan: FanoutRoutePlan
  segmentIndex: number
  srj: SimpleRouteJson
  allowSameNetMerges: boolean
  obstacles: Obstacle[]
  clearance: number
}): boolean {
  const {
    segment,
    plan,
    segmentIndex,
    srj,
    allowSameNetMerges,
    obstacles,
    clearance,
  } = params
  const segmentBounds = getBoundsFromPoints([segment.start, segment.end])!
  for (const obstacle of obstacles) {
    if (!obstacle.layers.includes(segment.layer)) continue
    // The half-width plus half-height contains every rotation of the obstacle.
    const obstacleRadiusBound =
      (Math.abs(obstacle.width) + Math.abs(obstacle.height)) / 2
    const broadPhaseDistance =
      obstacleRadiusBound + segment.width / 2 + clearance + 1e-9
    if (
      obstacle.center.x < segmentBounds.minX - broadPhaseDistance ||
      obstacle.center.x > segmentBounds.maxX + broadPhaseDistance ||
      obstacle.center.y < segmentBounds.minY - broadPhaseDistance ||
      obstacle.center.y > segmentBounds.maxY + broadPhaseDistance
    ) {
      continue
    }
    const violatesClearance =
      distanceSegmentToObstacle(segment, obstacle) <
      segment.width / 2 + clearance - 1e-9
    if (!violatesClearance) continue
    if (obstacle.connectedTo.includes(plan.connectionName)) continue
    if (
      allowSameNetMerges &&
      obstacleSharesElectricalNet(srj, obstacle, plan.connectionName)
    ) {
      continue
    }
    if (
      segmentIsLegalTerminalBodyEscape({
        inputSrj: srj,
        segment,
        bodyObstacle: obstacle,
        connectionName: plan.connectionName,
      })
    ) {
      continue
    }
    // A winding escape can turn more than once while leaving its own pad.
    if (
      segmentIndex >= 0 &&
      segmentIndex < (plan.sourceEscapeSegmentCount ?? 1) &&
      obstacle === plan.sourceObstacle &&
      segment.layer === plan.sourceLayer
    ) {
      continue
    }
    return false
  }
  return true
}

export interface StaticPlanSegmentCache {
  obstaclesByLayer: Map<CopperLayer, Obstacle[]>
  byConnection: Map<
    string,
    WeakMap<
      Obstacle,
      [WeakMap<RoutedSegment, boolean>, WeakMap<RoutedSegment, boolean>]
    >
  >
}

export function planIsStaticallyClear(params: {
  segmentCache?: StaticPlanSegmentCache
  plan: FanoutRoutePlan
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowBlindAndBuriedVias: boolean
  allowSameNetMerges: boolean
}): boolean {
  const {
    plan,
    srj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias,
    allowSameNetMerges,
  } = params
  const routableBounds = getRoutableBounds(srj.bounds, sharedBoundary)
  if (
    !pointIsInsideBounds(plan.exitPoint, routableBounds) ||
    getPlanSegments(plan).some(
      (segment) =>
        !pointIsInsideBounds(segment.start, routableBounds) ||
        !pointIsInsideBounds(segment.end, routableBounds),
    )
  ) {
    return false
  }
  const segments = getPlanSegments(plan)
  let segmentResults:
    | [WeakMap<RoutedSegment, boolean>, WeakMap<RoutedSegment, boolean>]
    | undefined
  if (params.segmentCache) {
    let contexts = params.segmentCache.byConnection.get(plan.connectionName)
    if (!contexts) {
      contexts = new WeakMap()
      params.segmentCache.byConnection.set(plan.connectionName, contexts)
    }
    segmentResults = contexts.get(plan.sourceObstacle)
    if (!segmentResults) {
      segmentResults = [new WeakMap(), new WeakMap()]
      contexts.set(plan.sourceObstacle, segmentResults)
    }
  }
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    const segmentIndex = index < plan.segments.length ? index : -1
    const sourceExemption =
      segmentIndex >= 0 &&
      segmentIndex < (plan.sourceEscapeSegmentCount ?? 1) &&
      segment.layer === plan.sourceLayer
    const results = segmentResults?.[sourceExemption ? 1 : 0]
    let clear = results?.get(segment)
    if (clear === undefined) {
      clear = segmentIsClearOfObstacles({
        segment,
        plan,
        segmentIndex,
        srj,
        allowSameNetMerges,
        obstacles: params.segmentCache
          ? (params.segmentCache.obstaclesByLayer.get(segment.layer) ?? [])
          : srj.obstacles,
        clearance,
      })
      results?.set(segment, clear)
    }
    if (!clear) return false
  }
  for (const via of getPlanVias(plan)) {
    for (const obstacle of srj.obstacles) {
      if (obstacle.isCopperPour) {
        const touchesTerminalLayer =
          obstacle.layers.includes(via.fromLayer) ||
          obstacle.layers.includes(via.toLayer)
        if (!touchesTerminalLayer) continue
      }
      if (
        allowsViaInPad(srj) &&
        obstacle === plan.sourceObstacle &&
        viaFitsInsidePlanSourcePad(plan, via)
      ) {
        continue
      }
      if (!obstacle.layers.some((layer) => via.spanLayers.includes(layer))) {
        continue
      }
      const violatesClearance =
        distancePointToObstacle(via.center, obstacle) <
        via.diameter / 2 + clearance - 1e-9
      if (!violatesClearance) continue
      if (
        (obstacle.isCopperPour || allowSameNetMerges) &&
        (obstacle.connectedTo.includes(plan.connectionName) ||
          obstacleSharesElectricalNet(srj, obstacle, plan.connectionName))
      ) {
        continue
      }
      return false
    }
  }

  for (const traceCopper of getAllRoutedTraceCopper(
    srj,
    allowBlindAndBuriedVias,
  )) {
    if (
      plan.connectionName === traceCopper.connectionName ||
      (allowSameNetMerges &&
        connectionsShareElectricalNet(
          srj,
          plan.connectionName,
          traceCopper.connectionName,
        ))
    ) {
      continue
    }
    for (const segment of getPlanSegments(plan)) {
      for (const existingSegment of traceCopper.segments) {
        if (!segmentsAreClear(segment, existingSegment, clearance)) {
          return false
        }
      }
      for (const existingVia of traceCopper.vias) {
        if (
          existingVia.spanLayers.includes(segment.layer) &&
          distancePointToSegment(
            existingVia.center,
            segment.start,
            segment.end,
          ) <
            existingVia.diameter / 2 + segment.width / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
    }
    for (const via of getPlanVias(plan)) {
      for (const existingSegment of traceCopper.segments) {
        if (
          via.spanLayers.includes(existingSegment.layer) &&
          distancePointToSegment(
            via.center,
            existingSegment.start,
            existingSegment.end,
          ) <
            via.diameter / 2 + existingSegment.width / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
      for (const existingVia of traceCopper.vias) {
        if (
          via.spanLayers.some((layer) =>
            existingVia.spanLayers.includes(layer),
          ) &&
          distance(via.center, existingVia.center) <
            (via.diameter + existingVia.diameter) / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
    }
  }

  return true
}

import { circleFitsInsideObstacle } from "../geometry"
import type { FanoutDirection, FanoutRoutePlan } from "../types"
import { buildPlan } from "./build-plan"
import {
  busIsOnOutwardComponentEdge,
  getConnectionOrders,
} from "./connection-order"
import {
  allowsViaInPad,
  getDirectionalPitch,
  getExitAxis,
  getPerpendicularAxis,
  isHorizontal,
} from "./directions"
import { getPlaneSourceEscapePaths } from "./get-plane-source-escape-paths"
import { planIsClear } from "./plan-clearance"
import {
  addPlaneEndpointTerminal,
  getPlaneEndpointViaCandidates,
} from "./plane-endpoint"
import type { RouteBusParams, ViaHandedness } from "./types"

// A cached request rejection belongs to the immutable predicate that checked
// the route. The same caller-owned cache can be used with another bus request.
const planeRequestKeys = new WeakMap<
  (plan: FanoutRoutePlan) => boolean,
  number
>()
let nextRequestKey = 0
function getPlaneRequestPrefix(check?: (plan: FanoutRoutePlan) => boolean) {
  if (!check) return ""
  let key = planeRequestKeys.get(check)
  if (key === undefined) {
    key = ++nextRequestKey
    planeRequestKeys.set(check, key)
  }
  return `request${key}:`
}

export function routePlaneTerminatedBus(
  params: RouteBusParams & {
    collectAlternative?: (plan: FanoutRoutePlan) => boolean
  },
): FanoutRoutePlan[] | null {
  const {
    srj,
    bus,
    targetLayer,
    acceptedPlans,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    staticClearanceCache,
    blockingBusCounts,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    fixedViaPointsByConnectionIndex,
    planeCandidateSkipCount = 0,
  } = params
  const sourceObstacle = bus.connections[0]?.sourceObstacle
  if (!sourceObstacle || bus.termination.type !== "plane") return null
  const sourceLayer = bus.connections[0]!.sourceLayer
  if (targetLayer === sourceLayer) return null
  const selection = {
    remainingPlaneCandidatesToSkip: planeCandidateSkipCount,
    collectAlternative: params.collectAlternative,
  }

  if (fixedViaPointsByConnectionIndex) {
    const fixedPlans: FanoutRoutePlan[] = []
    for (const preparedConnection of bus.connections) {
      const fixedViaPoint = fixedViaPointsByConnectionIndex.get(
        preparedConnection.connectionIndex,
      )
      if (!fixedViaPoint) return null
      const sourcePoint = {
        x: preparedConnection.sourcePoint.x,
        y: preparedConnection.sourcePoint.y,
      }
      const basePlan = buildPlan({
        preparedConnection,
        bus,
        targetLayer,
        track: getPerpendicularAxis(sourcePoint, bus.direction),
        exitAxis: getExitAxis(bus),
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        viaHandedness: 0,
        interstitialEscape: false,
        spreadLaneIndex: 0,
        cornerExitLaneOffset: 0,
        cornerLocalChannelLaneOffset: 0,
        cornerBoundaryChannelLaneOffset: 0,
        clearance,
        terminateAtVia: true,
        allowBlindAndBuriedVias,
        initialViaPoint: fixedViaPoint,
        sourceEscapePath: params.sourceEscapePaths?.get(
          preparedConnection.connectionIndex,
        )
          ? [
              ...params.sourceEscapePaths.get(
                preparedConnection.connectionIndex,
              )!,
            ]
          : [sourcePoint, fixedViaPoint],
      })
      const endpointViaCandidates = getPlaneEndpointViaCandidates({
        preparedConnection,
        bus,
        viaDiameter,
        clearance,
      })
      const plansToTry = [
        ...endpointViaCandidates.map((viaPoint) =>
          addPlaneEndpointTerminal({
            plan: basePlan,
            preparedConnection,
            planeLayer: targetLayer,
            viaPoint,
            layerNames,
            traceWidth,
            viaDiameter,
            viaHoleDiameter,
            allowBlindAndBuriedVias,
          }),
        ),
        basePlan,
      ]
      const clearPlan = selectClearPlanePlan(
        {
          plans: plansToTry,
          isClear: (candidatePlan, candidateIndex) =>
            planIsClear({
              plan: candidatePlan,
              otherPlans: [...acceptedPlans, ...fixedPlans],
              staticClearanceCache,
              blockingBusCounts,
              cacheKey: `plane-fixed:${bus.busId}:${targetLayer}:${traceWidth}:${preparedConnection.connectionIndex}:${fixedViaPoint.x}:${fixedViaPoint.y}:${candidateIndex}`,
              srj,
              sharedBoundary: bus.sharedBoundary,
              clearance,
              allowBlindAndBuriedVias,
              allowSameNetMerges,
            }) &&
            (bus.acceptsPlaneEscape?.(candidatePlan) ?? true),
        },
        selection,
      )
      if (!clearPlan) return null
      fixedPlans.push(clearPlan)
    }
    return fixedPlans
  }

  if (
    allowsViaInPad(srj) &&
    bus.connections.length === 1 &&
    circleFitsInsideObstacle({
      center: bus.connections[0]!.sourcePoint,
      diameter: viaDiameter,
      obstacle: sourceObstacle,
    })
  ) {
    const preparedConnection = bus.connections[0]!
    const viaInPadPlan = buildPlan({
      preparedConnection,
      bus,
      targetLayer,
      track: getPerpendicularAxis(
        preparedConnection.sourcePoint,
        bus.direction,
      ),
      exitAxis: getExitAxis(bus),
      layerNames,
      traceWidth,
      viaDiameter,
      viaHoleDiameter,
      viaHandedness: 0,
      interstitialEscape: false,
      spreadLaneIndex: 0,
      cornerExitLaneOffset: 0,
      cornerLocalChannelLaneOffset: 0,
      cornerBoundaryChannelLaneOffset: 0,
      clearance,
      terminateAtVia: true,
      allowBlindAndBuriedVias,
      initialViaPoint: preparedConnection.sourcePoint,
    })
    const endpointViaCandidates = getPlaneEndpointViaCandidates({
      preparedConnection,
      bus,
      viaDiameter,
      clearance,
    })
    const plansToTry = [
      ...endpointViaCandidates.map((viaPoint) =>
        addPlaneEndpointTerminal({
          plan: viaInPadPlan,
          preparedConnection,
          planeLayer: targetLayer,
          viaPoint,
          layerNames,
          traceWidth,
          viaDiameter,
          viaHoleDiameter,
          allowBlindAndBuriedVias,
        }),
      ),
      viaInPadPlan,
    ]
    const clearPlan = selectClearPlanePlan(
      {
        plans: plansToTry,
        isClear: (candidatePlan, candidateIndex) =>
          planIsClear({
            plan: candidatePlan,
            otherPlans: acceptedPlans,
            staticClearanceCache,
            blockingBusCounts,
            cacheKey: `plane-via-in-pad:${bus.busId}:${targetLayer}:${candidateIndex}`,
            srj,
            sharedBoundary: bus.sharedBoundary,
            clearance,
            allowBlindAndBuriedVias,
            allowSameNetMerges,
          }) &&
          (bus.acceptsPlaneEscape?.(candidatePlan) ?? true),
      },
      selection,
    )
    if (clearPlan) return [clearPlan]
  }

  const requestPrefix = getPlaneRequestPrefix(bus.acceptsPlaneEscape)
  const candidateDirections: FanoutDirection[] = [
    bus.direction,
    ...(["left", "right", "up", "down"] as const).filter(
      (direction) => direction !== bus.direction,
    ),
  ]
  // Try existing candidates first, then centered escapes away from the component.
  const candidateDirectionPasses = [
    ...candidateDirections.map((direction) => ({
      direction,
      centeredOutward: false,
    })),
    ...candidateDirections.map((direction) => ({
      direction,
      centeredOutward: true,
    })),
  ]
  for (const { direction, centeredOutward } of candidateDirectionPasses) {
    const directionalBus =
      direction === bus.direction ? bus : { ...bus, direction }
    const directionalPadSize = isHorizontal(direction)
      ? sourceObstacle.width
      : sourceObstacle.height
    const pairChannelFitsVia =
      getDirectionalPitch(directionalBus) / 2 - directionalPadSize / 2 >=
      viaDiameter / 2 + clearance - 1e-9
    const viaHandednesses: readonly ViaHandedness[] = centeredOutward
      ? !pairChannelFitsVia && busIsOnOutwardComponentEdge(directionalBus)
        ? [0]
        : []
      : pairChannelFitsVia
        ? [0]
        : [1, -1]

    for (const viaHandedness of viaHandednesses) {
      for (const connectionOrder of getConnectionOrders(directionalBus)) {
        const candidatePlans: FanoutRoutePlan[] = []
        let orderIsClear = true
        for (const preparedConnection of connectionOrder) {
          const sourceTrack = getPerpendicularAxis(
            preparedConnection.sourcePoint,
            direction,
          )
          const sourceEscapePaths = getPlaneSourceEscapePaths(
            { preparedConnection, viaHandedness },
            { ...params, bus: directionalBus },
          )
          let plan: FanoutRoutePlan | undefined
          for (const [
            pathIndex,
            sourceEscapePath,
          ] of sourceEscapePaths.entries()) {
            const endpointViaCandidates = getPlaneEndpointViaCandidates({
              preparedConnection,
              bus: directionalBus,
              viaDiameter,
              clearance,
            })
            const cacheKeyPrefix = `${requestPrefix}plane:${bus.busId}:${targetLayer}:${direction}:${traceWidth}:${preparedConnection.connectionIndex}:${viaHandedness}:${pathIndex}`
            // The base plan follows every endpoint variant in the cache order.
            const basePlanIndex = endpointViaCandidates.length
            const basePlanCacheKey = `${cacheKeyPrefix}:${basePlanIndex}`
            const basePlanIsStaticallyRejected =
              staticClearanceCache?.get(basePlanCacheKey) === false
            const allVariantsAreStaticallyRejected =
              basePlanIsStaticallyRejected &&
              endpointViaCandidates.every((_, candidateIndex) => {
                const endpointPlanCacheKey = `${cacheKeyPrefix}:${candidateIndex}`
                const endpointPlanIsStaticallyRejected =
                  staticClearanceCache?.get(endpointPlanCacheKey) === false
                return endpointPlanIsStaticallyRejected
              })
            if (allVariantsAreStaticallyRejected) continue
            const basePlan = buildPlan({
              preparedConnection,
              bus: directionalBus,
              targetLayer,
              track: sourceTrack,
              exitAxis: getExitAxis(directionalBus),
              layerNames,
              traceWidth,
              viaDiameter,
              viaHoleDiameter,
              viaHandedness,
              interstitialEscape: !pairChannelFitsVia,
              spreadLaneIndex: 0,
              cornerExitLaneOffset: 0,
              cornerLocalChannelLaneOffset: 0,
              cornerBoundaryChannelLaneOffset: 0,
              clearance,
              terminateAtVia: true,
              allowBlindAndBuriedVias,
              sourceEscapePath,
            })
            const plansToTry = [
              ...endpointViaCandidates.map((viaPoint) =>
                addPlaneEndpointTerminal({
                  plan: basePlan,
                  preparedConnection,
                  planeLayer: targetLayer,
                  viaPoint,
                  layerNames,
                  traceWidth,
                  viaDiameter,
                  viaHoleDiameter,
                  allowBlindAndBuriedVias,
                }),
              ),
              basePlan,
            ]
            plan = selectClearPlanePlan(
              {
                plans: plansToTry,
                isClear: (candidatePlan, candidateIndex) =>
                  planIsClear({
                    plan: candidatePlan,
                    acceptsStaticPlan: bus.acceptsPlaneEscape,
                    otherPlans: [...acceptedPlans, ...candidatePlans],
                    staticClearanceCache,
                    blockingBusCounts,
                    cacheKey: `${cacheKeyPrefix}:${candidateIndex}`,
                    srj,
                    sharedBoundary: bus.sharedBoundary,
                    clearance,
                    allowBlindAndBuriedVias,
                    allowSameNetMerges,
                  }),
              },
              selection,
            )
            if (plan) break
          }
          if (!plan) {
            orderIsClear = false
            break
          }
          candidatePlans.push(plan)
        }
        if (orderIsClear) return candidatePlans
      }
    }
  }

  return null
}

export function selectClearPlanePlan(
  {
    plans,
    isClear,
  }: {
    plans: FanoutRoutePlan[]
    isClear: (plan: FanoutRoutePlan, index: number) => boolean
  },
  selection: {
    remainingPlaneCandidatesToSkip: number
    collectAlternative?: (plan: FanoutRoutePlan) => boolean
  },
): FanoutRoutePlan | undefined {
  for (const [index, plan] of plans.entries()) {
    if (!isClear(plan, index)) continue
    if (selection.remainingPlaneCandidatesToSkip > 0) {
      selection.remainingPlaneCandidatesToSkip--
      continue
    }
    if (selection.collectAlternative && !selection.collectAlternative(plan))
      continue
    return plan
  }
  return undefined
}

import { getPeripheralSourceGeometry } from "./get-peripheral-source-geometry"
import { getViaSpanLayers } from "./layer-names"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import { routeBottomCrossbarBusSteps } from "./route-bottom-crossbar-bus"
import type { RouteBusParams } from "./route-bus"
import type { FanoutRoutePlan, RoutedVia } from "./types"
import { getViaHoleToHoleClearance } from "./via-clearance"

function getPlanVias(plan: FanoutRoutePlan): RoutedVia[] {
  return [
    ...(plan.via ? [plan.via] : []),
    ...(plan.additionalVias ?? []),
    ...(plan.planeEndpointVia ? [plan.planeEndpointVia] : []),
  ]
}

/**
 * Retry a paired right-edge bus through the existing two-layer crossbar.
 * Ordinary fixed-target winding cannot realize every source-to-target
 * permutation with one set of dogbone vias, while the crossbar can preserve
 * the paired target order without leaving the fanout boundary.
 */
export function routePairedTargetCrossbarBus(
  params: RouteBusParams,
): FanoutRoutePlan[] | null {
  const {
    bus,
    srj,
    targetLayer,
    acceptedPlans,
    reservedVias = [],
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
  } = params
  const allowedLayers = bus.routableEscapeLayers ?? bus.allowedLayers ?? []
  if (
    params.allowBlindAndBuriedVias ||
    bus.termination.type !== "boundary" ||
    bus.exitEdge !== "right" ||
    bus.connections.length < 3 ||
    bus.connections.some(
      (connection) =>
        connection.sourceLayer !== "top" ||
        connection.sourceLayer === targetLayer ||
        !connection.hasExplicitLayeredExitTarget,
    ) ||
    !allowedLayers.includes(targetLayer) ||
    !allowedLayers.some((layer) => layer !== targetLayer)
  )
    return null

  const geometry = getPeripheralSourceGeometry({
    bus,
    traceWidth,
    clearance,
  })
  if (!geometry) return null

  const matchedViaPoints = matchComponentDogboneViaSites([bus], {
    viaDiameter,
    viaHoleDiameter,
    holeToHoleClearance: getViaHoleToHoleClearance(srj, clearance),
    traceWidth,
    clearance,
    additionalObstacles: srj.obstacles,
    blockingSegments: [
      ...acceptedPlans.flatMap((plan) =>
        plan.segments.map((segment) => ({
          connectionIndex: plan.connectionIndex,
          segment,
        })),
      ),
      ...reservedVias.flatMap((reserved) =>
        reserved.sourceEscapeSegment
          ? [
              {
                connectionIndex: -1,
                segment: reserved.sourceEscapeSegment,
              },
            ]
          : [],
      ),
    ],
    blockingVias: [
      ...acceptedPlans.flatMap((plan) =>
        getPlanVias(plan).map((via) => ({
          connectionIndex: plan.connectionIndex,
          center: via.center,
          diameter: via.diameter,
          spanLayers: via.spanLayers,
        })),
      ),
      ...reservedVias.map((reserved) => ({
        connectionIndex: -1,
        ...reserved.via,
      })),
    ],
  })
  if (!matchedViaPoints || matchedViaPoints.size !== bus.connections.length)
    return null

  const sourceEscapes = bus.connections.map((connection) => {
    const center = matchedViaPoints.get(connection.connectionIndex)
    if (!center) {
      throw new Error(
        `FanoutSolver: paired-target crossbar is missing a dogbone via for ${connection.connection.name}`,
      )
    }
    return {
      connectionIndex: connection.connectionIndex,
      connectionName: connection.connection.name,
      segments: [
        {
          start: connection.sourcePoint,
          end: center,
          width: traceWidth,
          layer: connection.sourceLayer,
        },
      ],
      via: {
        center,
        diameter: viaDiameter,
        holeDiameter: viaHoleDiameter,
        fromLayer: connection.sourceLayer,
        toLayer: targetLayer,
        spanLayers: getViaSpanLayers({
          fromLayer: connection.sourceLayer,
          toLayer: targetLayer,
          layerNames,
          allowBlindAndBuriedVias: false,
        }),
      },
    }
  })
  const steps = routeBottomCrossbarBusSteps({
    ...params,
    sourceEscapes,
    sourceBoundary: geometry.sourceBoundary,
  })
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

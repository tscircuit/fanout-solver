import { getPeripheralSourceGeometry } from "./get-peripheral-source-geometry"
import { getViaSpanLayers } from "./layer-names"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import { reflectFanoutY } from "./reflect-fanout-y"
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
export function busHasExplicitPairedTargets(
  bus: RouteBusParams["bus"],
  allowBlindAndBuriedVias = true,
): boolean {
  return (
    !allowBlindAndBuriedVias &&
    bus.termination.type === "boundary" &&
    bus.exitEdge === "right" &&
    bus.connections.length >= 3 &&
    bus.connections.every(
      (connection) =>
        connection.sourceLayer === "top" &&
        connection.hasExplicitLayeredExitTarget,
    )
  )
}

export function canRoutePairedTargetCrossbarBus(
  params: Pick<
    RouteBusParams,
    "bus" | "targetLayer" | "allowBlindAndBuriedVias"
  >,
): boolean {
  const { bus, targetLayer, allowBlindAndBuriedVias = true } = params
  if (
    !busHasExplicitPairedTargets(bus, allowBlindAndBuriedVias) ||
    bus.connections.some((connection) => connection.sourceLayer === targetLayer)
  )
    return false

  const allowedLayers = bus.routableEscapeLayers ?? bus.allowedLayers ?? []
  return (
    allowedLayers.includes(targetLayer) &&
    allowedLayers.includes(bus.connections[0]!.sourceLayer)
  )
}

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
  if (!canRoutePairedTargetCrossbarBus(params)) return null

  const geometry = getPeripheralSourceGeometry({
    bus,
    traceWidth,
    clearance,
  })
  if (!geometry) return null

  const fixedViaPoints = params.fixedViaPointsByConnectionIndex
  const matchedViaPoints = fixedViaPoints
    ? new Map(
        bus.connections.flatMap((connection) => {
          const point = fixedViaPoints.get(connection.connectionIndex)
          return point ? [[connection.connectionIndex, point] as const] : []
        }),
      )
    : matchComponentDogboneViaSites([bus], {
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
  const crossbarParams = {
    ...params,
    sourceEscapes,
    sourceBoundary: geometry.sourceBoundary,
    honorExplicitLayeredExitTargets: true,
  }
  const routesAboveSource =
    bus.connections.reduce(
      (sum, connection) =>
        sum + (connection.exitTargetPoint ?? connection.targetPoint).y,
      0,
    ) /
      bus.connections.length >
    (bus.componentBounds.minY + bus.componentBounds.maxY) / 2
  const steps = routeBottomCrossbarBusSteps(
    routesAboveSource ? reflectFanoutY(crossbarParams) : crossbarParams,
  )
  let result = steps.next()
  while (!result.done) result = steps.next()
  if (!result.value || !routesAboveSource) return result.value
  const connectionByIndex = new Map(
    bus.connections.map((connection) => [
      connection.connectionIndex,
      connection,
    ]),
  )
  return reflectFanoutY(result.value).map((plan) => ({
    ...plan,
    sourceObstacle: connectionByIndex.get(plan.connectionIndex)!.sourceObstacle,
  }))
}

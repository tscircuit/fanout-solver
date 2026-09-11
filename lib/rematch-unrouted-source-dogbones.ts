import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { getCopperLayerNames } from "./layer-names"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import { fanoutPlansAreClear } from "./route-bus"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { FanoutRoutePlan, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"
import { getViaHoleToHoleClearance } from "./via-clearance"

/**
 * Reassign only caller-declared, unfinished direct signal dogbones around a
 * proposed tuning shape. Complete copper and every plane reservation stay
 * immutable. The caller must still match its complete current bus before
 * committing the returned source paths and first vias.
 */
export function rematchUnroutedSourceDogbones(params: {
  inputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  unroutedSourceBuses: readonly PreparedBus[]
  clearance: number
}): FanoutRoutePlan[] | null {
  const { inputSrj, plans, unroutedSourceBuses, clearance } = params
  const byIndex = new Map(plans.map((plan) => [plan.connectionIndex, plan]))
  const layerNames = getCopperLayerNames(inputSrj.layerCount)
  const eligible = unroutedSourceBuses.filter(
    (bus) =>
      bus.termination.type === "boundary" &&
      bus.connections.length > 0 &&
      bus.connections.every((connection) => {
        const plan = byIndex.get(connection.connectionIndex)
        const segment = plan?.segments[0]
        const via = plan?.via
        return (
          plan?.connectionName === connection.connection.name &&
          plan.termination.type === "boundary" &&
          plan.segments.length === 1 &&
          (plan.sourceEscapeSegmentCount ?? 1) === 1 &&
          !plan.additionalVias?.length &&
          !plan.planeEndpointTrace &&
          !plan.planeEndpointVia &&
          segment &&
          segment.layer === connection.sourceLayer &&
          via &&
          via.fromLayer === connection.sourceLayer &&
          via.toLayer === plan.targetLayer &&
          via.toLayer !== via.fromLayer &&
          via.spanLayers.length === layerNames.length &&
          layerNames.every((layer) => via.spanLayers.includes(layer)) &&
          distance(segment.start, connection.sourcePoint) < 1e-7 &&
          distance(segment.end, via.center) < 1e-7 &&
          distance(plan.exitPoint, via.center) < 1e-7
        )
      }),
  )
  const first = eligible[0]?.connections[0]
  if (!first) return null
  const reference = byIndex.get(first.connectionIndex)!
  const via = reference.via!
  const traceWidth = reference.segments[0]!.width
  if (
    eligible.some((bus) =>
      bus.connections.some((connection) => {
        const plan = byIndex.get(connection.connectionIndex)!
        return (
          plan.via!.diameter !== via.diameter ||
          plan.via!.holeDiameter !== via.holeDiameter ||
          plan.segments[0]!.width !== traceWidth
        )
      }),
    )
  )
    return null
  const released = new Set(
    eligible.flatMap((bus) => bus.connections.map((c) => c.connectionIndex)),
  )
  const retained = plans.filter((plan) => !released.has(plan.connectionIndex))
  const supplied = getAllRoutedTraceCopper(inputSrj, false)
  const sites = matchComponentDogboneViaSites(eligible, {
    traceWidth,
    clearance,
    viaDiameter: via.diameter,
    viaHoleDiameter: via.holeDiameter,
    holeToHoleClearance: getViaHoleToHoleClearance(inputSrj, clearance),
    maximumSearchStates: 10_000,
    preferredViaPointsByConnectionIndex: new Map(
      plans
        .filter((p) => released.has(p.connectionIndex))
        .map((p) => [p.connectionIndex, p.via!.center]),
    ),
    additionalObstacles: inputSrj.obstacles,
    blockingSegments: [
      ...retained.flatMap((plan) =>
        [...plan.segments, ...(plan.planeEndpointSegments ?? [])].map(
          (segment) => ({ connectionIndex: plan.connectionIndex, segment }),
        ),
      ),
      ...supplied.flatMap((copper) =>
        copper.segments.map((segment) => ({ connectionIndex: -1, segment })),
      ),
    ],
    blockingVias: [
      ...retained.flatMap((plan) =>
        [plan.via, ...(plan.additionalVias ?? []), plan.planeEndpointVia]
          .filter((v) => v !== undefined)
          .map((v) => ({ connectionIndex: plan.connectionIndex, ...v })),
      ),
      ...supplied.flatMap((copper) =>
        copper.vias.map((v) => ({ connectionIndex: -1, ...v })),
      ),
    ],
  })
  if (!sites) return null
  const replacements = new Map<number, FanoutRoutePlan>()
  for (const bus of eligible) {
    for (const connection of bus.connections) {
      const original = byIndex.get(connection.connectionIndex)!
      const point = sites.get(connection.connectionIndex)!
      if (distance(point, original.via!.center) < 1e-7) continue
      const dx = point.x - connection.sourcePoint.x
      const dy = point.y - connection.sourcePoint.y
      if (
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ) > 1e-7
      )
        return null
      replacements.set(
        connection.connectionIndex,
        buildViaMinimalWindingPlan({
          bus,
          terminal: { connection, viaPoint: point, exitPoint: point },
          targetLayer: original.targetLayer,
          targetLayerPoints: [point],
          layerNames,
          traceWidth,
          viaDiameter: via.diameter,
          viaHoleDiameter: via.holeDiameter,
          allowBlindAndBuriedVias: false,
        }),
      )
    }
  }
  if (!replacements.size) return null
  const candidate = plans.map(
    (plan) => replacements.get(plan.connectionIndex) ?? plan,
  )
  if (
    !fanoutPlansAreClear({
      plans: candidate,
      srj: inputSrj,
      sharedBoundary: eligible[0]!.sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    })
  )
    return null
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...candidate.flatMap((plan) => [
          plan.trace,
          ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance,
    allowBlindAndBuriedVias: false,
  })
  return validation.valid ? candidate : null
}

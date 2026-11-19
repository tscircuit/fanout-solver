import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  createFanoutPlanClearanceValidator,
  routeBusAlternatives,
} from "./route-bus"
import { getLocalPlaneEscapeCandidates } from "./route-bus/get-local-plane-escape-candidates"
import { getPlanSegments } from "./route-bus/plan-copper"
import { selectCompatibleCandidates } from "./select-compatible-candidates"
import type { FanoutSolver } from "./fanout-solver"
import type { FanoutDirection, FanoutRoutePlan, PreparedBus } from "./types"

export function canRouteCompatibleSingletonEscapes(
  buses: readonly PreparedBus[],
): boolean {
  return (
    buses.every((bus) => bus.connections.length === 1) &&
    buses.some((bus) => bus.termination.type === "plane") &&
    buses.some((bus) => bus.termination.type === "boundary")
  )
}

function getHeadings(bus: PreparedBus): FanoutDirection[] {
  if (
    bus.exitEdge ||
    bus.preferredExit ||
    bus.requestedDirection ||
    bus.connections[0]!.hasExplicitExitTarget ||
    bus.connections[0]!.hasExplicitLayeredExitTarget
  )
    return [bus.direction]
  const alternatives: FanoutDirection[] = ["left", "right", "up", "down"]
  return [
    bus.direction,
    ...alternatives.filter((direction) => direction !== bus.direction),
  ]
}

function getLayers(bus: PreparedBus): readonly string[] {
  if (bus.termination.type === "plane") return [bus.termination.layer]
  const allowed = bus.routableEscapeLayers!
  const connection = bus.connections[0]!
  return connection.hasExplicitLayeredExitTarget
    ? allowed.filter((layer) => layer === connection.exitTargetPoint?.layer)
    : allowed
}

/** Keep declared exits fixed while searching independent layer and heading choices. */
export function* routeCompatibleSingletonEscapesSteps(params: {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  config: FanoutSolver["config"]
  onProgress?: (phase: string, completed: number, total: number) => void
}): Generator<undefined, FanoutRoutePlan[], void> {
  const { srj, buses, config, onProgress } = params
  const validate = createFanoutPlanClearanceValidator({
    srj,
    sharedBoundary: buses[0]!.sharedBoundary,
    clearance: config.clearance,
    allowBlindAndBuriedVias: config.allowBlindAndBuriedVias,
    allowSameNetMerges: config.allowSameNetMerges,
  })
  const compatible = (a: FanoutRoutePlan, b: FanoutRoutePlan) =>
    validate.mutuallyClear([a, b])
  const problems = buses.map((bus) => {
    const headings = getHeadings(bus)
    const layers = getLayers(bus)
    const traceWidth = bus.singletonTraceWidth ?? config.traceWidth

    function* candidates(acceptedPlans: FanoutRoutePlan[]) {
      for (const direction of headings) {
        for (const targetLayer of layers) {
          const route = {
            ...config,
            srj,
            bus: { ...bus, direction },
            targetLayer,
            traceWidth,
            acceptedPlans,
            staticClearanceCache: new Map<string, boolean>(),
          }
          // Ordinary templates come first, including the per-layer clearance cache.
          for (const [plan] of routeBusAlternatives(
            route,
            acceptedPlans.length ? 1 : 2,
          )) {
            if (
              plan &&
              headings.includes(plan.direction) &&
              getPlanSegments(plan).every(
                (segment) => Math.abs(segment.width - traceWidth) <= 1e-9,
              ) &&
              validate.canAdd(plan, acceptedPlans)
            )
              yield plan
          }
          // The plane site generator explores all permitted lead directions once.
          if (bus.termination.type === "plane" && direction === bus.direction) {
            for (const plan of getLocalPlaneEscapeCandidates(route)) {
              if (headings.includes(plan.direction)) yield plan
            }
          }
        }
      }
    }
    return { bus, candidates }
  })
  const optionsByBus = new Map<string, FanoutRoutePlan[]>()
  for (const { bus, candidates } of problems) {
    const unique = new Map<string, FanoutRoutePlan>()
    for (const plan of candidates([])) {
      const key = JSON.stringify([
        plan.trace.route,
        plan.planeEndpointTrace?.route,
      ])
      if (!unique.has(key)) unique.set(key, plan)
    }
    optionsByBus.set(
      bus.busId,
      // Give equal-length 45° bend orders their stable generation order even
      // when a platform rounds their accumulated segment lengths differently.
      [...unique.values()].sort(
        (a, b) => Math.round(a.length * 1e9) - Math.round(b.length * 1e9),
      ),
    )
    onProgress?.("escape-candidates", optionsByBus.size, problems.length)
    yield
  }

  // Place the most constrained planes first, then signals. After choosing
  // the shortest escape, discard options that intersect its copper.
  let accepted: FanoutRoutePlan[] = []
  let pending = [...optionsByBus.values()].filter((options) => options.length)
  while (pending.length) {
    pending.sort(
      (a, b) =>
        Number(b[0]!.termination.type === "plane") -
          Number(a[0]!.termination.type === "plane") || a.length - b.length,
    )
    const [next, ...rest] = pending
    const chosen = next![0]!
    accepted.push(chosen)
    pending = rest
      .map((group) => group.filter((plan) => compatible(plan, chosen)))
      .filter((group) => group.length)
    onProgress?.(
      "escape-selection",
      problems.length - pending.length,
      problems.length,
    )
    yield
  }
  const routed = new Set(accepted.map((plan) => plan.busId))
  // Committed copper can change routeBus's track/via choice, producing
  // compatible geometry that was absent from the independent candidate pool.
  const remaining = problems
    .filter(({ bus }) => !routed.has(bus.busId))
    .sort(
      (a, b) =>
        Number(b.bus.termination.type === "plane") -
        Number(a.bus.termination.type === "plane"),
    )
  onProgress?.("escape-residual", 0, remaining.length)
  for (const [index, problem] of remaining.entries()) {
    for (const plan of problem.candidates(accepted)) {
      accepted.push(plan)
      break
    }
    yield
    onProgress?.("escape-residual", index + 1, remaining.length)
  }

  // A missing escape can require moving its blocker and one neighboring bus
  // obstructing the blocker's alternate. All other committed copper stays fixed.
  function tryLocalRepair(
    addition: FanoutRoutePlan,
  ): FanoutRoutePlan[] | undefined {
    const blockers = accepted.filter((plan) => !compatible(plan, addition))
    if (blockers.length === 0) return [...accepted, addition]
    if (blockers.length > 2) return
    const first = blockers[0]!
    const others = accepted.filter((plan) => plan !== first)
    const tried = new Set<FanoutRoutePlan | undefined>()
    for (const option of optionsByBus.get(first.busId)!) {
      if (!compatible(option, addition)) continue
      const displaced = others.filter(
        (plan) => !compatible(plan, option) || !compatible(plan, addition),
      )
      if (displaced.length > 1 || tried.has(displaced[0])) continue
      tried.add(displaced[0])
      const fixed = [
        ...others.filter((plan) => plan !== displaced[0]),
        addition,
      ]
      const candidateSets = [first, ...displaced].map((plan) =>
        optionsByBus
          .get(plan.busId)!
          .filter((alt) => validate.canAdd(alt, fixed)),
      )
      if (candidateSets.some((set) => !set.length)) continue
      const { selection } = selectCompatibleCandidates({
        candidateSets,
        areCompatible: compatible,
        maximumSearchStates: candidateSets.length + 1,
      })
      if (selection) return [...fixed, ...selection]
    }
  }
  for (const [busId, options] of optionsByBus) {
    if (accepted.some((plan) => plan.busId === busId)) continue
    for (const option of options) {
      const repaired = tryLocalRepair(option)
      if (!repaired) continue
      accepted = repaired
      break
    }
    yield
  }
  return accepted
}

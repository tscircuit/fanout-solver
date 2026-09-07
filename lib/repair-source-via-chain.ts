import { distance, distancePointToSegment, segmentsAreClear } from "./geometry"
import { getComponentDogboneViaSiteCandidates } from "./match-component-dogbone-via-sites"
import { fanoutPlansAreClear, type RouteBusParams } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { FanoutRoutePlan, PreparedBus, RoutedVia } from "./types"

export interface RepairSourceViaChainParams
  extends Pick<
    RouteBusParams,
    | "srj"
    | "acceptedPlans"
    | "layerNames"
    | "traceWidth"
    | "viaDiameter"
    | "viaHoleDiameter"
    | "clearance"
    | "allowBlindAndBuriedVias"
    | "allowSameNetMerges"
  > {
  buses: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
  requestedEscape: PeripheralSourceEscape
  maximumMovedConnections?: number
  maximumSearchStates?: number
}
interface Candidate {
  source: PeripheralSourceEscape
  plan: FanoutRoutePlan
}
const EPS = 1e-9
function vias(p: FanoutRoutePlan): RoutedVia[] {
  return [p.via, ...(p.additionalVias ?? [])].filter((v): v is RoutedVia => !!v)
}
function mutuallyClear(
  a: FanoutRoutePlan,
  b: FanoutRoutePlan,
  clearance: number,
) {
  for (const s of a.segments)
    for (const t of b.segments)
      if (!segmentsAreClear(s, t, clearance)) return false
  const av = vias(a)
  const bv = vias(b)
  for (const v of av)
    for (const u of bv)
      if (
        v.spanLayers.some((l) => u.spanLayers.includes(l)) &&
        distance(v.center, u.center) <
          (v.diameter + u.diameter) / 2 + clearance - EPS
      )
        return false
  for (const [vs, ss] of [
    [av, b.segments],
    [bv, a.segments],
  ] as const)
    for (const v of vs)
      for (const s of ss)
        if (
          v.spanLayers.includes(s.layer) &&
          distancePointToSegment(v.center, s.start, s.end) <
            v.diameter / 2 + s.width / 2 + clearance - EPS
        )
          return false
  return true
}
/** A bounded augmenting chain. Changed source prefixes are returned as
 * reservations; the caller must reroute and validate each affected whole bus. */
export function repairSourceViaChain(params: RepairSourceViaChainParams) {
  if (params.allowSameNetMerges) return null
  const maxMoved = params.maximumMovedConnections ?? 3
  const maxStates = params.maximumSearchStates ?? 4096
  if (
    !Number.isInteger(maxMoved) ||
    maxMoved < 0 ||
    !Number.isInteger(maxStates) ||
    maxStates < 1
  )
    throw Error(
      "Source repair requires finite nonnegative move and positive search budgets",
    )
  const byIndex = new Map(
    params.buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const sourceMap = new Map(
    params.sourceEscapes.map((e) => [e.connectionIndex, e]),
  )
  const requested = params.requestedEscape.connectionIndex
  const holder = byIndex.get(requested)
  if (!holder) throw Error("Requested source is missing from prepared buses")
  const boundary = holder.bus.sharedBoundary
  const candidate = (e: PeripheralSourceEscape): Candidate => {
    const h = byIndex.get(e.connectionIndex)!
    const plan = buildViaMinimalWindingPlan({
      ...params,
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
      bus: h.bus,
      targetLayer: e.via.toLayer,
      terminal: {
        connection: h.connection,
        viaPoint: e.via.center,
        exitPoint: e.via.center,
      },
      sourceEscapePoints: [
        e.segments[0]!.start,
        ...e.segments.map((s) => s.end),
      ],
      targetLayerPoints: [e.via.center, e.via.center],
    })
    plan.termination = { type: "plane", layer: e.via.toLayer }
    plan.sourceEscapeSegmentCount = e.segments.length
    return { source: e, plan }
  }
  const acceptedByIndex = new Map(
    params.acceptedPlans.map((plan) => [plan.connectionIndex, plan]),
  )
  const initial = new Map(
    params.sourceEscapes.map((e) => [
      e.connectionIndex,
      acceptedByIndex.get(e.connectionIndex) ?? candidate(e).plan,
    ]),
  )
  for (const plan of params.acceptedPlans)
    initial.set(plan.connectionIndex, plan)
  const singleClear = (c: Candidate) =>
    fanoutPlansAreClear({
      ...params,
      plans: [c.plan],
      sharedBoundary: boundary,
    })
  const first = candidate(params.requestedEscape)
  if (!singleClear(first)) return null
  let native:
    | ReturnType<typeof getComponentDogboneViaSiteCandidates>
    | undefined
  const getNative = () => {
    native ??= getComponentDogboneViaSiteCandidates(params.buses, {
      ...params,
      additionalObstacles: params.srj.obstacles,
    })
    return native
  }
  const domainCache = new Map<number, Candidate[]>()
  const domains = (id: number) => {
    const cached = domainCache.get(id)
    if (cached) return cached
    if (!sourceMap.has(id) || !byIndex.has(id)) {
      domainCache.set(id, [])
      return []
    }
    const old = sourceMap.get(id)!
    const h = byIndex.get(id)!
    const q = h.connection.sourcePoint
    const points = getNative()
      .filter((s) => s.connectionIndex === id)
      .map((s) => s.point)
    // Short straight escapes also cover a perimeter pad whose four native
    // interstices are occupied. Clearance, bounds and all static pads decide
    // whether each extension is usable; no component dimensions are assumed.
    const pad = h.connection.sourceObstacle
    if (pad)
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const radius =
          (dx ? pad.width : pad.height) / 2 +
          params.viaDiameter / 2 +
          params.clearance
        for (const extra of [
          params.traceWidth / 8,
          params.traceWidth / 4,
          params.traceWidth / 2,
          params.traceWidth,
        ])
          points.push({
            x: q.x + dx * (radius + extra),
            y: q.y + dy * (radius + extra),
          })
      }
    const seen = new Set<string>()
    const out: Candidate[] = []
    for (const point of points) {
      const key = `${point.x.toFixed(9)},${point.y.toFixed(9)}`
      if (seen.has(key) || distance(point, old.via.center) < EPS) continue
      seen.add(key)
      const next = candidate({
        ...old,
        via: { ...old.via, center: point },
        segments: [
          {
            start: q,
            end: point,
            width: params.traceWidth,
            layer: h.connection.sourceLayer,
          },
        ],
      })
      if (singleClear(next)) out.push(next)
    }
    domainCache.set(id, out)
    return out
  }
  const initialConflicts = new Map<Candidate, number[]>()
  const conflicts = (c: Candidate) => {
    let ids = initialConflicts.get(c)
    if (ids) return ids
    ids = [...initial]
      .filter(
        ([id, p]) =>
          id !== c.source.connectionIndex &&
          id !== requested &&
          !mutuallyClear(c.plan, p, params.clearance),
      )
      .map(([id]) => id)
    initialConflicts.set(c, ids)
    return ids
  }
  let states = 0
  function visit(
    changes: Map<number, Candidate>,
  ): Map<number, Candidate> | null {
    if (++states > maxStates) return null
    const unresolved = new Set<number>()
    for (const c of changes.values())
      for (const id of conflicts(c)) if (!changes.has(id)) unresolved.add(id)
    if (!unresolved.size) return changes
    if (changes.size + unresolved.size > maxMoved + 1) return null
    const choices = [...unresolved]
      .map((id) => ({
        id,
        domain: domains(id).filter((c) =>
          [...changes.values()].every((other) =>
            mutuallyClear(c.plan, other.plan, params.clearance),
          ),
        ),
      }))
      .sort((a, b) => a.domain.length - b.domain.length || a.id - b.id)
    const choice = choices[0]!
    for (const c of choice.domain.sort(
      (a, b) =>
        conflicts(a).filter((id) => !changes.has(id)).length -
          conflicts(b).filter((id) => !changes.has(id)).length ||
        distance(a.source.via.center, sourceMap.get(choice.id)!.via.center) -
          distance(b.source.via.center, sourceMap.get(choice.id)!.via.center),
    )) {
      const next = new Map(changes)
      next.set(choice.id, c)
      const result = visit(next)
      if (result) return result
    }
    return null
  }
  const changes = visit(new Map([[requested, first]]))
  if (!changes) return null
  const plans = [...initial].map(([id, p]) => changes.get(id)?.plan ?? p)
  if (!fanoutPlansAreClear({ ...params, plans, sharedBoundary: boundary }))
    throw Error("Source chain failed final physical validation")
  return {
    sourceEscapes: params.sourceEscapes.map(
      (e) => changes.get(e.connectionIndex)?.source ?? e,
    ),
    changedConnectionIndices: [...changes.keys()],
    retainedPlans: params.acceptedPlans.filter(
      (p) => !changes.has(p.connectionIndex),
    ),
    sourcePlans: plans,
    searchStates: states,
  }
}

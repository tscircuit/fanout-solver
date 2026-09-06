import { distance, distancePointToSegment, segmentsAreClear } from "./geometry"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
  type DogboneViaSiteGeometryRules,
} from "./match-component-dogbone-via-sites"
import type {
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"

const EPSILON = 1e-9
const TAU = Math.PI * 2
interface Candidate {
  connectionIndex: number
  point: Point2D
  angle: number
  sourceSegment: RoutedSegment
  siteIndex: number
}

/** Reserve ordered source vias, then assign every remaining source via together. */
export function matchAngularlyOrderedLocalVias(params: {
  buses: readonly PreparedBus[]
  busId: string
  rules: DogboneViaSiteGeometryRules
  maximumOrderingStates?: number
  maximumCompleteAssignments?: number
}): Map<number, Point2D> | null {
  const { buses, rules } = params
  const bus = buses.find((b) => b.busId === params.busId)
  if (
    !bus ||
    bus.termination.type !== "boundary" ||
    !bus.exitEdge ||
    bus.connections.length < 3
  )
    return null
  const maximumOrderingStates = params.maximumOrderingStates ?? 10_000
  const maximumCompleteAssignments = params.maximumCompleteAssignments ?? 16
  for (const [name, value] of Object.entries({
    maximumOrderingStates,
    maximumCompleteAssignments,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`FanoutSolver: ${name} must be a positive safe integer`)
  }
  const center = {
    x: (bus.componentBounds.minX + bus.componentBounds.maxX) / 2,
    y: (bus.componentBounds.minY + bus.componentBounds.maxY) / 2,
  }
  const angle = (p: Point2D) => Math.atan2(p.y - center.y, p.x - center.x)
  const targetCoordinate = (c: PreparedConnection) => {
    const p = c.exitTargetPoint ?? c.targetPoint
    return bus.exitEdge === "right"
      ? p.y
      : bus.exitEdge === "top"
        ? -p.x
        : bus.exitEdge === "left"
          ? -p.y
          : p.x
  }
  const ordered = bus.connections.toSorted(
    (a, b) =>
      targetCoordinate(a) - targetCoordinate(b) ||
      a.connectionIndex - b.connectionIndex,
  )
  const sourceAngles: number[] = []
  for (const c of ordered) {
    if (distance(c.sourcePoint, center) < EPSILON) return null
    let a = angle(c.sourcePoint)
    while (a < (sourceAngles.at(-1) ?? a) - EPSILON) a += TAU
    sourceAngles.push(a)
  }
  if (sourceAngles.at(-1)! - sourceAngles[0]! >= TAU - EPSILON) return null
  const connections = new Map(
    buses.flatMap((b) =>
      b.connections.map((c) => [c.connectionIndex, c] as const),
    ),
  )
  const orderedIndex = new Map(ordered.map((c, i) => [c.connectionIndex, i]))
  const sites = new Map<string, number>()
  const candidateGroups = new Map<number, Candidate[]>()
  for (const c of connections.values())
    candidateGroups.set(c.connectionIndex, [])
  for (const raw of getComponentDogboneViaSiteCandidates(buses, rules)) {
    const c = connections.get(raw.connectionIndex)!
    const key = `${raw.point.x.toFixed(9)},${raw.point.y.toFixed(9)}`
    if (!sites.has(key)) sites.set(key, sites.size)
    const index = orderedIndex.get(raw.connectionIndex)
    const sourceAngle = angle(c.sourcePoint)
    const a =
      index === undefined
        ? angle(raw.point)
        : sourceAngles[index]! +
          Math.atan2(
            Math.sin(angle(raw.point) - sourceAngle),
            Math.cos(angle(raw.point) - sourceAngle),
          )
    candidateGroups.get(raw.connectionIndex)!.push({
      ...raw,
      angle: a,
      siteIndex: sites.get(key)!,
      sourceSegment: {
        start: c.sourcePoint,
        end: raw.point,
        layer: c.sourceLayer,
        width: rules.traceWidth,
      },
    })
  }
  const groups = [...candidateGroups.entries()].map(
    ([connectionIndex, candidates]) => ({ connectionIndex, candidates }),
  )
  if (groups.some((g) => g.candidates.length === 0)) return null
  const domains = ordered.map((c, i) =>
    candidateGroups
      .get(c.connectionIndex)!
      .toSorted(
        (a, b) =>
          Math.abs(a.angle - sourceAngles[i]!) -
            Math.abs(b.angle - sourceAngles[i]!) ||
          distance(b.point, center) - distance(a.point, center),
      ),
  )
  const requiredHoleSeparation = rules.viaHoleDiameter
    ? rules.viaHoleDiameter + (rules.holeToHoleClearance ?? rules.clearance)
    : 0
  const requiredViaToTraceSeparation =
    rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance
  const compatible = (a: Candidate, b: Candidate) => {
    const share =
      rules.canShareCopper?.(a.connectionIndex, b.connectionIndex) ?? false
    const minimumViaDistance = share
      ? requiredHoleSeparation
      : Math.max(requiredHoleSeparation, rules.viaDiameter + rules.clearance)
    if (distance(a.point, b.point) < minimumViaDistance - EPSILON) return false
    if (share) return true
    return (
      distancePointToSegment(
        a.point,
        b.sourceSegment.start,
        b.sourceSegment.end,
      ) >=
        requiredViaToTraceSeparation - EPSILON &&
      distancePointToSegment(
        b.point,
        a.sourceSegment.start,
        a.sourceSegment.end,
      ) >=
        requiredViaToTraceSeparation - EPSILON &&
      segmentsAreClear(a.sourceSegment, b.sourceSegment, rules.clearance)
    )
  }
  const forbidden = new Map<Candidate, Set<Candidate>>()
  for (const domain of domains)
    for (const a of domain) {
      const conflicts = new Set<Candidate>()
      for (const group of groups)
        for (const b of group.candidates) {
          if (a.connectionIndex !== b.connectionIndex && !compatible(a, b))
            conflicts.add(b)
        }
      forbidden.set(a, conflicts)
    }
  const chosen: Candidate[] = []
  // A perfect matching is necessary because distinct drilled holes cannot use
  // the same site. It is a pruning test; native matching still validates copper.
  const canUseDistinctSiteCheck =
    requiredHoleSeparation > EPSILON || !rules.canShareCopper
  const remainingSitesCanMatch = () => {
    if (!canUseDistinctSiteCheck) return true
    const selected = new Map(
      chosen.map((c) => [c.connectionIndex, c.siteIndex]),
    )
    const allowed = groups
      .map((g) =>
        g.candidates
          .filter(
            (c) =>
              (!selected.has(c.connectionIndex) ||
                selected.get(c.connectionIndex) === c.siteIndex) &&
              chosen.every((a) => !forbidden.get(a)!.has(c)),
          )
          .map((c) => c.siteIndex),
      )
      .sort((a, b) => a.length - b.length)
    if (allowed.some((d) => d.length === 0)) return false
    const owner = new Int32Array(sites.size).fill(-1)
    const augment = (index: number, visited: Uint8Array): boolean => {
      for (const site of allowed[index]!) {
        if (visited[site]) continue
        visited[site] = 1
        if (owner[site] === -1 || augment(owner[site]!, visited)) {
          owner[site] = index
          return true
        }
      }
      return false
    }
    return allowed.every((_, i) => augment(i, new Uint8Array(sites.size)))
  }
  let states = 0
  let completeAssignments = 0
  let result: Map<number, Point2D> | null = null
  const search = (index: number): boolean => {
    if (++states > maximumOrderingStates) return false
    if (index === domains.length) {
      if (++completeAssignments > maximumCompleteAssignments) return false
      const fixed = new Map(rules.fixedViaPointsByConnectionIndex)
      for (const c of chosen) fixed.set(c.connectionIndex, c.point)
      result = matchComponentDogboneViaSites(buses, {
        ...rules,
        fixedViaPointsByConnectionIndex: fixed,
      })
      return result !== null
    }
    for (const candidate of domains[index]!) {
      if (
        candidate.angle < (chosen.at(-1)?.angle ?? -Infinity) - EPSILON ||
        chosen.some((c) => forbidden.get(c)!.has(candidate))
      )
        continue
      chosen.push(candidate)
      if (remainingSitesCanMatch() && search(index + 1)) return true
      chosen.pop()
      if (
        states > maximumOrderingStates ||
        completeAssignments >= maximumCompleteAssignments
      )
        break
    }
    return false
  }
  search(0)
  return result
}

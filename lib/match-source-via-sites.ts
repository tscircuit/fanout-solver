import { distance, distancePointToSegment, segmentsAreClear } from "./geometry"
import {
  type DogboneViaSiteGeometryRules,
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
} from "./match-component-dogbone-via-sites"
import type {
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"

interface Candidate {
  point: Point2D
  segment: RoutedSegment
}
interface Arc {
  other: number
  supports: Uint32Array
  reverseSupports: Uint32Array
}
const EPSILON = 1e-9
function bitCount(mask: number): number {
  mask -= (mask >>> 1) & 0x55555555
  mask = (mask & 0x33333333) + ((mask >>> 2) & 0x33333333)
  return (((mask + (mask >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
export interface SourceViaSiteFailure {
  kind:
    | "empty-domains"
    | "incompatible-domains"
    | "search-budget"
    | "no-assignment"
  /** Conservative recovery hints, not a minimal unsatisfiable subset. */
  connectionIndices: readonly number[]
}

/** Resolve native source sites with arc consistency and independent conflict components.
 * Candidate geometry and preferences are supplied by the existing dogbone matcher.
 * All candidate assignments remain provisional until the complete bus is routed.
 */
export function matchSourceViaSites(
  buses: readonly PreparedBus[],
  rules: DogboneViaSiteGeometryRules,
  onFailure?: (failure: SourceViaSiteFailure) => void,
): Map<number, Point2D> | null {
  const maximumSearchStates = rules.maximumSearchStates ?? 100_000
  if (!Number.isSafeInteger(maximumSearchStates) || maximumSearchStates < 1)
    throw new Error(
      "Source via matching requires a positive safe-integer search budget",
    )
  const candidates = getComponentDogboneViaSiteCandidates(buses, rules)
  const connections = new Map<number, PreparedConnection>()
  for (const bus of buses)
    for (const connection of bus.connections)
      connections.set(connection.connectionIndex, connection)
  const entries = [...connections.values()]
    .sort((a, b) => a.connectionIndex - b.connectionIndex)
    .map((connection) => ({
      connection,
      candidates: candidates
        .filter((c) => c.connectionIndex === connection.connectionIndex)
        .map((c) => ({
          point: c.point,
          segment: {
            start: connection.sourcePoint,
            end: c.point,
            width: rules.traceWidth,
            layer: connection.sourceLayer,
          },
        })),
    }))
  const emptyEntries = entries.filter((entry) => entry.candidates.length === 0)
  if (emptyEntries.length) {
    onFailure?.({
      kind: "empty-domains",
      connectionIndices: emptyEntries.map(
        (entry) => entry.connection.connectionIndex,
      ),
    })
    return null
  }
  // Native domains have at most eight sites. Preserve the general matcher for
  // any future candidate generator that exceeds this representation.
  if (entries.some((e) => e.candidates.length > 30)) {
    const result = matchComponentDogboneViaSites(buses, rules)
    if (!result)
      onFailure?.({
        kind: "no-assignment",
        connectionIndices: entries.map(
          (entry) => entry.connection.connectionIndex,
        ),
      })
    return result
  }
  const count = entries.length
  if (count === 0) return new Map()
  const arcs: Arc[][] = Array.from({ length: count }, () => [])
  const viaTraceClearance =
    rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance
  const holeClearance = rules.viaHoleDiameter
    ? rules.viaHoleDiameter + (rules.holeToHoleClearance ?? rules.clearance)
    : 0
  const compatible = (
    first: Candidate,
    second: Candidate,
    firstId: number,
    secondId: number,
  ): boolean => {
    const merge = rules.canShareCopper?.(firstId, secondId) ?? false
    if (
      distance(first.point, second.point) <
      (merge
        ? holeClearance
        : Math.max(rules.viaDiameter + rules.clearance, holeClearance)) -
        EPSILON
    )
      return false
    if (merge) return true
    if (
      distancePointToSegment(
        first.point,
        second.segment.start,
        second.segment.end,
      ) <
        viaTraceClearance - EPSILON ||
      distancePointToSegment(
        second.point,
        first.segment.start,
        first.segment.end,
      ) <
        viaTraceClearance - EPSILON
    )
      return false
    return segmentsAreClear(first.segment, second.segment, rules.clearance)
  }
  for (let i = 0; i < count; i++)
    for (let j = i + 1; j < count; j++) {
      const a = entries[i]!
      const b = entries[j]!
      const forward = new Uint32Array(a.candidates.length)
      const reverse = new Uint32Array(b.candidates.length)
      let conflicts = false
      for (let ai = 0; ai < a.candidates.length; ai++)
        for (let bi = 0; bi < b.candidates.length; bi++) {
          if (
            compatible(
              a.candidates[ai]!,
              b.candidates[bi]!,
              a.connection.connectionIndex,
              b.connection.connectionIndex,
            )
          ) {
            forward[ai]! |= 1 << bi
            reverse[bi]! |= 1 << ai
          } else conflicts = true
        }
      if (conflicts) {
        arcs[i]!.push({ other: j, supports: forward, reverseSupports: reverse })
        arcs[j]!.push({ other: i, supports: reverse, reverseSupports: forward })
      }
    }
  let lastConflict: number[] = []
  const propagate = (domains: Uint32Array, queue: number[]): boolean => {
    const queued = new Uint8Array(count)
    for (const i of queue) queued[i] = 1
    for (let head = 0; head < queue.length; head++) {
      const changed = queue[head]!
      queued[changed] = 0
      for (const arc of arcs[changed]!) {
        const before = domains[arc.other]!
        let after = before
        for (let value = 0; value < arc.reverseSupports.length; value++) {
          if (
            after & (1 << value) &&
            !(arc.reverseSupports[value]! & domains[changed]!)
          )
            after &= ~(1 << value)
        }
        if (after === 0) {
          lastConflict = [
            entries[changed]!.connection.connectionIndex,
            entries[arc.other]!.connection.connectionIndex,
          ]
          return false
        }
        if (after !== before) {
          domains[arc.other] = after
          if (!queued[arc.other]) {
            queued[arc.other] = 1
            queue.push(arc.other)
          }
        }
      }
    }
    return true
  }
  let state: Uint32Array = new Uint32Array(
    entries.map((e) => 2 ** e.candidates.length - 1),
  )
  if (
    !propagate(
      state,
      entries.map((_, i) => i),
    )
  ) {
    onFailure?.({
      kind: "incompatible-domains",
      connectionIndices: lastConflict,
    })
    return null
  }
  const groups: number[][] = []
  const seen = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    if (seen[i]) continue
    const group = [i]
    seen[i] = 1
    for (let offset = 0; offset < group.length; offset++)
      for (const arc of arcs[group[offset]!]!)
        if (!seen[arc.other]) {
          seen[arc.other] = 1
          group.push(arc.other)
        }
    groups.push(group)
  }
  let searchedStates = 0
  const search = (
    domains: Uint32Array,
    group: readonly number[],
  ): Uint32Array | null => {
    let selected = -1
    let fewest = 31
    let greatestDegree = -1
    for (const i of group) {
      const size = bitCount(domains[i]!)
      if (size < 2) continue
      const degree = arcs[i]!.reduce(
        (n, arc) => n + Number(bitCount(domains[arc.other]!) > 1),
        0,
      )
      if (size < fewest || (size === fewest && degree > greatestDegree)) {
        selected = i
        fewest = size
        greatestDegree = degree
      }
    }
    if (selected < 0) return domains
    if (++searchedStates > maximumSearchStates) return null
    const choices = entries[selected]!.candidates.map((_, i) => i)
      .filter((i) => domains[selected]! & (1 << i))
      .map((value) => ({
        value,
        removed: arcs[selected]!.reduce(
          (n, arc) => n + bitCount(domains[arc.other]! & ~arc.supports[value]!),
          0,
        ),
      }))
      .sort((a, b) => a.removed - b.removed || a.value - b.value)
    for (const choice of choices) {
      const next = domains.slice()
      next[selected] = 1 << choice.value
      if (!propagate(next, [selected])) continue
      const result = search(next, group)
      if (result) return result
      if (searchedStates > maximumSearchStates) return null
    }
    return null
  }
  for (const group of groups.sort((a, b) => a.length - b.length)) {
    const matched = search(state, group)
    if (!matched) {
      onFailure?.({
        kind:
          searchedStates > maximumSearchStates
            ? "search-budget"
            : "incompatible-domains",
        connectionIndices:
          searchedStates > maximumSearchStates
            ? group.map((i) => entries[i]!.connection.connectionIndex)
            : lastConflict,
      })
      return null
    }
    state = matched
  }
  return new Map(
    entries.map((entry, i) => [
      entry.connection.connectionIndex,
      { ...entry.candidates[Math.log2(state[i]!)]!.point },
    ]),
  )
}

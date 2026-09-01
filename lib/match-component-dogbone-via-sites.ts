import type { Obstacle } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import type {
  FanoutDirection,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"

const EPSILON = 1e-9
const DEFAULT_MAXIMUM_SEARCH_STATES = 100_000

export interface DogboneViaSiteGeometryRules {
  viaDiameter: number
  viaHoleDiameter?: number
  traceWidth: number
  clearance: number
  /** Defaults to `clearance` when a hole diameter is supplied. */
  holeToHoleClearance?: number
  /** Bounds the deterministic backtracking search across all components. */
  maximumSearchStates?: number
  /** Optional aggregate budget shared across multiple matching calls. */
  expandedStateBudget?: { remaining: number; exhausted?: boolean }
  /**
   * Optional bounded-search preference for boundary-bus dogbones. The sign
   * refers to the axis perpendicular to each bus's local escape direction.
   */
  preferredBoundaryPerpendicularSideByBusId?: ReadonlyMap<string, -1 | 1>
  /** Prefer the local outward or inward half-pitch row for a boundary bus. */
  preferBoundaryOutwardByBusId?: ReadonlyMap<string, boolean>
  /** Existing assignments that must be preserved while matching other pads. */
  fixedViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
  /** Legal candidates at these points are tried before other candidates. */
  preferredViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
  /** Routed copper that every newly assigned through-via/dogbone must clear. */
  blockingSegments?: readonly {
    connectionIndex: number
    segment: RoutedSegment
  }[]
  /** True only when the two connections are allowed to merge copper. */
  canShareCopper?: (
    firstConnectionIndex: number,
    secondConnectionIndex: number,
  ) => boolean
}

interface ComponentConnection {
  preparedConnection: PreparedConnection
  busId: string
  direction: FanoutDirection
  terminationType: PreparedBus["termination"]["type"]
}

interface ComponentMatchingInput {
  componentId: string
  connections: ComponentConnection[]
  obstacles: Obstacle[]
  xCoordinates: number[]
  yCoordinates: number[]
  pitchX: number
  pitchY: number
}

interface ViaSiteCandidate {
  connectionIndex: number
  point: Point2D
  sourceSegment: RoutedSegment
  outwardRank: number
}

interface ConnectionCandidates {
  connection: ComponentConnection
  candidates: ViaSiteCandidate[]
}

export interface ComponentDogboneViaSiteCandidate {
  connectionIndex: number
  point: Point2D
}

/** A via assignment together with its complete source-layer dogbone path. */
export interface ComponentDogboneViaPath {
  point: Point2D
  path: Point2D[]
}

export interface ComponentDogboneViaPathCandidate
  extends ComponentDogboneViaPath {
  connectionIndex: number
}

export interface PlaneDogbonePathOptions {
  /**
   * Connections that may use channel candidates. When omitted, the matcher
   * expands only zero-domain and matching-dead-end participants as needed.
   */
  channelConnectionIndexes?: ReadonlySet<number>
  /** Furthest component-pitch ring considered by channel candidates. */
  maximumChannelRing?: number
  /** Ring used for the first adaptive channel expansion. */
  initialChannelRing?: number
  /** Maximum endpoint-diverse channel candidates retained per connection. */
  maximumChannelCandidatesPerConnection?: number
  /** Maximum number of adaptive dead-end-frontier expansion passes. */
  maximumExpansionRounds?: number
  /** State allowance for each cheap pre-expansion diagnostic matching pass. */
  maximumDiagnosticSearchStates?: number
  /** Optional clipping bounds for every generated path point. */
  bounds?: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
}

/**
 * Opt-in rules for matching multi-segment plane dogbones. Existing site-only
 * APIs intentionally ignore these additions and preserve their prior output.
 */
export interface DogboneViaPathGeometryRules
  extends DogboneViaSiteGeometryRules {
  /**
   * Complete obstacle set for path-aware matching. A through-via is checked
   * against every obstacle regardless of layer; source paths check only their
   * source copper layer.
   */
  blockingObstacles?: readonly Obstacle[]
  /** True when a connection is electrically allowed to touch an obstacle. */
  obstacleCanBeIgnored?: (
    connectionIndex: number,
    obstacle: Obstacle,
  ) => boolean
  /** Complete fixed assignments, including non-direct dogbone paths. */
  fixedViaPathsByConnectionIndex?: ReadonlyMap<number, ComponentDogboneViaPath>
  /** Complete legal assignments to try first. */
  preferredViaPathsByConnectionIndex?: ReadonlyMap<
    number,
    ComponentDogboneViaPath
  >
  planePathOptions?: PlaneDogbonePathOptions
}

function assertGeometryRules(rules: DogboneViaSiteGeometryRules): number {
  for (const [name, value] of [
    ["viaDiameter", rules.viaDiameter],
    ["traceWidth", rules.traceWidth],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `FanoutSolver: dogbone ${name} must be a positive finite number, received ${value}`,
      )
    }
  }
  if (!Number.isFinite(rules.clearance) || rules.clearance < 0) {
    throw new Error(
      `FanoutSolver: dogbone clearance must be a non-negative finite number, received ${rules.clearance}`,
    )
  }
  if (
    rules.viaHoleDiameter !== undefined &&
    (!Number.isFinite(rules.viaHoleDiameter) || rules.viaHoleDiameter <= 0)
  ) {
    throw new Error(
      `FanoutSolver: dogbone viaHoleDiameter must be a positive finite number, received ${rules.viaHoleDiameter}`,
    )
  }
  if (
    rules.holeToHoleClearance !== undefined &&
    (!Number.isFinite(rules.holeToHoleClearance) ||
      rules.holeToHoleClearance < 0)
  ) {
    throw new Error(
      `FanoutSolver: dogbone holeToHoleClearance must be a non-negative finite number, received ${rules.holeToHoleClearance}`,
    )
  }
  if (
    rules.holeToHoleClearance !== undefined &&
    rules.viaHoleDiameter === undefined
  ) {
    throw new Error(
      "FanoutSolver: dogbone holeToHoleClearance requires viaHoleDiameter",
    )
  }
  const maximumSearchStates =
    rules.maximumSearchStates ?? DEFAULT_MAXIMUM_SEARCH_STATES
  if (!Number.isInteger(maximumSearchStates) || maximumSearchStates < 1) {
    throw new Error(
      `FanoutSolver: dogbone maximumSearchStates must be a positive integer, received ${maximumSearchStates}`,
    )
  }
  return maximumSearchStates
}

function uniqueSortedCoordinates(values: readonly number[]): number[] {
  const result: number[] = []
  for (const value of values.toSorted((first, second) => first - second)) {
    if (!Number.isFinite(value)) continue
    if (result.length === 0 || Math.abs(result.at(-1)! - value) > EPSILON) {
      result.push(value)
    }
  }
  return result
}

function getComponentMatchingInputs(
  preparedBuses: readonly PreparedBus[],
): ComponentMatchingInput[] {
  const byComponent = new Map<string, ComponentMatchingInput>()
  const componentByConnectionIndex = new Map<number, string>()

  for (const bus of preparedBuses) {
    let component = byComponent.get(bus.componentId)
    if (!component) {
      component = {
        componentId: bus.componentId,
        connections: [],
        obstacles: [],
        xCoordinates: [],
        yCoordinates: [],
        pitchX: Number.POSITIVE_INFINITY,
        pitchY: Number.POSITIVE_INFINITY,
      }
      byComponent.set(bus.componentId, component)
    }

    component.xCoordinates.push(...bus.xCoordinates)
    component.yCoordinates.push(...bus.yCoordinates)
    if (Number.isFinite(bus.pitchX) && bus.pitchX > EPSILON) {
      component.pitchX = Math.min(component.pitchX, bus.pitchX)
    }
    if (Number.isFinite(bus.pitchY) && bus.pitchY > EPSILON) {
      component.pitchY = Math.min(component.pitchY, bus.pitchY)
    }
    for (const obstacle of bus.componentObstacles) {
      if (!component.obstacles.includes(obstacle)) {
        component.obstacles.push(obstacle)
      }
    }
    for (const preparedConnection of bus.connections) {
      const existingComponent = componentByConnectionIndex.get(
        preparedConnection.connectionIndex,
      )
      if (existingComponent !== undefined) {
        if (existingComponent !== bus.componentId) {
          throw new Error(
            `FanoutSolver: connection index ${preparedConnection.connectionIndex} belongs to multiple components`,
          )
        }
        continue
      }
      componentByConnectionIndex.set(
        preparedConnection.connectionIndex,
        bus.componentId,
      )
      component.connections.push({
        preparedConnection,
        busId: bus.busId,
        direction: bus.direction,
        terminationType: bus.termination.type,
      })
    }
  }

  return [...byComponent.values()]
    .map((component) => ({
      ...component,
      connections: component.connections.toSorted(
        (first, second) =>
          first.preparedConnection.connectionIndex -
          second.preparedConnection.connectionIndex,
      ),
      xCoordinates: uniqueSortedCoordinates(component.xCoordinates),
      yCoordinates: uniqueSortedCoordinates(component.yCoordinates),
    }))
    .toSorted((first, second) =>
      first.componentId.localeCompare(second.componentId),
    )
}

function getInterstitialCoordinates(params: {
  coordinates: readonly number[]
  pitch: number
}): number[] {
  const { coordinates, pitch } = params
  if (coordinates.length === 0 || !Number.isFinite(pitch) || pitch <= EPSILON) {
    return []
  }
  const interstitialCoordinates = [coordinates[0]! - pitch / 2]
  for (let index = 1; index < coordinates.length; index++) {
    interstitialCoordinates.push(
      (coordinates[index - 1]! + coordinates[index]!) / 2,
    )
  }
  interstitialCoordinates.push(coordinates.at(-1)! + pitch / 2)
  return uniqueSortedCoordinates(interstitialCoordinates)
}

function getAdjacentInterstitialCoordinates(params: {
  sourceCoordinate: number
  coordinates: readonly number[]
  pitch: number
}): number[] {
  const { sourceCoordinate, coordinates, pitch } = params
  const interstitialCoordinates = getInterstitialCoordinates({
    coordinates,
    pitch,
  })
  const before = interstitialCoordinates
    .filter((coordinate) => coordinate < sourceCoordinate - EPSILON)
    .at(-1)
  const after = interstitialCoordinates.find(
    (coordinate) => coordinate > sourceCoordinate + EPSILON,
  )
  return [before, after].filter(
    (coordinate): coordinate is number => coordinate !== undefined,
  )
}

function directSegmentIsStraightOr45(start: Point2D, end: Point2D): boolean {
  const absoluteX = Math.abs(end.x - start.x)
  const absoluteY = Math.abs(end.y - start.y)
  return (
    absoluteX <= EPSILON ||
    absoluteY <= EPSILON ||
    Math.abs(absoluteX - absoluteY) <= EPSILON
  )
}

function getOutwardRank(params: {
  source: Point2D
  site: Point2D
  direction: FanoutDirection
}): number {
  const { source, site, direction } = params
  const outwardDisplacement =
    direction === "right"
      ? site.x - source.x
      : direction === "left"
        ? source.x - site.x
        : direction === "up"
          ? site.y - source.y
          : source.y - site.y
  return outwardDisplacement > EPSILON
    ? 0
    : Math.abs(outwardDisplacement) <= EPSILON
      ? 1
      : 2
}

function viaSiteClearsObstacles(params: {
  point: Point2D
  obstacles: readonly Obstacle[]
  viaDiameter: number
  clearance: number
}): boolean {
  const { point, obstacles, viaDiameter, clearance } = params
  const requiredClearance = viaDiameter / 2 + clearance
  return obstacles.every(
    (obstacle) =>
      distancePointToObstacle(point, obstacle) >= requiredClearance - EPSILON,
  )
}

function sourceSegmentClearsOtherObstacles(params: {
  segment: RoutedSegment
  sourceObstacle: Obstacle
  obstacles: readonly Obstacle[]
  clearance: number
}): boolean {
  const { segment, sourceObstacle, obstacles, clearance } = params
  const requiredClearance = segment.width / 2 + clearance
  return obstacles.every(
    (obstacle) =>
      obstacle === sourceObstacle ||
      distanceSegmentToObstacle(segment, obstacle) >=
        requiredClearance - EPSILON,
  )
}

function getConnectionCandidates(params: {
  connection: ComponentConnection
  component: ComponentMatchingInput
  rules: DogboneViaSiteGeometryRules
}): ViaSiteCandidate[] {
  const { connection, component, rules } = params
  const { preparedConnection, direction } = connection
  const source = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const adjacentX = getAdjacentInterstitialCoordinates({
    sourceCoordinate: source.x,
    coordinates: component.xCoordinates,
    pitch: component.pitchX,
  })
  const adjacentY = getAdjacentInterstitialCoordinates({
    sourceCoordinate: source.y,
    coordinates: component.yCoordinates,
    pitch: component.pitchY,
  })
  const rawPoints: Point2D[] = [
    ...adjacentX.map((x) => ({ x, y: source.y })),
    ...adjacentY.map((y) => ({ x: source.x, y })),
    ...adjacentX.flatMap((x) => adjacentY.map((y) => ({ x, y }))),
  ]
  const uniquePoints: Point2D[] = []
  for (const point of rawPoints) {
    if (
      !uniquePoints.some((candidate) => distance(candidate, point) <= EPSILON)
    ) {
      uniquePoints.push(point)
    }
  }
  const fixedViaPoint = rules.fixedViaPointsByConnectionIndex?.get(
    preparedConnection.connectionIndex,
  )
  const candidatePoints = fixedViaPoint ? [fixedViaPoint] : uniquePoints

  const candidates: ViaSiteCandidate[] = []
  for (const point of candidatePoints) {
    if (
      connection.terminationType === "plane" &&
      !directSegmentIsStraightOr45(source, point)
    ) {
      continue
    }
    if (
      !viaSiteClearsObstacles({
        point,
        obstacles: component.obstacles,
        viaDiameter: rules.viaDiameter,
        clearance: rules.clearance,
      })
    ) {
      continue
    }
    const sourceSegment: RoutedSegment = {
      start: source,
      end: point,
      width: rules.traceWidth,
      layer: preparedConnection.sourceLayer,
    }
    if (
      !sourceSegmentClearsOtherObstacles({
        segment: sourceSegment,
        sourceObstacle: preparedConnection.sourceObstacle,
        obstacles: component.obstacles,
        clearance: rules.clearance,
      })
    ) {
      continue
    }
    const candidateClearsRoutedCopper = (rules.blockingSegments ?? []).every(
      (blocker) => {
        if (blocker.connectionIndex === preparedConnection.connectionIndex) {
          return true
        }
        if (
          rules.canShareCopper?.(
            preparedConnection.connectionIndex,
            blocker.connectionIndex,
          )
        ) {
          return true
        }
        const viaToTraceClearance =
          rules.viaDiameter / 2 + blocker.segment.width / 2 + rules.clearance
        if (
          distancePointToSegment(
            point,
            blocker.segment.start,
            blocker.segment.end,
          ) <
          viaToTraceClearance - EPSILON
        ) {
          return false
        }
        return (
          blocker.segment.layer !== sourceSegment.layer ||
          segmentsAreClear(sourceSegment, blocker.segment, rules.clearance)
        )
      },
    )
    if (!candidateClearsRoutedCopper) continue
    candidates.push({
      connectionIndex: preparedConnection.connectionIndex,
      point,
      sourceSegment,
      outwardRank: getOutwardRank({ source, site: point, direction }),
    })
  }

  const preferredPerpendicularSide =
    connection.terminationType === "boundary"
      ? rules.preferredBoundaryPerpendicularSideByBusId?.get(connection.busId)
      : undefined
  const preferOutward =
    connection.terminationType === "boundary"
      ? (rules.preferBoundaryOutwardByBusId?.get(connection.busId) ?? true)
      : true
  const getPerpendicularPreferenceRank = (
    candidate: ViaSiteCandidate,
  ): number => {
    if (preferredPerpendicularSide === undefined) return 0
    const displacement =
      direction === "left" || direction === "right"
        ? candidate.point.y - source.y
        : candidate.point.x - source.x
    return displacement * preferredPerpendicularSide > EPSILON
      ? 0
      : Math.abs(displacement) <= EPSILON
        ? 1
        : 2
  }
  return candidates.toSorted(
    (first, second) =>
      (preferOutward
        ? first.outwardRank - second.outwardRank
        : second.outwardRank - first.outwardRank) ||
      getPerpendicularPreferenceRank(first) -
        getPerpendicularPreferenceRank(second) ||
      distance(source, first.point) - distance(source, second.point) ||
      first.point.x - second.point.x ||
      first.point.y - second.point.y,
  )
}

function candidatesAreMutuallyClear(params: {
  first: ViaSiteCandidate
  second: ViaSiteCandidate
  rules: DogboneViaSiteGeometryRules
}): boolean {
  const { first, second, rules } = params
  const canShareCopper =
    rules.canShareCopper?.(first.connectionIndex, second.connectionIndex) ??
    false
  const requiredHoleSeparation = rules.viaHoleDiameter
    ? rules.viaHoleDiameter + (rules.holeToHoleClearance ?? rules.clearance)
    : 0
  const requiredViaSeparation = canShareCopper
    ? requiredHoleSeparation
    : Math.max(rules.viaDiameter + rules.clearance, requiredHoleSeparation)
  if (distance(first.point, second.point) < requiredViaSeparation - EPSILON) {
    return false
  }
  const requiredViaToTraceClearance =
    rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance
  if (!canShareCopper) {
    if (
      distancePointToSegment(
        first.point,
        second.sourceSegment.start,
        second.sourceSegment.end,
      ) <
        requiredViaToTraceClearance - EPSILON ||
      distancePointToSegment(
        second.point,
        first.sourceSegment.start,
        first.sourceSegment.end,
      ) <
        requiredViaToTraceClearance - EPSILON
    ) {
      return false
    }
  }
  if (canShareCopper) return true
  return segmentsAreClear(
    first.sourceSegment,
    second.sourceSegment,
    rules.clearance,
  )
}

function matchComponentAlternatives(params: {
  component: ComponentMatchingInput
  rules: DogboneViaSiteGeometryRules
  consumeSearchState: () => boolean
  maximumAlternatives: number
}): Map<number, Point2D>[] {
  const { component, rules, consumeSearchState, maximumAlternatives } = params
  const entries: ConnectionCandidates[] = component.connections.map(
    (connection) => {
      const candidates = getConnectionCandidates({
        connection,
        component,
        rules,
      })
      const preferredPoint = rules.preferredViaPointsByConnectionIndex?.get(
        connection.preparedConnection.connectionIndex,
      )
      if (
        preferredPoint &&
        Number.isFinite(preferredPoint.x) &&
        Number.isFinite(preferredPoint.y)
      ) {
        const preferredIndex = candidates.findIndex(
          (candidate) => distance(candidate.point, preferredPoint) <= EPSILON,
        )
        if (preferredIndex > 0) {
          candidates.unshift(...candidates.splice(preferredIndex, 1))
        }
      }
      return { connection, candidates }
    },
  )
  if (entries.some((entry) => entry.candidates.length === 0)) return []
  // Every solution must include each sole candidate. Seed and validate those
  // forced choices once so recursive matching only explores genuine choices.
  const forcedCandidates = entries.flatMap((entry) =>
    entry.candidates.length === 1 ? [entry.candidates[0]!] : [],
  )
  for (
    let candidateIndex = 0;
    candidateIndex < forcedCandidates.length;
    candidateIndex++
  ) {
    const candidate = forcedCandidates[candidateIndex]!
    for (
      let previousIndex = 0;
      previousIndex < candidateIndex;
      previousIndex++
    ) {
      if (
        !candidatesAreMutuallyClear({
          first: candidate,
          second: forcedCandidates[previousIndex]!,
          rules,
        })
      ) {
        return []
      }
    }
  }

  const variableConnectionIndexes = new Set(
    entries.flatMap((entry) =>
      entry.candidates.length > 1
        ? [entry.connection.preparedConnection.connectionIndex]
        : [],
    ),
  )
  for (const entry of entries) {
    if (entry.candidates.length === 1) continue
    entry.candidates = entry.candidates.filter((candidate) =>
      forcedCandidates.every((forcedCandidate) =>
        candidatesAreMutuallyClear({
          first: candidate,
          second: forcedCandidate,
          rules,
        }),
      ),
    )
    if (entry.candidates.length === 0) return []
  }

  const forcedCandidatesByConnectionIndex = new Map(
    forcedCandidates.map((candidate) => [candidate.connectionIndex, candidate]),
  )
  const assignedCandidates = new Map<number, ViaSiteCandidate>()
  const remaining = new Set(variableConnectionIndexes)
  const entryByConnectionIndex = new Map(
    entries.map((entry) => [
      entry.connection.preparedConnection.connectionIndex,
      entry,
    ]),
  )

  if (remaining.size === 0) {
    return [
      new Map(
        [...forcedCandidatesByConnectionIndex.entries()].map(
          ([connectionIndex, candidate]) => [
            connectionIndex,
            { ...candidate.point },
          ],
        ),
      ),
    ]
  }

  const getViableCandidates = (
    entry: ConnectionCandidates,
  ): ViaSiteCandidate[] =>
    entry.candidates.filter((candidate) =>
      [...assignedCandidates.values()].every((assignedCandidate) =>
        candidatesAreMutuallyClear({
          first: candidate,
          second: assignedCandidate,
          rules,
        }),
      ),
    )

  const alternatives: Map<number, Point2D>[] = []
  const augmentMatching = (): boolean => {
    if (!consumeSearchState()) return true
    if (remaining.size === 0) {
      alternatives.push(
        new Map(
          [
            ...forcedCandidatesByConnectionIndex.entries(),
            ...assignedCandidates.entries(),
          ]
            .toSorted(([first], [second]) => first - second)
            .map(([connectionIndex, candidate]) => [
              connectionIndex,
              { ...candidate.point },
            ]),
        ),
      )
      return alternatives.length >= maximumAlternatives
    }

    let selectedEntry: ConnectionCandidates | undefined
    let selectedCandidates: ViaSiteCandidate[] = []
    for (const connectionIndex of [...remaining].toSorted(
      (first, second) => first - second,
    )) {
      const entry = entryByConnectionIndex.get(connectionIndex)!
      const viableCandidates = getViableCandidates(entry)
      if (viableCandidates.length === 0) {
        return false
      }
      if (
        !selectedEntry ||
        viableCandidates.length < selectedCandidates.length ||
        (viableCandidates.length === selectedCandidates.length &&
          connectionIndex <
            selectedEntry.connection.preparedConnection.connectionIndex)
      ) {
        selectedEntry = entry
        selectedCandidates = viableCandidates
      }
    }

    const connectionIndex =
      selectedEntry!.connection.preparedConnection.connectionIndex
    remaining.delete(connectionIndex)
    for (const candidate of selectedCandidates) {
      assignedCandidates.set(connectionIndex, candidate)
      if (augmentMatching()) {
        assignedCandidates.delete(connectionIndex)
        remaining.add(connectionIndex)
        return true
      }
      assignedCandidates.delete(connectionIndex)
    }
    remaining.add(connectionIndex)
    return false
  }

  augmentMatching()
  return alternatives
}

function assertMaximumAlternatives(maximumAlternatives: number): void {
  if (!Number.isInteger(maximumAlternatives) || maximumAlternatives < 1) {
    throw new Error(
      `FanoutSolver: dogbone maximumAlternatives must be a positive integer, received ${maximumAlternatives}`,
    )
  }
}

/**
 * Returns up to `maximumAlternatives` distinct complete dogbone matchings in
 * deterministic candidate-search order.
 */
export function matchComponentDogboneViaSiteAlternatives(
  preparedBuses: readonly PreparedBus[],
  rules: DogboneViaSiteGeometryRules,
  maximumAlternatives: number,
): Map<number, Point2D>[] {
  assertMaximumAlternatives(maximumAlternatives)
  const maximumSearchStates = assertGeometryRules(rules)
  if (preparedBuses.length === 0) return [new Map()]

  let consumedSearchStates = 0
  const consumeSearchState = (): boolean => {
    if (rules.expandedStateBudget && rules.expandedStateBudget.remaining <= 0) {
      rules.expandedStateBudget.exhausted = true
      return false
    }
    consumedSearchStates++
    if (rules.expandedStateBudget) {
      rules.expandedStateBudget.remaining--
      if (rules.expandedStateBudget.remaining <= 0) {
        rules.expandedStateBudget.exhausted = true
      }
    }
    return consumedSearchStates <= maximumSearchStates
  }
  let alternatives: Map<number, Point2D>[] = [new Map()]
  for (const component of getComponentMatchingInputs(preparedBuses)) {
    const componentAlternatives = matchComponentAlternatives({
      component,
      rules,
      consumeSearchState,
      maximumAlternatives,
    })
    if (componentAlternatives.length === 0) return []
    const combinedAlternatives: Map<number, Point2D>[] = []
    for (const alternative of alternatives) {
      for (const componentAlternative of componentAlternatives) {
        combinedAlternatives.push(
          new Map([...alternative, ...componentAlternative]),
        )
        if (combinedAlternatives.length >= maximumAlternatives) break
      }
      if (combinedAlternatives.length >= maximumAlternatives) break
    }
    alternatives = combinedAlternatives
  }
  return alternatives
}

/**
 * Matches every prepared connection to a legal adjacent dogbone via site.
 *
 * Candidate sites are derived from the component pad-center grid: midpoint
 * gaps plus one half-pitch perimeter coordinate on each side. The matcher
 * never infers component or connection metadata from identifiers.
 */
export function matchComponentDogboneViaSites(
  preparedBuses: readonly PreparedBus[],
  rules: DogboneViaSiteGeometryRules,
): Map<number, Point2D> | null {
  return (
    matchComponentDogboneViaSiteAlternatives(preparedBuses, rules, 1)[0] ?? null
  )
}

/**
 * Enumerates the same statically legal sites used by the component matcher.
 * This is useful to preserve future dogbone capacity while another bus is
 * being routed; callers must still run the full matcher afterward because
 * these candidates are not mutually assigned.
 */
export function getComponentDogboneViaSiteCandidates(
  preparedBuses: readonly PreparedBus[],
  rules: DogboneViaSiteGeometryRules,
): ComponentDogboneViaSiteCandidate[] {
  assertGeometryRules(rules)
  return getComponentMatchingInputs(preparedBuses).flatMap((component) =>
    component.connections.flatMap((connection) =>
      getConnectionCandidates({ connection, component, rules }).map(
        (candidate) => ({
          connectionIndex: candidate.connectionIndex,
          point: { ...candidate.point },
        }),
      ),
    ),
  )
}

interface ViaPathCandidate {
  connectionIndex: number
  point: Point2D
  path: Point2D[]
  sourceSegments: RoutedSegment[]
  kind: "direct" | "knight" | "channel"
}

type PathCompatibilityCache = WeakMap<
  ViaPathCandidate,
  WeakMap<ViaPathCandidate, boolean>
>

interface PathConnectionCandidates {
  connection: ComponentConnection
  candidates: ViaPathCandidate[]
}

interface PathMatchingDeadEnd {
  connectionIndex: number
  blockingConnectionIndexes: number[]
  assigned: Array<{ connectionIndex: number; point: Point2D }>
}

const DEFAULT_MAXIMUM_CHANNEL_RING = 5
const DEFAULT_MAXIMUM_CHANNEL_CANDIDATES = 12
const DEFAULT_MAXIMUM_PATH_EXPANSION_ROUNDS = 16
const DEFAULT_MAXIMUM_DIAGNOSTIC_SEARCH_STATES = 10_000

function assertPlanePathOptions(
  options: PlaneDogbonePathOptions,
): Required<
  Pick<
    PlaneDogbonePathOptions,
    | "maximumChannelRing"
    | "initialChannelRing"
    | "maximumChannelCandidatesPerConnection"
    | "maximumExpansionRounds"
    | "maximumDiagnosticSearchStates"
  >
> {
  const result = {
    maximumChannelRing:
      options.maximumChannelRing ?? DEFAULT_MAXIMUM_CHANNEL_RING,
    initialChannelRing:
      options.initialChannelRing ??
      Math.min(
        DEFAULT_MAXIMUM_CHANNEL_RING,
        options.maximumChannelRing ?? DEFAULT_MAXIMUM_CHANNEL_RING,
      ),
    maximumChannelCandidatesPerConnection:
      options.maximumChannelCandidatesPerConnection ??
      DEFAULT_MAXIMUM_CHANNEL_CANDIDATES,
    maximumExpansionRounds:
      options.maximumExpansionRounds ?? DEFAULT_MAXIMUM_PATH_EXPANSION_ROUNDS,
    maximumDiagnosticSearchStates:
      options.maximumDiagnosticSearchStates ??
      DEFAULT_MAXIMUM_DIAGNOSTIC_SEARCH_STATES,
  }
  for (const [name, value, minimum] of [
    ["maximumChannelRing", result.maximumChannelRing, 2],
    ["initialChannelRing", result.initialChannelRing, 2],
    [
      "maximumChannelCandidatesPerConnection",
      result.maximumChannelCandidatesPerConnection,
      1,
    ],
    ["maximumExpansionRounds", result.maximumExpansionRounds, 1],
    ["maximumDiagnosticSearchStates", result.maximumDiagnosticSearchStates, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(
        `FanoutSolver: dogbone path ${name} must be an integer of at least ${minimum}, received ${value}`,
      )
    }
  }
  if (result.initialChannelRing > result.maximumChannelRing) {
    throw new Error(
      `FanoutSolver: dogbone path initialChannelRing ${result.initialChannelRing} must not exceed maximumChannelRing ${result.maximumChannelRing}`,
    )
  }
  if (options.bounds) {
    const { minX, maxX, minY, maxY } = options.bounds
    if (
      ![minX, maxX, minY, maxY].every(Number.isFinite) ||
      minX > maxX ||
      minY > maxY
    ) {
      throw new Error("FanoutSolver: dogbone path bounds must be finite")
    }
  }
  for (const connectionIndex of options.channelConnectionIndexes ?? []) {
    if (!Number.isInteger(connectionIndex) || connectionIndex < 0) {
      throw new Error(
        `FanoutSolver: dogbone path channel connection indexes must be non-negative integers, received ${connectionIndex}`,
      )
    }
  }
  return result
}

function copyPath(path: readonly Point2D[]): Point2D[] {
  return path.map((point) => ({ x: point.x, y: point.y }))
}

function dogbonePathKey(path: readonly Point2D[]): string {
  return path
    .map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)}`)
    .join(";")
}

function pointKey(point: Point2D): string {
  return `${point.x.toFixed(9)},${point.y.toFixed(9)}`
}

function getPathSegments(params: {
  path: readonly Point2D[]
  width: number
  layer: string
}): RoutedSegment[] {
  const { path, width, layer } = params
  const segments: RoutedSegment[] = []
  for (let index = 1; index < path.length; index++) {
    const start = path[index - 1]!
    const end = path[index]!
    if (distance(start, end) <= EPSILON) continue
    segments.push({ start: { ...start }, end: { ...end }, width, layer })
  }
  return segments
}

function pathIsOctilinearWithoutRightAngleCorners(
  path: readonly Point2D[],
): boolean {
  const angles: number[] = []
  for (let index = 1; index < path.length; index++) {
    const start = path[index - 1]!
    const end = path[index]!
    const deltaX = end.x - start.x
    const deltaY = end.y - start.y
    const absoluteX = Math.abs(deltaX)
    const absoluteY = Math.abs(deltaY)
    if (absoluteX <= EPSILON && absoluteY <= EPSILON) continue
    if (
      absoluteX > EPSILON &&
      absoluteY > EPSILON &&
      Math.abs(absoluteX - absoluteY) > EPSILON
    ) {
      return false
    }
    const angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI
    angles.push((angle + 360) % 360)
  }
  if (angles.length === 0) return false
  for (let index = 1; index < angles.length; index++) {
    let turn = Math.abs(angles[index]! - angles[index - 1]!)
    turn = Math.min(turn, 360 - turn)
    if (turn > 90 - EPSILON) return false
  }
  return true
}

function pathIsInsideBounds(
  path: readonly Point2D[],
  bounds: PlaneDogbonePathOptions["bounds"],
): boolean {
  if (!bounds) return true
  return path.every(
    (point) =>
      point.x >= bounds.minX - EPSILON &&
      point.x <= bounds.maxX + EPSILON &&
      point.y >= bounds.minY - EPSILON &&
      point.y <= bounds.maxY + EPSILON,
  )
}

function pathStartsAtSource(
  path: readonly Point2D[],
  connection: PreparedConnection,
): boolean {
  return (
    path.length >= 2 &&
    distance(path[0]!, connection.sourcePoint) <= EPSILON &&
    path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  )
}

function pathCandidateClearsObstacles(params: {
  candidate: ViaPathCandidate
  connection: ComponentConnection
  component: ComponentMatchingInput
  rules: DogboneViaPathGeometryRules
}): boolean {
  const { candidate, connection, component, rules } = params
  const connectionIndex = connection.preparedConnection.connectionIndex
  if (
    !viaSiteClearsObstacles({
      point: candidate.point,
      obstacles: component.obstacles,
      viaDiameter: rules.viaDiameter,
      clearance: rules.clearance,
    })
  ) {
    return false
  }
  const requiredViaToObstacle = rules.viaDiameter / 2 + rules.clearance
  for (const obstacle of rules.blockingObstacles ?? []) {
    if (rules.obstacleCanBeIgnored?.(connectionIndex, obstacle)) continue
    if (
      distancePointToObstacle(candidate.point, obstacle) <
      requiredViaToObstacle - EPSILON
    ) {
      return false
    }
  }

  const sourceObstacle = connection.preparedConnection.sourceObstacle
  const requiredTraceToObstacle = rules.traceWidth / 2 + rules.clearance
  for (const segment of candidate.sourceSegments) {
    for (const obstacle of component.obstacles) {
      if (obstacle === sourceObstacle) continue
      if (!obstacle.layers.includes(segment.layer)) continue
      if (
        distanceSegmentToObstacle(segment, obstacle) <
        requiredTraceToObstacle - EPSILON
      ) {
        return false
      }
    }
    for (const obstacle of rules.blockingObstacles ?? []) {
      if (obstacle === sourceObstacle) continue
      if (!obstacle.layers.includes(segment.layer)) continue
      if (rules.obstacleCanBeIgnored?.(connectionIndex, obstacle)) continue
      if (
        distanceSegmentToObstacle(segment, obstacle) <
        requiredTraceToObstacle - EPSILON
      ) {
        return false
      }
    }
  }
  return true
}

function pathCandidateClearsBlockingSegments(params: {
  candidate: ViaPathCandidate
  rules: DogboneViaPathGeometryRules
}): boolean {
  const { candidate, rules } = params
  for (const blocker of rules.blockingSegments ?? []) {
    if (blocker.connectionIndex === candidate.connectionIndex) continue
    if (
      rules.canShareCopper?.(candidate.connectionIndex, blocker.connectionIndex)
    ) {
      continue
    }
    const requiredViaToTrace =
      rules.viaDiameter / 2 + blocker.segment.width / 2 + rules.clearance
    if (
      distancePointToSegment(
        candidate.point,
        blocker.segment.start,
        blocker.segment.end,
      ) <
      requiredViaToTrace - EPSILON
    ) {
      return false
    }
    for (const segment of candidate.sourceSegments) {
      if (
        segment.layer === blocker.segment.layer &&
        !segmentsAreClear(segment, blocker.segment, rules.clearance)
      ) {
        return false
      }
    }
  }
  return true
}

function createPathCandidate(params: {
  connection: ComponentConnection
  component: ComponentMatchingInput
  rules: DogboneViaPathGeometryRules
  path: readonly Point2D[]
  kind: ViaPathCandidate["kind"]
}): ViaPathCandidate | null {
  const { connection, component, rules, path, kind } = params
  const preparedConnection = connection.preparedConnection
  if (!pathStartsAtSource(path, preparedConnection)) return null
  if (
    connection.terminationType === "plane" &&
    !pathIsOctilinearWithoutRightAngleCorners(path)
  ) {
    return null
  }
  if (!pathIsInsideBounds(path, rules.planePathOptions?.bounds)) return null
  const copiedPath = copyPath(path)
  const candidate: ViaPathCandidate = {
    connectionIndex: preparedConnection.connectionIndex,
    point: { ...copiedPath.at(-1)! },
    path: copiedPath,
    sourceSegments: getPathSegments({
      path: copiedPath,
      width: rules.traceWidth,
      layer: preparedConnection.sourceLayer,
    }),
    kind,
  }
  if (candidate.sourceSegments.length === 0) return null
  if (
    !pathCandidateClearsBlockingSegments({ candidate, rules }) ||
    !pathCandidateClearsObstacles({
      candidate,
      connection,
      component,
      rules,
    })
  ) {
    return null
  }
  return candidate
}

function isInterstitialEndpoint(params: {
  source: Point2D
  point: Point2D
  pitchX: number
  pitchY: number
}): boolean {
  const { source, point, pitchX, pitchY } = params
  const isHalfPitchOffset = (displacement: number, pitch: number): boolean => {
    const halfPitchUnits = (displacement * 2) / pitch
    return (
      Math.abs(halfPitchUnits - Math.round(halfPitchUnits)) <= EPSILON &&
      Math.abs(Math.round(halfPitchUnits) % 2) === 1
    )
  }
  return (
    isHalfPitchOffset(point.x - source.x, pitchX) ||
    isHalfPitchOffset(point.y - source.y, pitchY)
  )
}

function getPlaneKnightPaths(params: {
  connection: ComponentConnection
  component: ComponentMatchingInput
}): Point2D[][] {
  const { connection, component } = params
  const source = {
    x: connection.preparedConnection.sourcePoint.x,
    y: connection.preparedConnection.sourcePoint.y,
  }
  const adjacentX = getAdjacentInterstitialCoordinates({
    sourceCoordinate: source.x,
    coordinates: component.xCoordinates,
    pitch: component.pitchX,
  })
  const adjacentY = getAdjacentInterstitialCoordinates({
    sourceCoordinate: source.y,
    coordinates: component.yCoordinates,
    pitch: component.pitchY,
  })
  return adjacentX.flatMap((x) =>
    adjacentY.flatMap((y) => {
      const signX = Math.sign(x - source.x)
      const signY = Math.sign(y - source.y)
      const adjacent = { x, y }
      return [
        [source, adjacent, { x: x + signX * component.pitchX, y }],
        [source, adjacent, { x, y: y + signY * component.pitchY }],
      ]
    }),
  )
}

function getPlaneChannelPaths(params: {
  connection: ComponentConnection
  component: ComponentMatchingInput
  maximumChannelRing: number
  bounds: PlaneDogbonePathOptions["bounds"]
}): Point2D[][] {
  const { connection, component, maximumChannelRing, bounds } = params
  const source = {
    x: connection.preparedConnection.sourcePoint.x,
    y: connection.preparedConnection.sourcePoint.y,
  }
  const step = Math.min(component.pitchX, component.pitchY) / 2
  if (!Number.isFinite(step) || step <= EPSILON) return []
  const directionVectors = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ] as const
  const advance = (
    point: Point2D,
    directionIndex: number,
    steps: number,
  ): Point2D => {
    const direction = directionVectors[(directionIndex + 8) % 8]!
    return {
      x: point.x + direction.x * step * steps,
      y: point.y + direction.y * step * steps,
    }
  }
  const paths: Point2D[][] = []
  const appendIfLegalEndpoint = (path: Point2D[]): void => {
    const endpoint = path.at(-1)!
    if (
      !isInterstitialEndpoint({
        source,
        point: endpoint,
        pitchX: component.pitchX,
        pitchY: component.pitchY,
      })
    ) {
      return
    }
    const ring = Math.ceil(
      Math.max(
        Math.abs(endpoint.x - source.x) / component.pitchX,
        Math.abs(endpoint.y - source.y) / component.pitchY,
      ) +
        0.5 -
        EPSILON,
    )
    if (ring < 2 || ring > maximumChannelRing) return
    if (!pathIsInsideBounds(path, bounds)) return
    paths.push(path)
  }
  const maximumFirstSteps = maximumChannelRing * 2
  const maximumLaterSteps = (maximumChannelRing + 1) * 2
  for (let firstDirection = 0; firstDirection < 8; firstDirection++) {
    for (let firstSteps = 1; firstSteps <= maximumFirstSteps; firstSteps++) {
      const firstEnd = advance(source, firstDirection, firstSteps)
      // A zero turn only splits a straight segment and cannot create new
      // geometry, so channel enumeration considers the two 45-degree turns.
      for (const secondTurn of [-1, 1]) {
        const secondDirection = firstDirection + secondTurn
        for (
          let secondSteps = 1;
          secondSteps <= maximumLaterSteps;
          secondSteps++
        ) {
          const secondEnd = advance(firstEnd, secondDirection, secondSteps)
          appendIfLegalEndpoint([source, firstEnd, secondEnd])
          for (const thirdTurn of [-1, 1]) {
            const thirdDirection = secondDirection + thirdTurn
            for (
              let thirdSteps = 1;
              thirdSteps <= maximumLaterSteps;
              thirdSteps++
            ) {
              appendIfLegalEndpoint([
                source,
                firstEnd,
                secondEnd,
                advance(secondEnd, thirdDirection, thirdSteps),
              ])
            }
          }
        }
      }
    }
  }
  return paths
}

function comparePathCandidates(params: {
  first: ViaPathCandidate
  second: ViaPathCandidate
  connection: ComponentConnection
  rules: DogboneViaPathGeometryRules
}): number {
  const { first, second, connection, rules } = params
  const connectionIndex = connection.preparedConnection.connectionIndex
  const preferredPath =
    rules.preferredViaPathsByConnectionIndex?.get(connectionIndex)?.path
  const preferredPoint =
    rules.preferredViaPointsByConnectionIndex?.get(connectionIndex) ??
    rules.preferredViaPathsByConnectionIndex?.get(connectionIndex)?.point
  const pathPreference = (candidate: ViaPathCandidate): number =>
    preferredPath &&
    dogbonePathKey(candidate.path) === dogbonePathKey(preferredPath)
      ? 0
      : 1
  const pointPreference = (candidate: ViaPathCandidate): number =>
    preferredPoint && distance(candidate.point, preferredPoint) <= EPSILON
      ? 0
      : 1
  const kindRank = (candidate: ViaPathCandidate): number =>
    candidate.kind === "direct" ? 0 : candidate.kind === "knight" ? 1 : 2
  return (
    pathPreference(first) - pathPreference(second) ||
    pointPreference(first) - pointPreference(second) ||
    first.sourceSegments.length - second.sourceSegments.length ||
    distance(connection.preparedConnection.sourcePoint, first.point) -
      distance(connection.preparedConnection.sourcePoint, second.point) ||
    kindRank(first) - kindRank(second) ||
    first.point.x - second.point.x ||
    first.point.y - second.point.y ||
    dogbonePathKey(first.path).localeCompare(dogbonePathKey(second.path))
  )
}

function getConnectionPathCandidates(params: {
  connection: ComponentConnection
  component: ComponentMatchingInput
  rules: DogboneViaPathGeometryRules
  channelRing?: number
  validatedOptions: ReturnType<typeof assertPlanePathOptions>
}): ViaPathCandidate[] {
  const { connection, component, rules, channelRing, validatedOptions } = params
  const connectionIndex = connection.preparedConnection.connectionIndex
  const fixedPath = rules.fixedViaPathsByConnectionIndex?.get(connectionIndex)
  if (fixedPath) {
    const candidate = createPathCandidate({
      connection,
      component,
      rules,
      path: fixedPath.path,
      kind: "direct",
    })
    if (!candidate || distance(candidate.point, fixedPath.point) > EPSILON) {
      return []
    }
    return [candidate]
  }

  const candidates: ViaPathCandidate[] = []
  const appendCandidate = (
    path: readonly Point2D[],
    kind: ViaPathCandidate["kind"],
  ): void => {
    const candidate = createPathCandidate({
      connection,
      component,
      rules,
      path,
      kind,
    })
    if (candidate) candidates.push(candidate)
  }
  for (const directCandidate of getConnectionCandidates({
    connection,
    component,
    rules,
  })) {
    appendCandidate(
      [directCandidate.sourceSegment.start, directCandidate.sourceSegment.end],
      "direct",
    )
  }

  const hasFixedPoint =
    rules.fixedViaPointsByConnectionIndex?.has(connectionIndex) ?? false
  if (connection.terminationType === "plane" && !hasFixedPoint) {
    for (const path of getPlaneKnightPaths({ connection, component })) {
      appendCandidate(path, "knight")
    }
  }

  const ordinaryCandidates = new Map<string, ViaPathCandidate>()
  for (const candidate of candidates) {
    ordinaryCandidates.set(dogbonePathKey(candidate.path), candidate)
  }
  const sortedOrdinary = [...ordinaryCandidates.values()].toSorted(
    (first, second) =>
      comparePathCandidates({ first, second, connection, rules }),
  )
  if (
    connection.terminationType !== "plane" ||
    hasFixedPoint ||
    channelRing === undefined
  ) {
    return sortedOrdinary
  }

  const uniqueChannelPaths = new Map<string, Point2D[]>()
  for (const path of getPlaneChannelPaths({
    connection,
    component,
    maximumChannelRing: channelRing,
    bounds: rules.planePathOptions?.bounds,
  })) {
    const key = dogbonePathKey(path)
    if (ordinaryCandidates.has(key)) continue
    uniqueChannelPaths.set(key, path)
  }
  const preferredPathKey = rules.preferredViaPathsByConnectionIndex?.get(
    connectionIndex,
  )?.path
    ? dogbonePathKey(
        rules.preferredViaPathsByConnectionIndex.get(connectionIndex)!.path,
      )
    : undefined
  const preferredPoint =
    rules.preferredViaPointsByConnectionIndex?.get(connectionIndex) ??
    rules.preferredViaPathsByConnectionIndex?.get(connectionIndex)?.point
  const sortedChannelPaths = [...uniqueChannelPaths].toSorted(
    ([firstKey, first], [secondKey, second]) => {
      const firstPoint = first.at(-1)!
      const secondPoint = second.at(-1)!
      return (
        (firstKey === preferredPathKey ? 0 : 1) -
          (secondKey === preferredPathKey ? 0 : 1) ||
        (preferredPoint && distance(firstPoint, preferredPoint) <= EPSILON
          ? 0
          : 1) -
          (preferredPoint && distance(secondPoint, preferredPoint) <= EPSILON
            ? 0
            : 1) ||
        first.length - second.length ||
        distance(connection.preparedConnection.sourcePoint, firstPoint) -
          distance(connection.preparedConnection.sourcePoint, secondPoint) ||
        firstPoint.x - secondPoint.x ||
        firstPoint.y - secondPoint.y ||
        firstKey.localeCompare(secondKey)
      )
    },
  )
  const selectedChannels: ViaPathCandidate[] = []
  const selectedChannelPathKeys = new Set<string>()
  const selectedTopologyKeysByEndpoint = new Map<string, Set<string>>()
  // Mutual clearance depends on the entire source path, not just its via
  // endpoint. Keep the nearest endpoint-diverse choices, while reserving a
  // bounded part of the domain for a second turn topology to those endpoints.
  // Otherwise the shortest path can hide the only relief path that clears a
  // neighboring dogbone even though both terminate at the same legal site.
  const primaryEndpointCount = Math.max(
    1,
    Math.ceil((validatedOptions.maximumChannelCandidatesPerConnection * 2) / 3),
  )
  const getTopologyKey = (path: readonly Point2D[]): string => {
    const directionSequence = path
      .slice(1)
      .map((point, index) => {
        const previous = path[index]!
        return `${Math.sign(point.x - previous.x)},${Math.sign(point.y - previous.y)}`
      })
      .join("|")
    const bendGeometry = path.slice(1, -1).map(pointKey).join(";")
    return `${directionSequence}@${bendGeometry}`
  }
  const appendSelectedChannel = (params: {
    pathKey: string
    path: Point2D[]
    endpoint: string
    topologyKey: string
  }): boolean => {
    const { pathKey, path, endpoint, topologyKey } = params
    const candidate = createPathCandidate({
      connection,
      component,
      rules,
      path,
      kind: "channel",
    })
    if (!candidate) return false
    selectedChannels.push(candidate)
    selectedChannelPathKeys.add(pathKey)
    const topologyKeys =
      selectedTopologyKeysByEndpoint.get(endpoint) ?? new Set<string>()
    topologyKeys.add(topologyKey)
    selectedTopologyKeysByEndpoint.set(endpoint, topologyKeys)
    return true
  }
  for (const [pathKey, path] of sortedChannelPaths) {
    const endpoint = pointKey(path.at(-1)!)
    const existingTopologyKeys = selectedTopologyKeysByEndpoint.get(endpoint)
    if (!existingTopologyKeys) {
      if (selectedTopologyKeysByEndpoint.size >= primaryEndpointCount) continue
    } else {
      const remainingPrimarySlots = Math.max(
        0,
        primaryEndpointCount - selectedTopologyKeysByEndpoint.size,
      )
      if (
        existingTopologyKeys.size >= 2 ||
        selectedChannels.length >=
          validatedOptions.maximumChannelCandidatesPerConnection -
            remainingPrimarySlots
      ) {
        continue
      }
    }
    const topologyKey = getTopologyKey(path)
    if (existingTopologyKeys?.has(topologyKey)) continue
    appendSelectedChannel({
      pathKey,
      path,
      endpoint,
      topologyKey,
    })
    if (
      selectedTopologyKeysByEndpoint.size >= primaryEndpointCount &&
      selectedChannels.length >=
        validatedOptions.maximumChannelCandidatesPerConnection
    ) {
      break
    }
  }
  // Topology diversity is only a reservation policy, not a reason to return a
  // short domain. If those reserved endpoints do not supply enough second
  // geometries, deterministically fill the unused cap with the next legal,
  // previously-unrepresented endpoints.
  if (
    selectedChannels.length <
    validatedOptions.maximumChannelCandidatesPerConnection
  ) {
    for (const [pathKey, path] of sortedChannelPaths) {
      if (selectedChannelPathKeys.has(pathKey)) continue
      const endpoint = pointKey(path.at(-1)!)
      if (selectedTopologyKeysByEndpoint.has(endpoint)) continue
      appendSelectedChannel({
        pathKey,
        path,
        endpoint,
        topologyKey: getTopologyKey(path),
      })
      if (
        selectedChannels.length >=
        validatedOptions.maximumChannelCandidatesPerConnection
      ) {
        break
      }
    }
  }
  return [...sortedOrdinary, ...selectedChannels]
}

function pathCandidatesAreMutuallyClear(params: {
  first: ViaPathCandidate
  second: ViaPathCandidate
  rules: DogboneViaPathGeometryRules
}): boolean {
  const { first, second, rules } = params
  const canShareCopper =
    rules.canShareCopper?.(first.connectionIndex, second.connectionIndex) ??
    false
  const requiredHoleSeparation = rules.viaHoleDiameter
    ? rules.viaHoleDiameter + (rules.holeToHoleClearance ?? rules.clearance)
    : 0
  const requiredViaSeparation = canShareCopper
    ? requiredHoleSeparation
    : Math.max(rules.viaDiameter + rules.clearance, requiredHoleSeparation)
  if (distance(first.point, second.point) < requiredViaSeparation - EPSILON) {
    return false
  }
  if (canShareCopper) return true

  const requiredViaToTrace =
    rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance
  for (const segment of second.sourceSegments) {
    if (
      distancePointToSegment(first.point, segment.start, segment.end) <
      requiredViaToTrace - EPSILON
    ) {
      return false
    }
  }
  for (const segment of first.sourceSegments) {
    if (
      distancePointToSegment(second.point, segment.start, segment.end) <
      requiredViaToTrace - EPSILON
    ) {
      return false
    }
  }
  for (const firstSegment of first.sourceSegments) {
    for (const secondSegment of second.sourceSegments) {
      if (!segmentsAreClear(firstSegment, secondSegment, rules.clearance)) {
        return false
      }
    }
  }
  return true
}

function matchPathCandidateAlternatives(params: {
  entries: readonly PathConnectionCandidates[]
  rules: DogboneViaPathGeometryRules
  maximumAlternatives: number
  consumeSearchState: () => boolean
  compatibilityCache?: PathCompatibilityCache
}): {
  alternatives: Map<number, ComponentDogboneViaPath>[]
  deadEnds: PathMatchingDeadEnd[]
  locallyExhausted: boolean
} {
  const {
    entries,
    rules,
    maximumAlternatives,
    consumeSearchState,
    compatibilityCache = new WeakMap<
      ViaPathCandidate,
      WeakMap<ViaPathCandidate, boolean>
    >(),
  } = params
  const deadEnds: PathMatchingDeadEnd[] = []
  let locallyExhausted = false
  for (const entry of entries) {
    if (entry.candidates.length === 0) {
      deadEnds.push({
        connectionIndex: entry.connection.preparedConnection.connectionIndex,
        blockingConnectionIndexes: [],
        assigned: [],
      })
    }
  }
  if (deadEnds.length > 0) {
    return { alternatives: [], deadEnds, locallyExhausted }
  }

  const assigned = new Map<number, ViaPathCandidate>()
  const remaining = new Set(
    entries.map((entry) => entry.connection.preparedConnection.connectionIndex),
  )
  const entryByConnectionIndex = new Map(
    entries.map((entry) => [
      entry.connection.preparedConnection.connectionIndex,
      entry,
    ]),
  )
  const alternatives: Map<number, ComponentDogboneViaPath>[] = []
  const compatible = (
    first: ViaPathCandidate,
    second: ViaPathCandidate,
  ): boolean => {
    const cached = compatibilityCache.get(first)?.get(second)
    if (cached !== undefined) return cached
    const result = pathCandidatesAreMutuallyClear({ first, second, rules })
    const firstCache =
      compatibilityCache.get(first) ?? new WeakMap<ViaPathCandidate, boolean>()
    firstCache.set(second, result)
    compatibilityCache.set(first, firstCache)
    const secondCache =
      compatibilityCache.get(second) ?? new WeakMap<ViaPathCandidate, boolean>()
    secondCache.set(first, result)
    compatibilityCache.set(second, secondCache)
    return result
  }
  const candidateDomains = new Map(
    entries.map(
      (entry) =>
        [
          entry.connection.preparedConnection.connectionIndex,
          [...entry.candidates],
        ] as const,
    ),
  )
  const connectionIndexes = [...candidateDomains.keys()].toSorted(
    (first, second) => first - second,
  )
  const pruningSourcesByConnectionIndex = new Map<number, Set<number>>()
  const arcQueue = connectionIndexes.flatMap((firstConnectionIndex) =>
    connectionIndexes.flatMap((secondConnectionIndex) =>
      firstConnectionIndex === secondConnectionIndex
        ? []
        : ([[firstConnectionIndex, secondConnectionIndex]] as const),
    ),
  )
  for (let arcIndex = 0; arcIndex < arcQueue.length; arcIndex++) {
    const [firstConnectionIndex, secondConnectionIndex] = arcQueue[arcIndex]!
    const firstDomain = candidateDomains.get(firstConnectionIndex)!
    const secondDomain = candidateDomains.get(secondConnectionIndex)!
    const supportedFirstDomain = firstDomain.filter((firstCandidate) =>
      secondDomain.some((secondCandidate) =>
        compatible(firstCandidate, secondCandidate),
      ),
    )
    if (supportedFirstDomain.length === firstDomain.length) continue
    candidateDomains.set(firstConnectionIndex, supportedFirstDomain)
    const pruningSources =
      pruningSourcesByConnectionIndex.get(firstConnectionIndex) ??
      new Set<number>()
    pruningSources.add(secondConnectionIndex)
    for (const transitiveSource of pruningSourcesByConnectionIndex.get(
      secondConnectionIndex,
    ) ?? []) {
      if (transitiveSource !== firstConnectionIndex) {
        pruningSources.add(transitiveSource)
      }
    }
    pruningSourcesByConnectionIndex.set(firstConnectionIndex, pruningSources)
    if (supportedFirstDomain.length === 0) {
      return {
        alternatives: [],
        deadEnds: [
          {
            connectionIndex: firstConnectionIndex,
            blockingConnectionIndexes: [...pruningSources].toSorted(
              (first, second) => first - second,
            ),
            assigned: [],
          },
        ],
        locallyExhausted,
      }
    }
    for (const neighborConnectionIndex of connectionIndexes) {
      if (
        neighborConnectionIndex === firstConnectionIndex ||
        neighborConnectionIndex === secondConnectionIndex
      ) {
        continue
      }
      arcQueue.push([neighborConnectionIndex, firstConnectionIndex])
    }
  }
  const getViableCandidates = (
    entry: PathConnectionCandidates,
    domains: ReadonlyMap<number, readonly ViaPathCandidate[]>,
  ): ViaPathCandidate[] => [
    ...domains.get(entry.connection.preparedConnection.connectionIndex)!,
  ]

  const recordDeadEnd = (
    entry: PathConnectionCandidates,
    domains: ReadonlyMap<number, readonly ViaPathCandidate[]>,
    blockingConnectionIndexes?: readonly number[],
  ): void => {
    if (deadEnds.length >= 64) return
    deadEnds.push({
      connectionIndex: entry.connection.preparedConnection.connectionIndex,
      blockingConnectionIndexes:
        blockingConnectionIndexes === undefined
          ? [
              ...new Set(
                (
                  domains.get(
                    entry.connection.preparedConnection.connectionIndex,
                  ) ??
                  candidateDomains.get(
                    entry.connection.preparedConnection.connectionIndex,
                  )!
                ).flatMap((candidate) =>
                  [...assigned].flatMap(
                    ([assignedConnectionIndex, assignedCandidate]) =>
                      compatible(candidate, assignedCandidate)
                        ? []
                        : [assignedConnectionIndex],
                  ),
                ),
              ),
            ].toSorted((first, second) => first - second)
          : [...new Set(blockingConnectionIndexes)].toSorted(
              (first, second) => first - second,
            ),
      assigned: [...assigned]
        .toSorted(([first], [second]) => first - second)
        .map(([connectionIndex, candidate]) => ({
          connectionIndex,
          point: { ...candidate.point },
        })),
    })
  }

  const propagateAssignment = (params: {
    domains: ReadonlyMap<number, readonly ViaPathCandidate[]>
    connectionIndex: number
    candidate: ViaPathCandidate
  }):
    | { domains: Map<number, readonly ViaPathCandidate[]>; deadEnd?: never }
    | {
        domains?: never
        deadEnd: {
          connectionIndex: number
          blockingConnectionIndexes: number[]
        }
      } => {
    const nextDomains = new Map(params.domains)
    nextDomains.set(params.connectionIndex, [params.candidate])
    const pruningSourcesByConnectionIndex = new Map<number, Set<number>>()
    const arcQueue = [...remaining].map(
      (otherConnectionIndex) =>
        [otherConnectionIndex, params.connectionIndex] as const,
    )
    for (let arcIndex = 0; arcIndex < arcQueue.length; arcIndex++) {
      const [firstConnectionIndex, secondConnectionIndex] = arcQueue[arcIndex]!
      const firstDomain = nextDomains.get(firstConnectionIndex)!
      const secondDomain = nextDomains.get(secondConnectionIndex)!
      const supportedFirstDomain = firstDomain.filter((firstCandidate) =>
        secondDomain.some((secondCandidate) =>
          compatible(firstCandidate, secondCandidate),
        ),
      )
      if (supportedFirstDomain.length === firstDomain.length) continue
      nextDomains.set(firstConnectionIndex, supportedFirstDomain)
      const pruningSources =
        pruningSourcesByConnectionIndex.get(firstConnectionIndex) ??
        new Set<number>()
      pruningSources.add(secondConnectionIndex)
      for (const transitiveSource of pruningSourcesByConnectionIndex.get(
        secondConnectionIndex,
      ) ?? []) {
        if (transitiveSource !== firstConnectionIndex) {
          pruningSources.add(transitiveSource)
        }
      }
      pruningSourcesByConnectionIndex.set(firstConnectionIndex, pruningSources)
      if (supportedFirstDomain.length === 0) {
        return {
          deadEnd: {
            connectionIndex: firstConnectionIndex,
            blockingConnectionIndexes: [...pruningSources],
          },
        }
      }
      for (const neighborConnectionIndex of remaining) {
        if (
          neighborConnectionIndex === firstConnectionIndex ||
          neighborConnectionIndex === secondConnectionIndex
        ) {
          continue
        }
        arcQueue.push([neighborConnectionIndex, firstConnectionIndex])
      }
    }
    return { domains: nextDomains }
  }

  const search = (
    domains: ReadonlyMap<number, readonly ViaPathCandidate[]>,
  ): boolean => {
    if (!consumeSearchState()) {
      locallyExhausted = true
      return true
    }
    if (remaining.size === 0) {
      alternatives.push(
        new Map(
          [...assigned]
            .toSorted(([first], [second]) => first - second)
            .map(([connectionIndex, candidate]) => [
              connectionIndex,
              { point: { ...candidate.point }, path: copyPath(candidate.path) },
            ]),
        ),
      )
      return alternatives.length >= maximumAlternatives
    }

    let selectedEntry: PathConnectionCandidates | undefined
    let selectedCandidates: ViaPathCandidate[] = []
    for (const connectionIndex of [...remaining].toSorted(
      (first, second) => first - second,
    )) {
      const entry = entryByConnectionIndex.get(connectionIndex)!
      const viableCandidates = getViableCandidates(entry, domains)
      if (viableCandidates.length === 0) {
        recordDeadEnd(entry, domains)
        return false
      }
      if (
        !selectedEntry ||
        viableCandidates.length < selectedCandidates.length ||
        (viableCandidates.length === selectedCandidates.length &&
          connectionIndex <
            selectedEntry.connection.preparedConnection.connectionIndex)
      ) {
        selectedEntry = entry
        selectedCandidates = viableCandidates
      }
    }

    const connectionIndex =
      selectedEntry!.connection.preparedConnection.connectionIndex
    remaining.delete(connectionIndex)
    // Preserve the mechanically simplest complete dogbone map. Expanded
    // channel paths are recovery geometry: try every legal single-segment
    // escape first, then use least-constraining-value ordering within the same
    // path complexity. Search backtracking still promotes a longer path when
    // the direct candidates cannot complete the global assignment.
    const orderedCandidates =
      selectedCandidates.length <= 1
        ? selectedCandidates
        : selectedCandidates
            .map((candidate, originalIndex) => {
              let eliminatedCandidateCount = 0
              for (const otherConnectionIndex of remaining) {
                const otherEntry =
                  entryByConnectionIndex.get(otherConnectionIndex)!
                for (const otherCandidate of getViableCandidates(
                  otherEntry,
                  domains,
                )) {
                  if (!compatible(candidate, otherCandidate)) {
                    eliminatedCandidateCount++
                  }
                }
              }
              return { candidate, originalIndex, eliminatedCandidateCount }
            })
            .toSorted(
              (first, second) =>
                first.candidate.sourceSegments.length -
                  second.candidate.sourceSegments.length ||
                first.eliminatedCandidateCount -
                  second.eliminatedCandidateCount ||
                first.originalIndex - second.originalIndex,
            )
            .map(({ candidate }) => candidate)
    for (const candidate of orderedCandidates) {
      assigned.set(connectionIndex, candidate)
      const propagation = propagateAssignment({
        domains,
        connectionIndex,
        candidate,
      })
      if (propagation.deadEnd) {
        recordDeadEnd(
          entryByConnectionIndex.get(propagation.deadEnd.connectionIndex)!,
          domains,
          propagation.deadEnd.blockingConnectionIndexes,
        )
      } else if (search(propagation.domains)) {
        assigned.delete(connectionIndex)
        remaining.add(connectionIndex)
        return true
      }
      assigned.delete(connectionIndex)
      if (locallyExhausted) break
    }
    remaining.add(connectionIndex)
    return false
  }

  search(candidateDomains)
  return { alternatives, deadEnds, locallyExhausted }
}

function createPathCandidateEntries(params: {
  componentInputs: readonly ComponentMatchingInput[]
  rules: DogboneViaPathGeometryRules
  channelRingByConnectionIndex: ReadonlyMap<number, number>
  validatedOptions: ReturnType<typeof assertPlanePathOptions>
  candidateCache?: Map<string, ViaPathCandidate[]>
}): PathConnectionCandidates[] {
  const {
    componentInputs,
    rules,
    channelRingByConnectionIndex,
    validatedOptions,
    candidateCache,
  } = params
  return componentInputs
    .flatMap((component) =>
      component.connections.map((connection) => {
        const connectionIndex = connection.preparedConnection.connectionIndex
        const channelRing = channelRingByConnectionIndex.get(connectionIndex)
        const cacheKey = `${connectionIndex}:${channelRing ?? 0}`
        let candidates = candidateCache?.get(cacheKey)
        if (!candidates) {
          candidates = getConnectionPathCandidates({
            connection,
            component,
            rules,
            channelRing,
            validatedOptions,
          })
          candidateCache?.set(cacheKey, candidates)
        }
        return { connection, candidates }
      }),
    )
    .toSorted(
      (first, second) =>
        first.connection.preparedConnection.connectionIndex -
        second.connection.preparedConnection.connectionIndex,
    )
}

/**
 * Matches source-layer dogbone paths and their through-via sites globally.
 *
 * Plane connections start with direct and deterministic second-ring candidates.
 * Unless an explicit channel set is supplied, bounded channel candidates are
 * added only for zero-domain and CSP dead-end conflict-frontier participants.
 */
export function matchComponentDogboneViaPathAlternatives(
  preparedBuses: readonly PreparedBus[],
  rules: DogboneViaPathGeometryRules,
  maximumAlternatives: number,
): Map<number, ComponentDogboneViaPath>[] {
  assertMaximumAlternatives(maximumAlternatives)
  const maximumSearchStates = assertGeometryRules(rules)
  const validatedOptions = assertPlanePathOptions(rules.planePathOptions ?? {})
  if (preparedBuses.length === 0) return [new Map()]

  const componentInputs = getComponentMatchingInputs(preparedBuses)
  const planeConnectionIndexes = new Set(
    componentInputs.flatMap((component) =>
      component.connections.flatMap((connection) =>
        connection.terminationType === "plane"
          ? [connection.preparedConnection.connectionIndex]
          : [],
      ),
    ),
  )
  const explicitChannelConnectionIndexes =
    rules.planePathOptions?.channelConnectionIndexes
  const channelRingByConnectionIndex = new Map(
    [...(explicitChannelConnectionIndexes ?? [])].map(
      (connectionIndex) =>
        [connectionIndex, validatedOptions.maximumChannelRing] as const,
    ),
  )
  const candidateCache = new Map<string, ViaPathCandidate[]>()
  const compatibilityCache: PathCompatibilityCache = new WeakMap()
  let consumedSearchStates = 0
  const consumeExpandedStateBudget = (): boolean => {
    if (rules.expandedStateBudget && rules.expandedStateBudget.remaining <= 0) {
      rules.expandedStateBudget.exhausted = true
      return false
    }
    if (rules.expandedStateBudget) {
      rules.expandedStateBudget.remaining--
      if (rules.expandedStateBudget.remaining <= 0) {
        rules.expandedStateBudget.exhausted = true
      }
    }
    return true
  }
  let entries = createPathCandidateEntries({
    componentInputs,
    rules,
    channelRingByConnectionIndex,
    validatedOptions,
    candidateCache,
  })
  if (!explicitChannelConnectionIndexes) {
    for (const entry of entries) {
      if (
        entry.connection.terminationType === "plane" &&
        entry.candidates.length === 0
      ) {
        channelRingByConnectionIndex.set(
          entry.connection.preparedConnection.connectionIndex,
          validatedOptions.initialChannelRing,
        )
      }
    }
    if (channelRingByConnectionIndex.size > 0) {
      entries = createPathCandidateEntries({
        componentInputs,
        rules,
        channelRingByConnectionIndex,
        validatedOptions,
        candidateCache,
      })
    }
  }

  for (
    let expansionRound = 0;
    expansionRound < validatedOptions.maximumExpansionRounds;
    expansionRound++
  ) {
    let localSearchStates = 0
    const localLimit = explicitChannelConnectionIndexes
      ? maximumSearchStates - consumedSearchStates
      : Math.min(
          validatedOptions.maximumDiagnosticSearchStates,
          maximumSearchStates - consumedSearchStates,
        )
    const result = matchPathCandidateAlternatives({
      entries,
      rules,
      maximumAlternatives,
      compatibilityCache,
      consumeSearchState: () => {
        if (!consumeExpandedStateBudget()) return false
        consumedSearchStates++
        localSearchStates++
        return (
          consumedSearchStates <= maximumSearchStates &&
          localSearchStates <= localLimit
        )
      },
    })
    if (result.alternatives.length > 0) {
      return result.alternatives
    }
    if (
      explicitChannelConnectionIndexes ||
      consumedSearchStates >= maximumSearchStates
    ) {
      break
    }
    if (result.locallyExhausted) {
      // A diagnostic timeout says nothing about which individual domain needs
      // more geometry. Give every plane drop the same bounded channel family
      // before spending the remaining caller budget on the final search. This
      // is especially important for large same-net power fields, where local
      // blocker frontiers are intentionally sparse because their copper may
      // merge, while several distant signal nets can still constrain the
      // assignment as a whole.
      for (const connectionIndex of planeConnectionIndexes) {
        if (!channelRingByConnectionIndex.has(connectionIndex)) {
          channelRingByConnectionIndex.set(
            connectionIndex,
            validatedOptions.initialChannelRing,
          )
        }
      }
      entries = createPathCandidateEntries({
        componentInputs,
        rules,
        channelRingByConnectionIndex,
        validatedOptions,
        candidateCache,
      })
      break
    }

    const frontier = new Set<number>()
    for (const deadEnd of result.deadEnds) {
      if (planeConnectionIndexes.has(deadEnd.connectionIndex)) {
        frontier.add(deadEnd.connectionIndex)
      }
      for (const connectionIndex of deadEnd.blockingConnectionIndexes) {
        if (planeConnectionIndexes.has(connectionIndex)) {
          frontier.add(connectionIndex)
        }
      }
    }
    let expandedConnection = false
    for (const connectionIndex of frontier) {
      const currentRing = channelRingByConnectionIndex.get(connectionIndex)
      if (currentRing === undefined) {
        channelRingByConnectionIndex.set(
          connectionIndex,
          validatedOptions.initialChannelRing,
        )
        expandedConnection = true
      } else if (currentRing < validatedOptions.maximumChannelRing) {
        channelRingByConnectionIndex.set(connectionIndex, currentRing + 1)
        expandedConnection = true
      }
    }
    if (!expandedConnection) {
      const fallbackEntry = entries
        .filter(
          (entry) =>
            entry.connection.terminationType === "plane" &&
            !channelRingByConnectionIndex.has(
              entry.connection.preparedConnection.connectionIndex,
            ),
        )
        .toSorted(
          (first, second) =>
            first.candidates.length - second.candidates.length ||
            first.connection.preparedConnection.connectionIndex -
              second.connection.preparedConnection.connectionIndex,
        )[0]
      if (!fallbackEntry) break
      channelRingByConnectionIndex.set(
        fallbackEntry.connection.preparedConnection.connectionIndex,
        validatedOptions.initialChannelRing,
      )
    }
    entries = createPathCandidateEntries({
      componentInputs,
      rules,
      channelRingByConnectionIndex,
      validatedOptions,
      candidateCache,
    })
  }

  // Diagnostic passes are deliberately cheap so an early, over-constrained
  // domain does not consume the whole search budget. Once expansion stops,
  // spend the remaining caller-provided budget on the final candidate set.
  if (
    !explicitChannelConnectionIndexes &&
    consumedSearchStates < maximumSearchStates
  ) {
    const finalResult = matchPathCandidateAlternatives({
      entries,
      rules,
      maximumAlternatives,
      compatibilityCache,
      consumeSearchState: () => {
        if (!consumeExpandedStateBudget()) return false
        consumedSearchStates++
        return consumedSearchStates <= maximumSearchStates
      },
    })
    if (finalResult.alternatives.length > 0) {
      return finalResult.alternatives
    }
  }

  return []
}

export function matchComponentDogboneViaPaths(
  preparedBuses: readonly PreparedBus[],
  rules: DogboneViaPathGeometryRules,
): Map<number, ComponentDogboneViaPath> | null {
  return (
    matchComponentDogboneViaPathAlternatives(preparedBuses, rules, 1)[0] ?? null
  )
}

/**
 * Enumerates legal path-aware candidates. Adaptive matching is not performed;
 * callers can explicitly select channel-expanded connections in path options.
 */
export function getComponentDogboneViaPathCandidates(
  preparedBuses: readonly PreparedBus[],
  rules: DogboneViaPathGeometryRules,
): ComponentDogboneViaPathCandidate[] {
  assertGeometryRules(rules)
  const validatedOptions = assertPlanePathOptions(rules.planePathOptions ?? {})
  const componentInputs = getComponentMatchingInputs(preparedBuses)
  const channelRingByConnectionIndex = new Map(
    [...(rules.planePathOptions?.channelConnectionIndexes ?? [])].map(
      (connectionIndex) =>
        [connectionIndex, validatedOptions.maximumChannelRing] as const,
    ),
  )
  return createPathCandidateEntries({
    componentInputs,
    rules,
    channelRingByConnectionIndex,
    validatedOptions,
  }).flatMap((entry) =>
    entry.candidates.map((candidate) => ({
      connectionIndex: candidate.connectionIndex,
      point: { ...candidate.point },
      path: copyPath(candidate.path),
    })),
  )
}

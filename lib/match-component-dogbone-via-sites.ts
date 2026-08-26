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
  /**
   * Optional bounded-search preference for boundary-bus dogbones. The sign
   * refers to the axis perpendicular to each bus's local escape direction.
   */
  preferredBoundaryPerpendicularSideByBusId?: ReadonlyMap<string, -1 | 1>
  /** Prefer the local outward or inward half-pitch row for a boundary bus. */
  preferBoundaryOutwardByBusId?: ReadonlyMap<string, boolean>
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

  const candidates: ViaSiteCandidate[] = []
  for (const point of uniquePoints) {
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

function matchComponent(params: {
  component: ComponentMatchingInput
  rules: DogboneViaSiteGeometryRules
  consumeSearchState: () => boolean
}): Map<number, Point2D> | null {
  const { component, rules, consumeSearchState } = params
  const entries: ConnectionCandidates[] = component.connections.map(
    (connection) => ({
      connection,
      candidates: getConnectionCandidates({ connection, component, rules }),
    }),
  )
  if (entries.some((entry) => entry.candidates.length === 0)) return null

  const assignedCandidates = new Map<number, ViaSiteCandidate>()
  const remaining = new Set(
    entries.map((entry) => entry.connection.preparedConnection.connectionIndex),
  )
  const entryByConnectionIndex = new Map(
    entries.map((entry) => [
      entry.connection.preparedConnection.connectionIndex,
      entry,
    ]),
  )

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

  const augmentMatching = (): boolean => {
    if (!consumeSearchState()) return false
    if (remaining.size === 0) return true

    let selectedEntry: ConnectionCandidates | undefined
    let selectedCandidates: ViaSiteCandidate[] = []
    for (const connectionIndex of [...remaining].toSorted(
      (first, second) => first - second,
    )) {
      const entry = entryByConnectionIndex.get(connectionIndex)!
      const viableCandidates = getViableCandidates(entry)
      if (viableCandidates.length === 0) return false
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
      if (augmentMatching()) return true
      assignedCandidates.delete(connectionIndex)
    }
    remaining.add(connectionIndex)
    return false
  }

  if (!augmentMatching()) return null
  return new Map(
    [...assignedCandidates.entries()]
      .toSorted(([first], [second]) => first - second)
      .map(([connectionIndex, candidate]) => [
        connectionIndex,
        { ...candidate.point },
      ]),
  )
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
  const maximumSearchStates = assertGeometryRules(rules)
  if (preparedBuses.length === 0) return new Map()

  let consumedSearchStates = 0
  const consumeSearchState = (): boolean => {
    consumedSearchStates++
    return consumedSearchStates <= maximumSearchStates
  }
  const result = new Map<number, Point2D>()
  for (const component of getComponentMatchingInputs(preparedBuses)) {
    const componentResult = matchComponent({
      component,
      rules,
      consumeSearchState,
    })
    if (!componentResult) return null
    for (const [connectionIndex, point] of componentResult) {
      result.set(connectionIndex, point)
    }
  }
  return result
}

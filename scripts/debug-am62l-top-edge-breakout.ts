import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getFanoutExitPositionConfig } from "../lib/fanout-exit-position"
import { FanoutSolver } from "../lib/fanout-solver"
import { getComponentDogboneViaSiteCandidates } from "../lib/match-component-dogbone-via-sites"
import type {
  FanoutBusSpec,
  FanoutDirection,
  FanoutRoutePlan,
  FanoutSolverOptions,
} from "../lib/types"
import capturedFixture from "../tests/fixtures/am62l-lpddr4-ram-above-soc-fanout.json"

type CapturedFixture = {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

type DebugSelection = {
  signalBusIds: string[]
  signalConnectionCount?: number
  signalConnectionCountsByBusId?: Record<string, number>
  signalConnectionIndices?: number[]
  signalLayer?: string
  signalLayersByBusId?: Record<string, string>
  signalDirection?: "up" | "right" | "down" | "left"
  signalDirectionsByBusId?: Record<string, "up" | "right" | "down" | "left">
  planeBusCount: number
  planeBusIndices?: number[]
  omittedPlaneBusIndices?: number[]
  maxLayerCombinations: number
  maxSteps?: number
  ignoreSkew: boolean
}

const fixture = capturedFixture as unknown as CapturedFixture

const getArgument = (name: string): string | undefined => {
  const prefix = `--${name}=`
  return Bun.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length)
}

const parsePositiveInteger = (name: string, fallback: number): number => {
  const rawValue = getArgument(name)
  if (rawValue === undefined) return fallback
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

const allBuses = fixture.options.buses ?? []
const allSignalBuses = allBuses.filter(
  (bus) => bus.termination?.type !== "plane",
)
const allPlaneBuses = allBuses.filter(
  (bus) => bus.termination?.type === "plane",
)

const requestedSignals = getArgument("signals")
const requestedSignalConnectionCount = getArgument("signal-connections")
const requestedSignalConnectionCounts = getArgument("signal-counts")
const requestedSignalIndices = getArgument("signal-indices")
const requestedPlaneIndices = getArgument("plane-indices")
const requestedOmittedPlaneIndices = getArgument("omit-plane-indices")
const requestedSignalDirection = getArgument("signal-direction")
const requestedSignalDirections = getArgument("signal-directions")
const requestedSignalLayers = getArgument("signal-layers")
const requestedSteps = getArgument("steps")
const requestedMergedBuses = getArgument("merge-buses")
const requestedSplitBus = getArgument("split-bus")
const requestedTargetShift = getArgument("shift-target")
const requestedAssignedLayers = getArgument("assigned-layers")
const requestedPlaneDirectionArgument = getArgument("plane-direction")
if (
  requestedPlaneDirectionArgument !== undefined &&
  !["up", "right", "down", "left"].includes(requestedPlaneDirectionArgument)
) {
  throw new Error("--plane-direction must be up, right, down, or left")
}
const requestedPlaneDirection = requestedPlaneDirectionArgument as
  | FanoutDirection
  | undefined
const [shiftedTargetBusId, rawTargetShiftX] =
  requestedTargetShift?.split(":") ?? []
const targetShiftX = rawTargetShiftX === undefined ? 0 : Number(rawTargetShiftX)
if (
  requestedTargetShift &&
  (!shiftedTargetBusId || !Number.isFinite(targetShiftX))
) {
  throw new Error("--shift-target must use BUS_ID:x_offset")
}
if (
  requestedSignalDirection !== undefined &&
  !["up", "right", "down", "left"].includes(requestedSignalDirection)
) {
  throw new Error("--signal-direction must be up, right, down, or left")
}
const selection: DebugSelection = {
  signalBusIds:
    requestedSignals === undefined || requestedSignals === "all"
      ? allSignalBuses.map((bus) => bus.busId)
      : requestedSignals === "none"
        ? []
        : requestedSignals.split(",").filter(Boolean),
  signalConnectionCount:
    requestedSignalConnectionCount === undefined
      ? undefined
      : parsePositiveInteger("signal-connections", 1),
  signalConnectionCountsByBusId:
    requestedSignalConnectionCounts === undefined
      ? undefined
      : Object.fromEntries(
          requestedSignalConnectionCounts.split(",").map((entry) => {
            const [busId, rawCount] = entry.split(":")
            const count = Number(rawCount)
            if (!busId || !Number.isInteger(count) || count <= 0) {
              throw new Error(
                "--signal-counts must use BUS_ID:positive_integer entries",
              )
            }
            return [busId, count]
          }),
        ),
  signalConnectionIndices:
    requestedSignalIndices === undefined
      ? undefined
      : requestedSignalIndices.split(",").map((rawIndex) => {
          const oneBasedIndex = Number(rawIndex)
          if (!Number.isInteger(oneBasedIndex) || oneBasedIndex <= 0) {
            throw new Error("--signal-indices must contain positive integers")
          }
          return oneBasedIndex - 1
        }),
  signalLayer: getArgument("signal-layer"),
  signalLayersByBusId:
    requestedSignalLayers === undefined
      ? undefined
      : Object.fromEntries(
          requestedSignalLayers.split(",").map((entry) => {
            const [busId, layer] = entry.split(":")
            if (!busId || !layer) {
              throw new Error("--signal-layers must use BUS_ID:layer entries")
            }
            return [busId, layer]
          }),
        ),
  signalDirection: requestedSignalDirection as
    | DebugSelection["signalDirection"]
    | undefined,
  signalDirectionsByBusId:
    requestedSignalDirections === undefined
      ? undefined
      : (Object.fromEntries(
          requestedSignalDirections.split(",").map((entry) => {
            const [busId, direction] = entry.split(":")
            if (
              !busId ||
              !direction ||
              !["up", "right", "down", "left"].includes(direction)
            ) {
              throw new Error(
                "--signal-directions must use BUS_ID:direction entries",
              )
            }
            return [busId, direction]
          }),
        ) as DebugSelection["signalDirectionsByBusId"]),
  planeBusCount:
    requestedPlaneIndices !== undefined
      ? requestedPlaneIndices.split(",").length
      : requestedOmittedPlaneIndices !== undefined
        ? allPlaneBuses.length - requestedOmittedPlaneIndices.split(",").length
        : getArgument("planes") === "none"
          ? 0
          : Math.min(
              parsePositiveInteger("planes", allPlaneBuses.length),
              allPlaneBuses.length,
            ),
  planeBusIndices:
    requestedPlaneIndices === undefined
      ? undefined
      : requestedPlaneIndices.split(",").map((rawIndex) => {
          const oneBasedIndex = Number(rawIndex)
          if (!Number.isInteger(oneBasedIndex) || oneBasedIndex <= 0) {
            throw new Error("--plane-indices must contain positive integers")
          }
          return oneBasedIndex - 1
        }),
  omittedPlaneBusIndices:
    requestedOmittedPlaneIndices === undefined
      ? undefined
      : requestedOmittedPlaneIndices.split(",").map((rawIndex) => {
          const oneBasedIndex = Number(rawIndex)
          if (!Number.isInteger(oneBasedIndex) || oneBasedIndex <= 0) {
            throw new Error(
              "--omit-plane-indices must contain positive integers",
            )
          }
          return oneBasedIndex - 1
        }),
  maxLayerCombinations: parsePositiveInteger("assignments", 1),
  maxSteps:
    requestedSteps === undefined
      ? undefined
      : requestedSteps === "0"
        ? 0
        : parsePositiveInteger("steps", 1),
  ignoreSkew: Bun.argv.includes("--ignore-skew"),
}

const knownSignalBusIds = new Set(allSignalBuses.map((bus) => bus.busId))
for (const busId of selection.signalBusIds) {
  if (!knownSignalBusIds.has(busId)) {
    throw new Error(`Unknown signal bus: ${busId}`)
  }
}

const selectedSignalBusIds = new Set(selection.signalBusIds)
const selectedPlaneBusIds = new Set(
  selection.planeBusIndices
    ? selection.planeBusIndices.flatMap((index) =>
        allPlaneBuses[index] ? [allPlaneBuses[index]!.busId] : [],
      )
    : selection.omittedPlaneBusIndices
      ? allPlaneBuses.flatMap((bus, index) =>
          selection.omittedPlaneBusIndices!.includes(index) ? [] : [bus.busId],
        )
      : allPlaneBuses.slice(0, selection.planeBusCount).map((bus) => bus.busId),
)
const selectedBuses = allBuses.filter(
  (bus) =>
    selectedSignalBusIds.has(bus.busId) || selectedPlaneBusIds.has(bus.busId),
)
const selectedConnectionNames = new Set(
  selectedBuses.flatMap((bus) => {
    if (bus.termination?.type === "plane") return bus.connectionNames
    if (selection.signalConnectionIndices) {
      return selection.signalConnectionIndices.flatMap((index) =>
        bus.connectionNames[index] ? [bus.connectionNames[index]] : [],
      )
    }
    const connectionCount =
      selection.signalConnectionCountsByBusId?.[bus.busId] ??
      selection.signalConnectionCount
    return connectionCount === undefined
      ? bus.connectionNames
      : bus.connectionNames.slice(0, connectionCount)
  }),
)

const filterBuses = (buses: readonly FanoutBusSpec[] | undefined) =>
  buses
    ?.filter((bus) =>
      selectedBuses.some((selectedBus) => selectedBus.busId === bus.busId),
    )
    .map((bus) => {
      const signalDirectionOverride =
        bus.termination?.type !== "plane" &&
        (selection.signalDirectionsByBusId?.[bus.busId] ??
          selection.signalDirection)
      const signalDirection =
        selection.signalDirectionsByBusId?.[bus.busId] ??
        selection.signalDirection
      const signalLayerOverride =
        selection.signalLayersByBusId?.[bus.busId] ?? selection.signalLayer
      const exitPositionConfig = bus.exitPosition
        ? getFanoutExitPositionConfig(bus.exitPosition)
        : undefined
      return {
        ...bus,
        ...(signalDirectionOverride
          ? {
              exitPosition: undefined,
              direction: signalDirection,
              preferredExit:
                bus.preferredExit ?? exitPositionConfig?.preferredExit,
              exitEdge: bus.exitEdge ?? exitPositionConfig?.exitEdge,
            }
          : {}),
        allowedLayers:
          bus.termination?.type !== "plane" && signalLayerOverride
            ? [signalLayerOverride]
            : bus.allowedLayers,
        maxLengthSkew: selection.ignoreSkew ? undefined : bus.maxLengthSkew,
        connectionNames: bus.connectionNames.filter((connectionName) =>
          selectedConnectionNames.has(connectionName),
        ),
        connectionExitTargets: bus.connectionExitTargets
          ? Object.fromEntries(
              Object.entries(bus.connectionExitTargets)
                .filter(([connectionName]) =>
                  selectedConnectionNames.has(connectionName),
                )
                .map(([connectionName, target]) => [
                  connectionName,
                  bus.busId === shiftedTargetBusId
                    ? { ...target, x: target.x + targetShiftX }
                    : target,
                ]),
            )
          : undefined,
      }
    })
    .filter((bus) => bus.connectionNames.length > 0)

const mergeSelectedBuses = (
  buses: FanoutBusSpec[] | undefined,
): FanoutBusSpec[] | undefined => {
  if (!buses || !requestedMergedBuses) return buses
  const [primaryBusId, secondaryBusId] = requestedMergedBuses.split(":")
  const primaryBus = buses.find((bus) => bus.busId === primaryBusId)
  const secondaryBus = buses.find((bus) => bus.busId === secondaryBusId)
  if (!primaryBus || !secondaryBus) {
    throw new Error("--merge-buses must name two selected buses")
  }
  const secondaryLayers = new Set(secondaryBus.allowedLayers ?? [])
  return buses
    .filter((bus) => bus.busId !== secondaryBusId)
    .map((bus) =>
      bus.busId === primaryBusId
        ? {
            ...primaryBus,
            connectionNames: [
              ...primaryBus.connectionNames,
              ...secondaryBus.connectionNames,
            ],
            connectionExitTargets: {
              ...primaryBus.connectionExitTargets,
              ...secondaryBus.connectionExitTargets,
            },
            allowedLayers: primaryBus.allowedLayers?.filter((layer) =>
              secondaryLayers.has(layer),
            ),
            maxLengthSkew: undefined,
          }
        : bus,
    )
}

const splitSelectedBus = (
  buses: FanoutBusSpec[] | undefined,
): FanoutBusSpec[] | undefined =>
  buses?.flatMap((bus) =>
    bus.busId === requestedSplitBus
      ? bus.connectionNames.map((connectionName, index) => ({
          ...bus,
          busId: `${bus.busId}:${index + 1}`,
          connectionNames: [connectionName],
          connectionExitTargets: bus.connectionExitTargets?.[connectionName]
            ? {
                [connectionName]: bus.connectionExitTargets[connectionName],
              }
            : undefined,
          maxLengthSkew: undefined,
        }))
      : [bus],
  )

const inputSrj = structuredClone(fixture.inputSrj)
if (Bun.argv.includes("--blind-vias")) {
  ;(
    inputSrj as SimpleRouteJson & { allowBlindAndBuriedVias?: boolean }
  ).allowBlindAndBuriedVias = true
}
if (!Bun.argv.includes("--keep-unselected-input-connections")) {
  inputSrj.connections = inputSrj.connections.filter((connection) =>
    selectedConnectionNames.has(connection.name),
  )
}
inputSrj.buses = splitSelectedBus(
  mergeSelectedBuses(filterBuses(inputSrj.buses)),
)
inputSrj.differentialPairs = selection.ignoreSkew
  ? []
  : inputSrj.differentialPairs?.filter((pair) =>
      pair.connectionNames.every((connectionName) =>
        selectedConnectionNames.has(connectionName),
      ),
    )

const options: FanoutSolverOptions = {
  ...structuredClone(fixture.options),
  buses: splitSelectedBus(
    mergeSelectedBuses(filterBuses(fixture.options.buses)),
  ),
  maxLayerCombinations: selection.maxLayerCombinations,
  allowBlindAndBuriedVias: Bun.argv.includes("--blind-vias")
    ? true
    : fixture.options.allowBlindAndBuriedVias,
  allowSameNetMerges: Bun.argv.includes("--same-net-merges")
    ? true
    : fixture.options.allowSameNetMerges,
  busDirections: requestedPlaneDirection
    ? {
        ...fixture.options.busDirections,
        ...Object.fromEntries(
          selectedBuses
            .filter((bus) => bus.termination?.type === "plane")
            .map((bus) => [bus.busId, requestedPlaneDirection]),
        ),
      }
    : fixture.options.busDirections,
}

const solver = new FanoutSolver(inputSrj, options)
const requestedCandidateBuses = getArgument("candidate-buses")
if (requestedAssignedLayers && solver.layerAssignments[0]) {
  Object.assign(
    solver.layerAssignments[0],
    Object.fromEntries(
      requestedAssignedLayers.split(",").map((entry) => {
        const [busId, layer] = entry.split(":")
        if (!busId || !layer) {
          throw new Error("--assigned-layers must use BUS_ID:layer entries")
        }
        return [busId, layer]
      }),
    ),
  )
}
const startedAt = performance.now()
if (selection.maxSteps === undefined) {
  solver.solve()
} else {
  for (
    let stepIndex = 0;
    stepIndex < selection.maxSteps && !solver.solved && !solver.failed;
    stepIndex++
  ) {
    solver.step()
  }
}
const elapsedMs = performance.now() - startedAt
const compact = Bun.argv.includes("--compact")
const requestedPlanBuses = getArgument("plan-buses")?.split(",")
const detailedBestAttempt = (
  solver as unknown as { bestAttempt?: { plans: FanoutRoutePlan[] } }
).bestAttempt
const bestAttempt = solver.attempts.reduce<
  (typeof solver.attempts)[number] | undefined
>(
  (best, attempt) =>
    !best || attempt.routedConnectionCount > best.routedConnectionCount
      ? attempt
      : best,
  undefined,
)

const report = {
  selection,
  selectedBusCount: selectedBuses.length,
  selectedConnectionCount: inputSrj.connections.length,
  solved: solver.solved,
  failed: solver.failed,
  iterations: solver.iterations,
  elapsedMs: Math.round(elapsedMs),
  stats: solver.stats,
  initialLayerAssignment: solver.layerAssignments[0],
  candidateSites: requestedCandidateBuses
    ? getComponentDogboneViaSiteCandidates(
        solver.preparedBuses.filter((bus) =>
          requestedCandidateBuses.split(",").includes(bus.busId),
        ),
        {
          viaDiameter: solver.config.viaDiameter,
          viaHoleDiameter: solver.config.viaHoleDiameter,
          traceWidth: solver.config.traceWidth,
          clearance: solver.config.clearance,
        },
      )
    : undefined,
  candidateCounts: Bun.argv.includes("--candidate-counts")
    ? Object.fromEntries(
        solver.preparedBuses.map((bus) => [
          bus.busId,
          getComponentDogboneViaSiteCandidates([bus], {
            viaDiameter: solver.config.viaDiameter,
            viaHoleDiameter: solver.config.viaHoleDiameter,
            traceWidth: solver.config.traceWidth,
            clearance: solver.config.clearance,
            additionalObstacles: inputSrj.obstacles,
          }).length,
        ]),
      )
    : undefined,
  planeDistanceRanking: Bun.argv.includes("--plane-distance-ranking")
    ? solver.preparedBuses
        .filter((bus) => bus.termination.type === "plane")
        .map((bus) => ({
          busId: bus.busId,
          minimumSignalDistance: Math.min(
            ...solver.preparedBuses
              .filter((candidate) => candidate.termination.type === "boundary")
              .flatMap((candidate) =>
                candidate.connections.map((connection) =>
                  Math.hypot(
                    connection.sourcePoint.x -
                      bus.connections[0]!.sourcePoint.x,
                    connection.sourcePoint.y -
                      bus.connections[0]!.sourcePoint.y,
                  ),
                ),
              ),
          ),
        }))
        .toSorted(
          (first, second) =>
            first.minimumSignalDistance - second.minimumSignalDistance,
        )
    : undefined,
  planeBoundaryCandidateConflicts: Bun.argv.includes(
    "--plane-boundary-candidate-conflicts",
  )
    ? (() => {
        const boundaryCandidates = getComponentDogboneViaSiteCandidates(
          solver.preparedBuses.filter(
            (bus) => bus.termination.type === "boundary",
          ),
          {
            viaDiameter: solver.config.viaDiameter,
            viaHoleDiameter: solver.config.viaHoleDiameter,
            traceWidth: solver.config.traceWidth,
            clearance: solver.config.clearance,
            additionalObstacles: inputSrj.obstacles,
          },
        )
        return solver.preparedBuses
          .filter((bus) => bus.termination.type === "plane")
          .map((bus) => {
            const planeCandidates = getComponentDogboneViaSiteCandidates(
              [bus],
              {
                viaDiameter: solver.config.viaDiameter,
                viaHoleDiameter: solver.config.viaHoleDiameter,
                traceWidth: solver.config.traceWidth,
                clearance: solver.config.clearance,
                additionalObstacles: inputSrj.obstacles,
              },
            )
            return {
              busId: bus.busId,
              conflictCount: planeCandidates.reduce(
                (count, planeCandidate) =>
                  count +
                  boundaryCandidates.filter(
                    (boundaryCandidate) =>
                      Math.hypot(
                        planeCandidate.point.x - boundaryCandidate.point.x,
                        planeCandidate.point.y - boundaryCandidate.point.y,
                      ) <
                      solver.config.viaDiameter + solver.config.clearance,
                  ).length,
                0,
              ),
            }
          })
          .filter((entry) => entry.conflictCount > 0)
          .toSorted(
            (first, second) => second.conflictCount - first.conflictCount,
          )
      })()
    : undefined,
  geometry: Bun.argv.includes("--geometry")
    ? solver.preparedBuses
        .filter((bus) => bus.termination.type === "boundary")
        .map((bus) => ({
          busId: bus.busId,
          direction: bus.direction,
          exitEdge: bus.exitEdge,
          preferredExit: bus.preferredExit,
          sourcePoints: bus.connections.map(
            (connection) => connection.sourcePoint,
          ),
          exitTargets: bus.connections.map(
            (connection) =>
              connection.exitTargetPoint ?? connection.targetPoint,
          ),
        }))
    : undefined,
  bestAttempt:
    compact && bestAttempt
      ? {
          busLayerAssignments: bestAttempt.busLayerAssignments,
          routedBusCount: bestAttempt.routedBusCount,
          routedConnectionCount: bestAttempt.routedConnectionCount,
          failedBusIds: bestAttempt.failedBusIds,
          score: bestAttempt.score,
        }
      : bestAttempt,
  error: solver.error,
  planSummary: Bun.argv.includes("--plan-summary")
    ? detailedBestAttempt?.plans
        .filter(
          (plan) =>
            !requestedPlanBuses || requestedPlanBuses.includes(plan.busId),
        )
        .map((plan) => ({
          busId: plan.busId,
          connectionName: plan.connectionName,
          sourcePoint: plan.sourcePoint,
          via: plan.via?.center,
          planeEndpointVia: plan.planeEndpointVia?.center,
          segments: plan.segments.map((segment) => ({
            start: segment.start,
            end: segment.end,
            layer: segment.layer,
          })),
        }))
    : undefined,
}

console.log(
  JSON.stringify(
    Bun.argv.includes("--summary")
      ? {
          selectedBusCount: report.selectedBusCount,
          selectedConnectionCount: report.selectedConnectionCount,
          solved: report.solved,
          failed: report.failed,
          elapsedMs: report.elapsedMs,
          routedBusCount: bestAttempt?.routedBusCount ?? 0,
          routedConnectionCount: bestAttempt?.routedConnectionCount ?? 0,
          failedBusCount: bestAttempt?.failedBusIds.length ?? 0,
          error: report.error,
          planSummary: report.planSummary,
          candidateCounts: report.candidateCounts,
          planeDistanceRanking: report.planeDistanceRanking,
          planeBoundaryCandidateConflicts:
            report.planeBoundaryCandidateConflicts,
        }
      : report,
    null,
    2,
  ),
)

import type { FanoutSolver } from "../lib/fanout-solver"
import type { FanoutDatasetSample } from "./dataset-types"
import capturedSample from "./fixtures/fanout31-am62l-left-center.json"

const fixture = capturedSample as unknown as {
  generatedFrom: typeof capturedSample.generatedFrom
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

export const am62lRamLeftProvenance = fixture.generatedFrom

/** Exact upstream sample, including every plane drop and timing constraint. */
export const createAm62lRamLeftInput = () => ({
  simpleRouteJson: structuredClone(fixture.simpleRouteJson),
  solverOptions: structuredClone(fixture.solverOptions),
})

/** Reduce only connectivity for diagnosis; keep all 573 physical obstacles. */
export const createAm62lRamLeftSubset = ({
  busIds,
  connectionLimit,
}: {
  busIds?: readonly string[]
  connectionLimit?: number
}) => {
  const input = createAm62lRamLeftInput()
  const { simpleRouteJson, solverOptions } = input
  if (busIds) {
    const selectedIds = new Set(busIds)
    const knownIds = new Set(solverOptions.buses?.map((bus) => bus.busId))
    for (const busId of selectedIds) {
      if (busId !== "planes" && !knownIds.has(busId)) {
        throw new Error(`Unknown bus: ${busId}`)
      }
    }
    const selectedBuses = solverOptions.buses?.filter(
      (bus) =>
        selectedIds.has(bus.busId) ||
        (selectedIds.has("planes") && bus.termination?.type === "plane"),
    )
    const selectedNames = new Set(
      selectedBuses?.flatMap((bus) => bus.connectionNames),
    )
    simpleRouteJson.connections = simpleRouteJson.connections.filter(
      (connection) => selectedNames.has(connection.name),
    )
  }
  if (connectionLimit !== undefined) {
    if (!Number.isInteger(connectionLimit) || connectionLimit < 1) {
      throw new Error("connectionLimit must be a positive integer")
    }
    simpleRouteJson.connections = simpleRouteJson.connections.slice(
      0,
      connectionLimit,
    )
  }
  const retainedNames = new Set(
    simpleRouteJson.connections.map((connection) => connection.name),
  )
  solverOptions.buses = solverOptions.buses
    ?.map((bus) => ({
      ...bus,
      connectionNames: bus.connectionNames.filter((name) =>
        retainedNames.has(name),
      ),
      connectionExitTargets:
        bus.connectionExitTargets &&
        Object.fromEntries(
          Object.entries(bus.connectionExitTargets).filter(([name]) =>
            retainedNames.has(name),
          ),
        ),
    }))
    .filter((bus) => bus.connectionNames.length > 0)
  simpleRouteJson.buses = simpleRouteJson.buses
    ?.map((bus) => ({
      ...bus,
      connectionNames: bus.connectionNames.filter((name) =>
        retainedNames.has(name),
      ),
    }))
    .filter((bus) => bus.connectionNames.length > 0)
  simpleRouteJson.differentialPairs = simpleRouteJson.differentialPairs?.filter(
    (pair) => pair.connectionNames.every((name) => retainedNames.has(name)),
  )
  return input
}

export const fanoutDataset08: FanoutDatasetSample[] = [
  {
    id: "11-left-center",
    name: "AM62L · RAM left",
    description:
      "Unmodified dataset-fanout31 sample 11: 135 AM62L connections, nine DDR buses, 102 plane drops, and the LPDDR4 footprint 17 mm to the left. Includes differential-pair and length-skew constraints.",
    footprintCount: 2,
    footprinterStrings: ["AM62L FCCSP373", "LPDDR4 FBGA200"],
    ...createAm62lRamLeftInput(),
    componentBounds: {},
    sharedBoundary: fixture.solverOptions.sharedBoundary!,
  },
]

import { expect, test } from "bun:test"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { createIcepiBoundaryContact } from "./fixtures/icepi-boundary-contact"

test("boundary contact preserves explicit exits and ambiguous-target inference", (): void => {
  const { srj, solverOptions } = createIcepiBoundaryContact()
  const connection = srj.connections[0]
  const busId = `connection:${connection.name}`
  expect(prepareFanoutBuses(srj, solverOptions)[0].direction).toBe("down")
  for (const options of [
    { ...solverOptions, busDirections: { [busId]: "left" as const } },
    { ...solverOptions, defaultDirection: "left" as const },
    { ...solverOptions, defaultPreferredExit: "left" as const },
    { ...solverOptions, busExitPreferences: { [busId]: "left" as const } },
    {
      ...solverOptions,
      availableCornersAndSides: ["left_middle" as const],
    },
    {
      ...solverOptions,
      buses: [
        {
          busId,
          connectionNames: [connection.name],
          direction: "left" as const,
        },
      ],
    },
    {
      ...solverOptions,
      buses: [
        {
          busId,
          connectionNames: [connection.name],
          exitPosition: "leftside_center" as const,
        },
      ],
    },
  ]) {
    expect(prepareFanoutBuses(srj, options)[0].direction).toBe("left")
  }
  const target = connection.pointsToConnect[1]
  for (const point of [
    { ...target, y: 11 },
    { ...target, x: srj.bounds.minX + 0.0001 },
    { ...target, y: srj.bounds.minY - 0.0001 },
  ]) {
    const originalInference = {
      ...srj,
      connections: [
        {
          ...connection,
          pointsToConnect: [connection.pointsToConnect[0], point],
        },
      ],
    }
    expect(
      prepareFanoutBuses(originalInference, solverOptions)[0].direction,
    ).toBe("left")
  }
  const planeOptions = {
    ...solverOptions,
    buses: [
      {
        busId,
        connectionNames: [connection.name],
        termination: { type: "plane" as const, layer: "inner2" },
      },
    ],
  }
  expect(prepareFanoutBuses(srj, planeOptions)[0].direction).toBe("left")
})

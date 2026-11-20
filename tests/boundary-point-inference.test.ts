import { expect, test } from "bun:test"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { createIcepiBoundaryContact } from "./fixtures/icepi-boundary-contact"

test("boundary point inference preserves widths, corners and explicit guidance", (): void => {
  const { srj, solverOptions } = createIcepiBoundaryContact()
  const connection = srj.connections[0]
  const target = connection.pointsToConnect[1]
  const cases = [
    { point: target, direction: "down" },
    { point: { ...target, y: srj.bounds.minY }, direction: "down" },
    { point: { ...target, y: srj.bounds.minY + 0.06 }, direction: "left" },
    { point: { ...target, x: srj.bounds.minX + 0.0001 }, direction: "left" },
    { point: { ...target, y: srj.bounds.minY - 0.0001 }, direction: "left" },
  ] as const
  for (const traceWidth of [0.1, 0.15, 0.5]) {
    for (const { point, direction } of cases) {
      const input = {
        ...srj,
        connections: [
          {
            ...connection,
            pointsToConnect: [connection.pointsToConnect[0], point],
          },
        ],
      }
      expect(
        prepareFanoutBuses(input, { ...solverOptions, traceWidth })[0]
          .direction,
      ).toBe(direction)
    }
  }
  for (const options of [
    { ...solverOptions, defaultDirection: "left" as const },
    { ...solverOptions, defaultPreferredExit: "left" as const },
    { ...solverOptions, availableCornersAndSides: ["left_middle" as const] },
    {
      ...solverOptions,
      buses: [
        {
          busId: "plane",
          connectionNames: [connection.name],
          termination: { type: "plane" as const, layer: "inner2" },
        },
      ],
    },
  ]) {
    expect(prepareFanoutBuses(srj, options)[0].direction).toBe("left")
  }
})

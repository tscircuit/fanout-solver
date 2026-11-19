import { expect, test } from "bun:test"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { createIcepiBoundaryContact } from "./fixtures/icepi-boundary-contact"

test("boundary point inference uses coordinate tolerance across trace widths", (): void => {
  const { srj, solverOptions } = createIcepiBoundaryContact()
  const connection = srj.connections[0]
  const target = connection.pointsToConnect[1]
  const cases = [
    { point: { ...target, y: srj.bounds.minY }, direction: "down" },
    { point: { ...target, y: srj.bounds.minY + 0.0001 }, direction: "down" },
    {
      point: { ...target, y: srj.bounds.minY + 0.0001000005 },
      direction: "down",
    },
    {
      point: { ...target, y: srj.bounds.minY + 0.000100002 },
      direction: "left",
    },
    { point: { ...target, y: srj.bounds.minY + 0.06 }, direction: "left" },
    {
      point: { ...target, x: srj.bounds.minX + 0.04 },
      direction: "down",
    },
    {
      point: { ...target, x: srj.bounds.minX + 0.0001 },
      direction: "left",
    },
    {
      point: { ...target, y: srj.bounds.minY - 0.0000005 },
      direction: "down",
    },
    {
      point: { ...target, y: srj.bounds.minY - 0.000002 },
      direction: "left",
    },
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
})

import { expect, test } from "bun:test"
import {
  getDenseBoundaryRoutingMode,
  shouldUseJointBoundaryViaReservation,
} from "../lib/dense-boundary-routing-policy"

test("selects joint boundary routing only within bounded dense groups", () => {
  expect(shouldUseJointBoundaryViaReservation([8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 8, 8])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9, 2])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1, 1])).toBe(
    true,
  )
  expect(
    shouldUseJointBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1, 1, 1]),
  ).toBe(true)
  const largeBoundaryBusConnectionCounts = [8, 8, 8, 2, 2, 2, 1, 1, 1, 1]
  expect(
    shouldUseJointBoundaryViaReservation(largeBoundaryBusConnectionCounts),
  ).toBe(true)
  expect(
    getDenseBoundaryRoutingMode({
      boundaryBusConnectionCounts: largeBoundaryBusConnectionCounts,
      planeBusCount: 0,
    }),
  ).toBe("large_boundary_only")
  expect(shouldUseJointBoundaryViaReservation(Array(40).fill(1))).toBe(true)
  expect(shouldUseJointBoundaryViaReservation(Array(41).fill(1))).toBe(false)
  expect(shouldUseJointBoundaryViaReservation(Array(9).fill(8))).toBe(false)
  expect(
    getDenseBoundaryRoutingMode({
      boundaryBusConnectionCounts: Array(41).fill(1),
      planeBusCount: 0,
    }),
  ).toBeNull()
})

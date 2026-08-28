import { expect, test } from "bun:test"
import {
  shouldDeferSingletonBoundaryViaReservation,
  shouldSearchAdditionalBoundaryRouteTopologies,
  shouldUseJointBoundaryViaReservation,
} from "../lib/fanout-solver"

test("uses joint boundary via reservation only for heterogeneous four-bus and every five-bus group", () => {
  expect(shouldUseJointBoundaryViaReservation([8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 8, 8])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9, 2])).toBe(false)
})

test("defers exactly one singleton dogbone only in the five-bus path", () => {
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2])).toBe(false)
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 1])).toBe(true)
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 1, 1])).toBe(
    false,
  )
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2])).toBe(
    false,
  )
})

test("keeps eager topology diversity out of the bounded five-bus path", () => {
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 4,
      rawSkew: 10.25,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 4,
      rawSkew: 9.9,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 5,
      rawSkew: 100,
      maximumSkew: 8,
    }),
  ).toBe(false)
})

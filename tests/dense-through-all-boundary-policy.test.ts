import { expect, test } from "bun:test"
import {
  shouldDeferSingletonBoundaryViaReservation,
  shouldSearchAdditionalBoundaryRouteTopologies,
  shouldUseJointBoundaryViaReservation,
} from "../lib/fanout-solver"

test("uses joint boundary via reservation for bounded dense groups through six buses", () => {
  expect(shouldUseJointBoundaryViaReservation([8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 8])).toBe(false)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 8, 8, 8, 8])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9, 2])).toBe(true)
  expect(shouldUseJointBoundaryViaReservation([8, 9, 8, 2, 9, 2, 1])).toBe(
    false,
  )
})

test("defers exactly one singleton dogbone in the five- and six-bus paths", () => {
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2])).toBe(false)
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 1])).toBe(true)
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 1, 1])).toBe(
    false,
  )
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2])).toBe(
    false,
  )
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 1])).toBe(
    true,
  )
  expect(shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 1, 1])).toBe(
    false,
  )
})

test("keeps topology diversity bounded in dense five- and six-bus paths", () => {
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 4,
      connectionCount: 8,
      rawSkew: 10.25,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 4,
      connectionCount: 8,
      rawSkew: 9.9,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 5,
      connectionCount: 8,
      rawSkew: 100,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 6,
      connectionCount: 8,
      rawSkew: 15.2,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 6,
      connectionCount: 8,
      rawSkew: 11.9,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 6,
      connectionCount: 2,
      rawSkew: 2.2,
      maximumSkew: 0.25,
    }),
  ).toBe(false)
})

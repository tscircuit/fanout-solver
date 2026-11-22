import { expect, test } from "bun:test"
import {
  getDenseLeadingCornerBandTargetTrackOffset,
  getDenseSingletonDeferralCandidateCount,
  isDenseSingletonEmbeddedInMultiLayerWideBus,
  shouldDeferSingletonBoundaryViaReservation,
  shouldSearchAdditionalBoundaryRouteTopologies,
  shouldUseJointBoundaryViaReservation,
} from "../lib/fanout-solver"

test("uses joint boundary via reservation for bounded dense groups through nine buses", () => {
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
  expect(
    shouldUseJointBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1, 1, 1, 1]),
  ).toBe(false)
})

test("defers bounded singleton dogbones without changing the five- through seven-bus policy", () => {
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
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1]),
  ).toBe(true)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 2]),
  ).toBe(false)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 1, 1]),
  ).toBe(false)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 2, 1]),
  ).toBe(true)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1, 1]),
  ).toBe(true)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 1, 1, 1]),
  ).toBe(false)
  expect(getDenseSingletonDeferralCandidateCount([8, 8, 8, 2, 2, 2, 1])).toBe(1)
  expect(
    getDenseSingletonDeferralCandidateCount([8, 8, 8, 2, 2, 2, 1, 1]),
  ).toBe(1)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 2, 2, 1]),
  ).toBe(true)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 2, 1, 1]),
  ).toBe(true)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 2, 1, 1, 1]),
  ).toBe(true)
  expect(
    shouldDeferSingletonBoundaryViaReservation([8, 8, 8, 2, 2, 1, 1, 1, 1]),
  ).toBe(false)
  expect(
    getDenseSingletonDeferralCandidateCount([8, 8, 8, 2, 2, 2, 1, 1, 1]),
  ).toBe(2)
  expect(
    getDenseSingletonDeferralCandidateCount([8, 8, 8, 2, 2, 1, 1, 1, 1]),
  ).toBe(0)
})

test("promotes an embedded singleton ahead of its multi-layer wide bus", () => {
  const singletonBus = {
    componentId: "component-1",
    exitEdge: "right" as const,
    connections: [{ sourcePoint: { x: 0.5, y: 0.5 } }],
  }
  const wideBus = {
    componentId: "component-1",
    exitEdge: "right" as const,
    allowedLayers: ["inner5", "bottom"],
    connections: Array.from({ length: 8 }, (_, index) => ({
      sourcePoint: { x: index % 4, y: Math.floor(index / 4) },
    })),
  }
  expect(
    isDenseSingletonEmbeddedInMultiLayerWideBus({
      singletonBus,
      singletonTargetLayer: "inner5",
      wideBuses: [wideBus],
    }),
  ).toBe(true)
  expect(
    isDenseSingletonEmbeddedInMultiLayerWideBus({
      singletonBus,
      singletonTargetLayer: "inner6",
      wideBuses: [wideBus],
    }),
  ).toBe(false)
  expect(
    isDenseSingletonEmbeddedInMultiLayerWideBus({
      singletonBus: {
        ...singletonBus,
        connections: [{ sourcePoint: { x: 4, y: 0.5 } }],
      },
      singletonTargetLayer: "inner5",
      wideBuses: [wideBus],
    }),
  ).toBe(false)
  expect(
    isDenseSingletonEmbeddedInMultiLayerWideBus({
      singletonBus,
      singletonTargetLayer: "inner5",
      wideBuses: [
        { ...wideBus, componentId: "other-component" },
        { ...wideBus, exitEdge: "left" },
        { ...wideBus, allowedLayers: ["inner5"] },
      ],
    }),
  ).toBe(false)
})

test("prepends dense corner lanes without moving the established lane grid", () => {
  expect(
    getDenseLeadingCornerBandTargetTrackOffset({
      leadingLaneCount: 0,
      traceWidth: 0.1,
      viaDiameter: 0.3,
      clearance: 0.1,
    }),
  ).toBe(-0)
  expect(
    getDenseLeadingCornerBandTargetTrackOffset({
      leadingLaneCount: 1,
      traceWidth: 0.1,
      viaDiameter: 0.3,
      clearance: 0.1,
    }),
  ).toBeCloseTo(-0.2, 12)
})

test("keeps topology diversity bounded in dense five- through nine-bus paths", () => {
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
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 7,
      connectionCount: 8,
      rawSkew: 15.2,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 7,
      connectionCount: 8,
      rawSkew: 11.9,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 7,
      connectionCount: 2,
      rawSkew: 2.2,
      maximumSkew: 0.25,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 8,
      connectionCount: 8,
      rawSkew: 15.2,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 8,
      connectionCount: 8,
      rawSkew: 11.9,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 8,
      connectionCount: 2,
      rawSkew: 2.2,
      maximumSkew: 0.25,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 9,
      connectionCount: 8,
      rawSkew: 15.2,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 9,
      connectionCount: 8,
      rawSkew: 11.9,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 9,
      connectionCount: 2,
      rawSkew: 2.2,
      maximumSkew: 0.25,
    }),
  ).toBe(false)
  expect(
    shouldSearchAdditionalBoundaryRouteTopologies({
      boundaryBusCount: 10,
      connectionCount: 8,
      rawSkew: 100,
      maximumSkew: 8,
    }),
  ).toBe(false)
})

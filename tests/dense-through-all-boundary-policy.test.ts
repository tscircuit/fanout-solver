import { expect, test } from "bun:test"
import {
  getDenseFixedMapSearchPolicy,
  getDenseLeadingCornerBandTargetTrackOffset,
  getDenseSingletonDeferralCandidateCount,
  isDenseSingletonEmbeddedInMultiLayerWideBus,
  matchDenseDogboneCompletionDirectFirst,
  runLegacyFirstDenseRootProbe,
  runReleasedDenseAdaptivePreflightIfEligible,
  shouldDeferSingletonBoundaryViaReservation,
  shouldSearchAdditionalBoundaryRouteTopologies,
  shouldSearchReleasedDenseBoundaryRouteTopologies,
  shouldUseJointBoundaryViaReservation,
  shouldUseReleasedDenseAdaptivePreflight,
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

test("reserves expanded plane dogbone paths only for the complete nine-bus field", () => {
  const legacyPolicy = {
    useExpandedStateSearch: false,
    useFixedViaWindingOnly: false,
    useGloballyPackedCornerBandLanes: false,
    usePathAwareJointPlaneReservation: false,
    usePlaneCapacityReplay: false,
  }
  for (const boundaryBusCount of [3, 4, 5, 6, 7, 8]) {
    expect(
      getDenseFixedMapSearchPolicy({
        boundaryBusCount,
        planeBusCount: 102,
      }),
    ).toEqual(legacyPolicy)
  }
  expect(
    getDenseFixedMapSearchPolicy({
      boundaryBusCount: 9,
      planeBusCount: 0,
    }),
  ).toEqual(legacyPolicy)
  expect(
    getDenseFixedMapSearchPolicy({
      boundaryBusCount: 9,
      planeBusCount: 102,
    }),
  ).toEqual({
    useExpandedStateSearch: true,
    useFixedViaWindingOnly: true,
    useGloballyPackedCornerBandLanes: true,
    usePathAwareJointPlaneReservation: true,
    usePlaneCapacityReplay: true,
  })
})

test("runs the released adaptive preflight only for a full through-all dense field", () => {
  const boundaryBuses = Array.from({ length: 9 }, (_, index) => ({
    busId: `bus-${index}`,
    connections: [{ sourceLayer: index % 2 === 0 ? "top" : "bottom" }],
  }))
  const throughAllAssignments = Object.fromEntries(
    boundaryBuses.map((bus) => [
      bus.busId,
      bus.connections[0]!.sourceLayer === "top" ? "inner4" : "inner5",
    ]),
  )
  const isEligible = (params: {
    buses?: typeof boundaryBuses
    planeBusCount?: number
    assignments?: Readonly<Record<string, string>>
  }) =>
    shouldUseReleasedDenseAdaptivePreflight({
      boundaryBuses: params.buses ?? boundaryBuses,
      planeBusCount: params.planeBusCount ?? 8,
      busLayerAssignments: params.assignments ?? throughAllAssignments,
    })

  expect(isEligible({})).toBe(true)
  expect(isEligible({ planeBusCount: 0 })).toBe(true)
  expect(isEligible({ planeBusCount: 9 })).toBe(true)
  expect(isEligible({ buses: boundaryBuses.slice(0, 8) })).toBe(false)
  expect(
    isEligible({
      buses: [
        ...boundaryBuses,
        { busId: "bus-9", connections: [{ sourceLayer: "top" }] },
      ],
    }),
  ).toBe(false)
  expect(isEligible({ planeBusCount: 7 })).toBe(false)
  expect(
    isEligible({
      assignments: {
        ...throughAllAssignments,
        [boundaryBuses[4]!.busId]:
          boundaryBuses[4]!.connections[0]!.sourceLayer,
      },
    }),
  ).toBe(false)
  expect(
    isEligible({
      buses: boundaryBuses.map((bus, index) =>
        index === 4
          ? {
              ...bus,
              connections: [
                ...bus.connections,
                { sourceLayer: throughAllAssignments[bus.busId]! },
              ],
            }
          : bus,
      ),
    }),
  ).toBe(false)
  expect(
    isEligible({
      assignments: Object.fromEntries(
        Object.entries(throughAllAssignments).slice(0, 8),
      ),
    }),
  ).toBe(false)
})

test("skips an ineligible released preflight and leaves the fallback path available", () => {
  let preflightCalls = 0
  const result = runReleasedDenseAdaptivePreflightIfEligible({
    eligible: false,
    runPreflight: () => {
      preflightCalls++
      return { plans: ["preflight"] }
    },
  })

  expect(result).toBeNull()
  expect(preflightCalls).toBe(0)

  const eligibleResult = runReleasedDenseAdaptivePreflightIfEligible({
    eligible: true,
    runPreflight: () => {
      preflightCalls++
      return { plans: ["preflight"] }
    },
  })
  expect(eligibleResult).toEqual({ plans: ["preflight"] })
  expect(preflightCalls).toBe(1)
})

test("keeps expanded dogbone path matching dormant when the direct map is complete", () => {
  const directViaPoints = new Map([[0, { x: 1, y: 2 }]])
  let pathMatchCount = 0

  const assignment = matchDenseDogboneCompletionDirectFirst({
    matchDirect: () => directViaPoints,
    matchPaths: () => {
      pathMatchCount++
      return new Map()
    },
  })

  expect(assignment).toEqual({ kind: "direct", viaPoints: directViaPoints })
  expect(pathMatchCount).toBe(0)
})

test("expands dogbone paths only after direct sites are blocked", () => {
  const expandedViaPaths = new Map([
    [
      0,
      {
        point: { x: 1, y: 2 },
        path: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 2 },
        ],
      },
    ],
  ])
  let pathMatchCount = 0

  const assignment = matchDenseDogboneCompletionDirectFirst({
    matchDirect: () => null,
    matchPaths: () => {
      pathMatchCount++
      return expandedViaPaths
    },
  })

  expect(assignment).toEqual({ kind: "path", viaPaths: expandedViaPaths })
  expect(pathMatchCount).toBe(1)
})

test("reuses a plane-feasible legacy root without expanded probing", () => {
  const legacyProbe = { failed: false, unavailablePlaneCount: 0 }
  let expandedProbeCount = 0

  const selection = runLegacyFirstDenseRootProbe({
    probeLegacy: () => legacyProbe,
    legacyIsUsable: (probe) =>
      !probe.failed && probe.unavailablePlaneCount === 0,
    probeExpanded: () => {
      expandedProbeCount++
      return { failed: false, unavailablePlaneCount: 0 }
    },
  })

  expect(selection).toEqual({
    probe: legacyProbe,
    usedExpandedSearch: false,
  })
  expect(expandedProbeCount).toBe(0)
})

test("escalates legacy roots that fail or consume plane capacity", () => {
  for (const legacyProbe of [
    { failed: true, unavailablePlaneCount: 0 },
    { failed: false, unavailablePlaneCount: 1 },
  ]) {
    const expandedProbe = { failed: false, unavailablePlaneCount: 0 }
    let expandedProbeCount = 0
    const selection = runLegacyFirstDenseRootProbe({
      probeLegacy: () => legacyProbe,
      legacyIsUsable: (probe) =>
        !probe.failed && probe.unavailablePlaneCount === 0,
      probeExpanded: () => {
        expandedProbeCount++
        return expandedProbe
      },
    })

    expect(selection).toEqual({
      probe: expandedProbe,
      usedExpandedSearch: true,
    })
    expect(expandedProbeCount).toBe(1)
  }
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

test("retries a bounded wide topology when a complete boundary-only field is untunable", () => {
  expect(
    shouldSearchReleasedDenseBoundaryRouteTopologies({
      boundaryBusCount: 9,
      planeBusCount: 0,
      connectionCount: 8,
      rawSkew: 11.2,
      maximumSkew: 8,
    }),
  ).toBe(true)
  expect(
    shouldSearchReleasedDenseBoundaryRouteTopologies({
      boundaryBusCount: 9,
      planeBusCount: 8,
      connectionCount: 8,
      rawSkew: 11.2,
      maximumSkew: 8,
    }),
  ).toBe(false)
  expect(
    shouldSearchReleasedDenseBoundaryRouteTopologies({
      boundaryBusCount: 9,
      planeBusCount: 0,
      connectionCount: 2,
      rawSkew: 1.6,
      maximumSkew: 0.25,
    }),
  ).toBe(false)
})

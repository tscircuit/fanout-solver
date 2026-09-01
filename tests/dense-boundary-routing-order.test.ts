import { expect, test } from "bun:test"
import {
  buildDenseBoundaryRoutingOrderCandidates,
  buildReleasedDenseBoundaryRoutingOrder,
  getReleasedDenseProvisionalSingletonBuses,
  normalizeDenseCenteredAdjacentLaneBundleOrder,
} from "../lib/fanout-solver"

type Bus = { id: string; connections: unknown[] }

const bus = (id: string, width = 1): Bus => ({
  id,
  connections: Array.from({ length: width }),
})

test("keeps the released provisional policy and boundary order isolated", () => {
  const leading = bus("leading")
  const newSingleLayerLeader = bus("new-single-layer-leader")
  const laneInward = bus("lane-inward")
  const provisional = bus("provisional")
  expect(
    getReleasedDenseProvisionalSingletonBuses({
      singletonDeferralCandidates: [
        leading,
        newSingleLayerLeader,
        laneInward,
        provisional,
      ],
      leadingWideSingletonBuses: [leading],
      laneInwardSingletonBuses: new Set([laneInward]),
    }).map(({ id }) => id),
  ).toEqual(["new-single-layer-leader", "provisional"])

  const wideA = bus("wide-a", 8)
  const wideB = bus("wide-b", 4)
  const earlyInward = bus("early-inward")
  const ordinaryPair = bus("ordinary-pair", 2)
  const targetOrderedPair = bus("target-ordered-pair", 2)
  expect(
    buildReleasedDenseBoundaryRoutingOrder({
      boundaryBuses: [
        ordinaryPair,
        wideA,
        targetOrderedPair,
        leading,
        wideB,
        laneInward,
        earlyInward,
      ],
      leadingWideSingletonBuses: [leading],
      earlyInwardSingletonBuses: [earlyInward],
      laneOrderSingletonBuses: [laneInward],
      targetOrderedPairBuses: new Set([targetOrderedPair]),
    }).map(({ id }) => id),
  ).toEqual([
    "leading",
    "wide-a",
    "wide-b",
    "early-inward",
    "ordinary-pair",
    "lane-inward",
    "target-ordered-pair",
  ])
})

test("normalizes only a centered adjacent bundle among target-ordered pairs", () => {
  type TargetBus = Bus & { targetTracks: number[] }
  const targetBus = (
    id: string,
    targetTracks: number[],
    width = targetTracks.length,
  ): TargetBus => ({ ...bus(id, width), targetTracks })
  const wide = targetBus("wide", [], 8)
  const higherPair = targetBus("higher-pair", [2.5, 3])
  const lowerPair = targetBus("lower-pair", [-2.5, -2])
  const ordinarySingleton = targetBus("ordinary-singleton", [4])
  const adjacentSingleton = targetBus("adjacent-singleton", [1.5])
  const relatedPair = targetBus("related-pair", [0.5, 1])
  const legacyOrder = [
    wide,
    higherPair,
    lowerPair,
    ordinarySingleton,
    adjacentSingleton,
    relatedPair,
  ]

  expect(
    normalizeDenseCenteredAdjacentLaneBundleOrder({
      busesInRoutingOrder: legacyOrder,
      adjacentSingletonBuses: [adjacentSingleton],
      getComparablePairBuses: () => [higherPair, lowerPair, relatedPair],
      getRelatedPairBuses: () => [relatedPair],
      getTargetTracks: (candidate) => candidate.targetTracks,
    }).map(({ id }) => id),
  ).toEqual([
    "wide",
    "lower-pair",
    "adjacent-singleton",
    "related-pair",
    "higher-pair",
    "ordinary-singleton",
  ])

  expect(
    normalizeDenseCenteredAdjacentLaneBundleOrder({
      busesInRoutingOrder: legacyOrder,
      adjacentSingletonBuses: [],
      getComparablePairBuses: () => [],
      getRelatedPairBuses: () => [],
      getTargetTracks: (candidate) => candidate.targetTracks,
    }),
  ).toEqual(legacyOrder)
})

test("builds exact-once dense boundary routing order fallbacks", () => {
  const minimumWide = bus("minimum-wide")
  const maximumWide = bus("maximum-wide")
  const unbandedWide = bus("unbanded-wide")
  const minimumTrailing = bus("minimum-trailing")
  const minimumProvisional = bus("minimum-provisional")
  const maximumTrailing = bus("maximum-trailing")
  const maximumProvisional = bus("maximum-provisional")
  const unbandedTrailing = bus("unbanded-trailing")
  const unbandedProvisional = bus("unbanded-provisional")
  const leadingPair = bus("leading-pair")
  const leadingSingleton = bus("leading-singleton")
  const unembeddedPair = bus("unembedded-pair")
  const remainingEmbeddedPair = bus("remaining-embedded-pair")
  const remainingNarrow = bus("remaining-narrow")
  const followers = new Map<Bus, { trailing: Bus[]; provisional: Bus[] }>([
    [
      minimumWide,
      { trailing: [minimumTrailing], provisional: [minimumProvisional] },
    ],
    [
      maximumWide,
      { trailing: [maximumTrailing], provisional: [maximumProvisional] },
    ],
    [
      unbandedWide,
      { trailing: [unbandedTrailing], provisional: [unbandedProvisional] },
    ],
  ])
  const allBoundaryBuses = [
    minimumWide,
    maximumWide,
    unbandedWide,
    minimumTrailing,
    minimumProvisional,
    maximumTrailing,
    maximumProvisional,
    unbandedTrailing,
    unbandedProvisional,
    leadingPair,
    leadingSingleton,
    unembeddedPair,
    remainingEmbeddedPair,
    remainingNarrow,
  ]

  const candidates = buildDenseBoundaryRoutingOrderCandidates({
    allBoundaryBuses,
    minimumCornerWideBuses: [minimumWide],
    maximumCornerWideBuses: [maximumWide],
    unbandedWideBuses: [unbandedWide],
    pairBusesLeadingWideBuses: [leadingPair],
    leadingWideSingletonBuses: [leadingSingleton],
    unembeddedPairBuses: [unembeddedPair],
    remainingEmbeddedPairBuses: [remainingEmbeddedPair],
    remainingNarrowBoundaryBuses: [remainingNarrow],
    getTrailingPairFollowers: (wide) => followers.get(wide)?.trailing ?? [],
    getProvisionalFollowers: (wide) => followers.get(wide)?.provisional ?? [],
    getBusKey: ({ id }) => id,
  })

  expect(
    candidates.map((candidate) => ({
      kind: candidate.kind,
      buses: candidate.buses.map(({ id }) => id),
    })),
  ).toEqual([
    {
      kind: "interleaved",
      buses: [
        "minimum-wide",
        "minimum-trailing",
        "leading-pair",
        "minimum-provisional",
        "leading-singleton",
        "unbanded-wide",
        "unbanded-trailing",
        "unbanded-provisional",
        "maximum-wide",
        "maximum-trailing",
        "maximum-provisional",
        "unembedded-pair",
        "remaining-embedded-pair",
        "remaining-narrow",
      ],
    },
    {
      kind: "wide-first",
      buses: [
        "minimum-wide",
        "maximum-wide",
        "unbanded-wide",
        "minimum-trailing",
        "minimum-provisional",
        "maximum-trailing",
        "maximum-provisional",
        "unbanded-trailing",
        "unbanded-provisional",
        "leading-pair",
        "leading-singleton",
        "unembedded-pair",
        "remaining-embedded-pair",
        "remaining-narrow",
      ],
    },
    {
      kind: "constraint-first",
      buses: [
        "unbanded-wide",
        "leading-singleton",
        "maximum-wide",
        "minimum-wide",
        "unembedded-pair",
        "leading-pair",
        "remaining-embedded-pair",
        "remaining-narrow",
        "unbanded-provisional",
        "unbanded-trailing",
        "maximum-provisional",
        "maximum-trailing",
        "minimum-provisional",
        "minimum-trailing",
      ],
    },
  ])
})

test("deduplicates identical dense boundary routing orders", () => {
  const onlyWideBus = bus("only-wide")
  const candidates = buildDenseBoundaryRoutingOrderCandidates({
    allBoundaryBuses: [onlyWideBus],
    minimumCornerWideBuses: [onlyWideBus],
    maximumCornerWideBuses: [],
    unbandedWideBuses: [],
    pairBusesLeadingWideBuses: [],
    leadingWideSingletonBuses: [],
    unembeddedPairBuses: [],
    remainingEmbeddedPairBuses: [],
    remainingNarrowBoundaryBuses: [],
    getTrailingPairFollowers: () => [],
    getProvisionalFollowers: () => [],
    getBusKey: ({ id }) => id,
  })

  expect(candidates).toEqual([{ kind: "interleaved", buses: [onlyWideBus] }])
})

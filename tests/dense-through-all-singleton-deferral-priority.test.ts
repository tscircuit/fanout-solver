import { expect, test } from "bun:test"
import {
  compareDenseSingletonBoundaryDeferralPriority,
  getDenseCornerTargetLaneOffsets,
  getDenseSingletonBoundaryGeometry,
  isDenseCornerSingletonTargetLaneInwardOfPairs,
  isDenseSingletonEmbeddedInSingleLayerWideBus,
  isDenseSingletonTargetLaneAdjacentToPairs,
} from "../lib/fanout-solver"

test("detects a singleton embedded in a same-layer wide source field", () => {
  const singleton = {
    componentId: "component",
    exitEdge: "top" as const,
    routableEscapeLayers: ["inner6"],
    connections: [{ sourcePoint: { x: 1, y: 1 } }],
  }
  const wideBus = {
    componentId: "component",
    exitEdge: "top" as const,
    routableEscapeLayers: ["inner6"],
    connections: Array.from({ length: 8 }, (_, index) => ({
      sourcePoint: { x: index % 4, y: Math.floor(index / 4) },
    })),
  }
  expect(
    isDenseSingletonEmbeddedInSingleLayerWideBus({
      singletonBus: singleton,
      singletonTargetLayer: "inner6",
      wideBuses: [wideBus],
    }),
  ).toBe(true)
  expect(
    isDenseSingletonEmbeddedInSingleLayerWideBus({
      singletonBus: singleton,
      singletonTargetLayer: "inner5",
      wideBuses: [wideBus],
    }),
  ).toBe(false)
})

type SingletonInput = Parameters<
  typeof compareDenseSingletonBoundaryDeferralPriority
>[0]

const makeSingleton = ({
  busId,
  exitPosition,
  targetY,
}: {
  busId: string
  exitPosition: "leftside_top" | "leftside_center"
  targetY: number
}): SingletonInput => ({
  busId,
  direction: "up",
  exitEdge: "left",
  preferredExit: exitPosition === "leftside_top" ? "top-left" : "left",
  connections: [
    {
      sourcePoint: { x: 0, y: 0 },
      exitTargetPoint: { x: -1, y: targetY },
    },
  ],
})

const permutations = <T>([first, second, third]: [T, T, T]): [T, T, T][] => [
  [first, second, third],
  [first, third, second],
  [second, first, third],
  [second, third, first],
  [third, first, second],
  [third, second, first],
]

test("prioritizes three singletons deterministically by centered then inward target", () => {
  const centeredReset = makeSingleton({
    busId: "DDR_RESET",
    exitPosition: "leftside_center",
    targetY: -1,
  })
  const inwardDmi0 = makeSingleton({
    busId: "DDR_DMI0",
    exitPosition: "leftside_top",
    targetY: -1,
  })
  expect(
    [inwardDmi0, centeredReset]
      .toSorted(compareDenseSingletonBoundaryDeferralPriority)
      .map((bus) => bus.busId),
  ).toEqual(["DDR_RESET", "DDR_DMI0"])

  const inwardReset = makeSingleton({
    busId: "DDR_RESET",
    exitPosition: "leftside_top",
    targetY: -1,
  })
  const outwardDmi0 = makeSingleton({
    busId: "DDR_DMI0",
    exitPosition: "leftside_top",
    targetY: 1,
  })
  expect(getDenseSingletonBoundaryGeometry(inwardReset)).toEqual({
    isCorner: true,
    targetProjection: -1,
  })
  expect(getDenseSingletonBoundaryGeometry(outwardDmi0)).toEqual({
    isCorner: true,
    targetProjection: 1,
  })
  expect(
    [outwardDmi0, inwardReset]
      .toSorted(compareDenseSingletonBoundaryDeferralPriority)
      .map((bus) => bus.busId),
  ).toEqual(["DDR_RESET", "DDR_DMI0"])

  const inwardDownDmi1: SingletonInput = {
    busId: "DDR_DMI1",
    direction: "down",
    exitEdge: "right",
    preferredExit: "bottom-right",
    connections: [
      {
        sourcePoint: { x: 0, y: 0 },
        exitTargetPoint: { x: 1, y: 5 },
      },
    ],
  }
  expect(getDenseSingletonBoundaryGeometry(inwardDownDmi1)).toEqual({
    isCorner: true,
    targetProjection: -5,
  })
  for (const permutation of permutations([
    centeredReset,
    inwardDmi0,
    inwardDownDmi1,
  ])) {
    expect(
      permutation
        .toSorted(compareDenseSingletonBoundaryDeferralPriority)
        .map((bus) => bus.busId),
    ).toEqual(["DDR_RESET", "DDR_DMI1", "DDR_DMI0"])
  }

  const centeredDmi1 = makeSingleton({
    busId: "DDR_DMI1",
    exitPosition: "leftside_center",
    targetY: 1,
  })
  for (const permutation of permutations([
    centeredDmi1,
    inwardReset,
    outwardDmi0,
  ])) {
    expect(
      permutation
        .toSorted(compareDenseSingletonBoundaryDeferralPriority)
        .map((bus) => bus.busId),
    ).toEqual(["DDR_DMI1", "DDR_RESET", "DDR_DMI0"])
  }

  const outwardReset = { ...outwardDmi0, busId: "DDR_RESET" }
  expect(
    [outwardReset, outwardDmi0]
      .toSorted(compareDenseSingletonBoundaryDeferralPriority)
      .map((bus) => bus.busId),
  ).toEqual(["DDR_DMI0", "DDR_RESET"])
})

type CornerTargetBus = Parameters<
  typeof isDenseCornerSingletonTargetLaneInwardOfPairs
>[0]["singletonBus"]

const makeCornerTargetBus = ({
  busId,
  exitEdge,
  preferredExit,
  targetTracks,
}: {
  busId: string
  exitEdge: NonNullable<CornerTargetBus["exitEdge"]>
  preferredExit: NonNullable<CornerTargetBus["preferredExit"]>
  targetTracks: number[]
}): CornerTargetBus => ({
  busId,
  exitEdge,
  preferredExit,
  connections: targetTracks.map((targetTrack) => ({
    exitTargetPoint:
      exitEdge === "left" || exitEdge === "right"
        ? { x: 0, y: targetTrack }
        : { x: targetTrack, y: 0 },
  })),
})

test("detects a corner singleton target lane inward of same-layer pairs", () => {
  const singleton = makeCornerTargetBus({
    busId: "singleton",
    exitEdge: "left",
    preferredExit: "top-left",
    targetTracks: [4.9566],
  })
  const clockPair = makeCornerTargetBus({
    busId: "clock-pair",
    exitEdge: "left",
    preferredExit: "top-left",
    targetTracks: [5.92044, 6.24172],
  })
  const strobePair = makeCornerTargetBus({
    busId: "strobe-pair",
    exitEdge: "left",
    preferredExit: "top-left",
    targetTracks: [5.59916, 5.27788],
  })
  const assignedLayerByBusId = new Map([
    ["singleton", "inner5"],
    ["clock-pair", "inner5"],
    ["strobe-pair", "inner5"],
  ])

  expect(
    isDenseCornerSingletonTargetLaneInwardOfPairs({
      singletonBus: singleton,
      pairBuses: [clockPair, strobePair],
      assignedLayerByBusId,
      routePitch: 0.32128,
    }),
  ).toBe(true)

  const rotatedSingleton = makeCornerTargetBus({
    busId: "singleton",
    exitEdge: "top",
    preferredExit: "top-left",
    targetTracks: [-4.9566],
  })
  const rotatedClockPair = makeCornerTargetBus({
    busId: "clock-pair",
    exitEdge: "top",
    preferredExit: "top-left",
    targetTracks: [-5.92044, -6.24172],
  })
  const rotatedStrobePair = makeCornerTargetBus({
    busId: "strobe-pair",
    exitEdge: "top",
    preferredExit: "top-left",
    targetTracks: [-5.59916, -5.27788],
  })
  expect(
    isDenseCornerSingletonTargetLaneInwardOfPairs({
      singletonBus: rotatedSingleton,
      pairBuses: [rotatedClockPair, rotatedStrobePair],
      assignedLayerByBusId,
      routePitch: 0.32128,
    }),
  ).toBe(true)

  expect(
    isDenseCornerSingletonTargetLaneInwardOfPairs({
      singletonBus: singleton,
      pairBuses: [clockPair, strobePair],
      assignedLayerByBusId: new Map([
        ["singleton", "inner4"],
        ["clock-pair", "inner5"],
        ["strobe-pair", "inner5"],
      ]),
      routePitch: 0.32128,
    }),
  ).toBe(false)

  expect(
    isDenseCornerSingletonTargetLaneInwardOfPairs({
      singletonBus: makeCornerTargetBus({
        busId: "singleton",
        exitEdge: "left",
        preferredExit: "left",
        targetTracks: [4.9566],
      }),
      pairBuses: [clockPair, strobePair],
      assignedLayerByBusId,
      routePitch: 0.32128,
    }),
  ).toBe(false)

  expect(
    getDenseCornerTargetLaneOffsets({
      buses: [clockPair, strobePair, singleton],
      assignedLayerByBusId,
    }),
  ).toEqual(
    new Map([
      ["singleton", 0],
      ["strobe-pair", 1],
      ["clock-pair", 3],
    ]),
  )
  expect(
    getDenseCornerTargetLaneOffsets({
      buses: [rotatedClockPair, rotatedStrobePair, rotatedSingleton],
      assignedLayerByBusId,
    }),
  ).toEqual(
    new Map([
      ["clock-pair", 0],
      ["strobe-pair", 2],
      ["singleton", 4],
    ]),
  )

  const interleavedPair = makeCornerTargetBus({
    busId: "clock-pair",
    exitEdge: "left",
    preferredExit: "top-left",
    targetTracks: [4.8, 6.2],
  })
  expect(
    getDenseCornerTargetLaneOffsets({
      buses: [interleavedPair, strobePair, singleton],
      assignedLayerByBusId,
    }),
  ).toEqual(new Map())
})

test("detects a centered singleton immediately outside a same-layer pair lane", () => {
  const makeBus = ({
    busId,
    targetTracks,
    componentId = "component",
    exitEdge = "left",
    preferredExit = "left",
  }: {
    busId: string
    targetTracks: number[]
    componentId?: string
    exitEdge?: "left" | "right"
    preferredExit?: "left" | "top-left"
  }) => ({
    busId,
    componentId,
    exitEdge,
    preferredExit,
    connections: targetTracks.map((targetTrack) => ({
      exitTargetPoint: { x: 0, y: targetTrack },
    })),
  })
  const pair = makeBus({ busId: "pair", targetTracks: [0, 1] })
  const assignedLayerByBusId = new Map([
    ["singleton", "inner5"],
    ["pair", "inner5"],
  ])
  const isAdjacent = (
    singletonOverrides: Partial<ReturnType<typeof makeBus>> = {},
    pairOverrides: Partial<ReturnType<typeof makeBus>> = {},
    assignedLayers = assignedLayerByBusId,
  ) =>
    isDenseSingletonTargetLaneAdjacentToPairs({
      singletonBus: {
        ...makeBus({ busId: "singleton", targetTracks: [2] }),
        ...singletonOverrides,
      },
      pairBuses: [{ ...pair, ...pairOverrides }],
      assignedLayerByBusId: assignedLayers,
      routePitch: 1,
    })

  expect(isAdjacent()).toBe(true)
  expect(
    isAdjacent({ connections: [{ exitTargetPoint: { x: 0, y: -4 } }] }),
  ).toBe(false)
  expect(
    isAdjacent({ connections: [{ exitTargetPoint: { x: 0, y: 1.5 } }] }),
  ).toBe(false)
  expect(
    isAdjacent({ connections: [{ exitTargetPoint: { x: 0, y: 0.5 } }] }),
  ).toBe(false)
  expect(isAdjacent({ componentId: "other" })).toBe(false)
  expect(isAdjacent({ exitEdge: "right" })).toBe(false)
  expect(isAdjacent({ preferredExit: "top-left" })).toBe(false)
  expect(
    isAdjacent(
      {},
      {},
      new Map([
        ["singleton", "inner4"],
        ["pair", "inner5"],
      ]),
    ),
  ).toBe(false)
})

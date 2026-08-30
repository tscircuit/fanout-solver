import { expect, test } from "bun:test"
import {
  compareDenseSingletonBoundaryDeferralPriority,
  getDenseSingletonBoundaryGeometry,
} from "../lib/fanout-solver"

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

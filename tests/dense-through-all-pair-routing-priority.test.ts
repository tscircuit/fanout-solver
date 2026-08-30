import { expect, test } from "bun:test"
import { getDenseBoundaryPairRoutingPriorityKeys } from "../lib/fanout-solver"

type PairInput = Parameters<
  typeof getDenseBoundaryPairRoutingPriorityKeys
>[0]["pairBuses"][number]

const makePair = ({
  componentId = "U1",
  distance,
  exitEdge = "right" as const,
  assignedLayer = "inner5",
  sourceLayer = "top",
}: {
  componentId?: string
  distance: number | readonly [number, number]
  exitEdge?: "left" | "right" | "top" | "bottom"
  assignedLayer?: string
  sourceLayer?: string
}): PairInput => {
  const laneDistances =
    typeof distance === "number" ? [distance, distance] : distance
  return {
    componentId,
    exitEdge,
    assignedLayer,
    connections: [0, 1].map((lane) => ({
      sourceLayer,
      sourcePoint: { x: 0, y: lane },
      exitTargetPoint: {
        x: laneDistances[lane]!,
        y: lane,
        layer: assignedLayer,
      },
    })),
  }
}

const permutations = <T>([first, second, third]: [T, T, T]): [T, T, T][] => [
  [first, second, third],
  [first, third, second],
  [second, first, third],
  [second, third, first],
  [third, first, second],
  [third, second, first],
]

const getPriorityKeys = (
  pairBuses: readonly PairInput[],
  boundaryBusCount = 7,
) =>
  getDenseBoundaryPairRoutingPriorityKeys({
    boundaryBusCount,
    pairBuses,
  })

const expectEveryPermutationToSortAs = (
  pairs: [[string, PairInput], [string, PairInput], [string, PairInput]],
  expectedOrder: string[],
  boundaryBusCount = 7,
) => {
  for (const permutation of permutations(pairs)) {
    const keys = getPriorityKeys(
      permutation.map(([, pair]) => pair),
      boundaryBusCount,
    )
    expect(keys).not.toBeNull()
    expect(
      permutation
        .map(([busId], index) => [busId, keys![index]!] as const)
        .toSorted(([, firstKey], [, secondKey]) => firstKey - secondKey)
        .map(([busId]) => busId),
    ).toEqual(expectedOrder)
  }
}

test("orders all three dense pairs by one guarded, deterministic farthest-lane key", () => {
  const socPairs: [
    [string, PairInput],
    [string, PairInput],
    [string, PairInput],
  ] = [
    ["DDR_CLOCK", makePair({ distance: 14.3827 })],
    ["DDR_DQS0", makePair({ distance: 14.3973 })],
    ["DDR_DQS1", makePair({ distance: 15.2791 })],
  ]
  const dramPairs: [
    [string, PairInput],
    [string, PairInput],
    [string, PairInput],
  ] = [
    ["DDR_CLOCK", makePair({ distance: [9.0731, 8.9831], exitEdge: "left" })],
    ["DDR_DQS0", makePair({ distance: [8.8962, 9.0847], exitEdge: "left" })],
    ["DDR_DQS1", makePair({ distance: [6.3501, 6.7316], exitEdge: "left" })],
  ]
  const getMeanDistance = (pair: PairInput): number =>
    pair.connections.reduce((total, connection) => {
      const target = connection.exitTargetPoint!
      return (
        total +
        Math.hypot(
          target.x - connection.sourcePoint.x,
          target.y - connection.sourcePoint.y,
        )
      )
    }, 0) / pair.connections.length
  expect(
    dramPairs
      .toSorted(([, first], [, second]) => {
        return getMeanDistance(first) - getMeanDistance(second)
      })
      .map(([busId]) => busId),
  ).toEqual(["DDR_DQS1", "DDR_DQS0", "DDR_CLOCK"])

  for (const boundaryBusCount of [7, 8, 9]) {
    expectEveryPermutationToSortAs(
      socPairs,
      ["DDR_CLOCK", "DDR_DQS0", "DDR_DQS1"],
      boundaryBusCount,
    )
    expectEveryPermutationToSortAs(
      dramPairs,
      ["DDR_DQS1", "DDR_CLOCK", "DDR_DQS0"],
      boundaryBusCount,
    )
  }

  expect(
    getPriorityKeys([
      makePair({ distance: 5 }),
      makePair({ distance: 5 + 0.4e-9 }),
      makePair({ distance: 5 + 0.8e-9 }),
    ]),
  ).toEqual([5, 5, 5.000000001])
})

test("disables pair-distance priority for the entire group when any guard fails", () => {
  const validPairs = [
    makePair({ distance: 5 }),
    makePair({ distance: 8 }),
    makePair({ distance: 11 }),
  ]
  expect(getPriorityKeys(validPairs, 6)).toBeNull()
  expect(getPriorityKeys(validPairs, 10)).toBeNull()
  expect(getPriorityKeys(validPairs.slice(0, 2))).toBeNull()
  expect(
    getPriorityKeys([...validPairs, makePair({ distance: 14 })]),
  ).toBeNull()

  const expectMixedGroupToBeDisabled = (replacement: PairInput) => {
    expect(
      getPriorityKeys([validPairs[0]!, validPairs[1]!, replacement]),
    ).toBeNull()
  }
  expectMixedGroupToBeDisabled(makePair({ componentId: "U2", distance: 11 }))
  expectMixedGroupToBeDisabled(makePair({ distance: 11, exitEdge: "left" }))
  expectMixedGroupToBeDisabled(
    makePair({ distance: 11, assignedLayer: "inner4" }),
  )
  expectMixedGroupToBeDisabled({
    ...validPairs[2]!,
    connections: validPairs[2]!.connections.map((connection) => ({
      ...connection,
      exitTargetPoint: {
        ...connection.exitTargetPoint!,
        layer: "inner4",
      },
    })),
  })
  expectMixedGroupToBeDisabled(
    makePair({ distance: 11, sourceLayer: "bottom" }),
  )
  expectMixedGroupToBeDisabled({
    ...validPairs[2]!,
    connections: validPairs[2]!.connections.map((connection) => ({
      ...connection,
      exitTargetPoint: undefined,
    })),
  })
  expectMixedGroupToBeDisabled({
    ...validPairs[2]!,
    connections: validPairs[2]!.connections.slice(0, 1),
  })
})

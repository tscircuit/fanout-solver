import { expect, test } from "bun:test"
import {
  getBusWithDenseSearchCornerBandOffset,
  getDenseCornerBandLaneOffsets,
} from "lib/fanout-solver"

const makeBus = (params: {
  busId: string
  width: number
  firstConnectionIndex: number
  targetTrack?: number
  preferredExit?: "top-left" | "top-right"
}) => ({
  busId: params.busId,
  exitEdge: "top" as const,
  preferredExit: params.preferredExit ?? ("top-left" as const),
  connections: Array.from({ length: params.width }, (_, index) => ({
    connectionIndex: params.firstConnectionIndex + index,
    ...(params.targetTrack === undefined
      ? {}
      : { exitTargetPoint: { x: params.targetTrack + index * 0.1, y: 10 } }),
  })),
})

test("packs a same-layer bus sequence around the centered widest bus", () => {
  const buses = [
    makeBus({
      busId: "clock",
      width: 2,
      firstConnectionIndex: 0,
      targetTrack: 0,
    }),
    makeBus({
      busId: "dmi",
      width: 1,
      firstConnectionIndex: 2,
      targetTrack: 2,
    }),
    makeBus({
      busId: "wide",
      width: 8,
      firstConnectionIndex: 3,
      targetTrack: 1,
    }),
    makeBus({
      busId: "dqs",
      width: 2,
      firstConnectionIndex: 11,
      targetTrack: 3,
    }),
  ]
  const layers = new Map([
    ["clock", "inner5"],
    ["dmi", "inner5"],
    ["wide", "inner4"],
    ["dqs", "inner5"],
  ])
  const expected = new Map([
    ["clock", 0],
    ["dmi", 2],
    ["wide", 3],
    ["dqs", 11],
  ])
  expect(
    getDenseCornerBandLaneOffsets({ buses, assignedLayerByBusId: layers }),
  ).toEqual(expected)

  const mirroredAndPermuted = buses.toReversed().map((bus) => ({
    ...bus,
    preferredExit: "top-right" as const,
    connections: bus.connections.map((connection) => ({
      ...connection,
      ...(connection.exitTargetPoint
        ? {
            exitTargetPoint: {
              ...connection.exitTargetPoint,
              x: -connection.exitTargetPoint.x,
            },
          }
        : {}),
    })),
  }))
  expect(
    getDenseCornerBandLaneOffsets({
      buses: mirroredAndPermuted,
      assignedLayerByBusId: layers,
    }),
  ).toEqual(expected)
})

test("packs missing-target buses into non-overlapping contiguous slots", () => {
  const buses = [
    makeBus({ busId: "narrow-a", width: 2, firstConnectionIndex: 0 }),
    makeBus({ busId: "wide", width: 5, firstConnectionIndex: 2 }),
    makeBus({ busId: "narrow-b", width: 1, firstConnectionIndex: 7 }),
  ]
  const offsets = getDenseCornerBandLaneOffsets({
    buses,
    assignedLayerByBusId: new Map([
      ["narrow-a", "inner2"],
      ["wide", "inner1"],
      ["narrow-b", "inner2"],
    ]),
  })
  const occupiedSlots = buses.flatMap((bus) =>
    Array.from(
      { length: bus.connections.length },
      (_, index) => offsets.get(bus.busId)! + index,
    ),
  )
  expect(occupiedSlots.toSorted((first, second) => first - second)).toEqual(
    Array.from({ length: 8 }, (_, index) => index),
  )
})

test("keeps legacy root lane offsets local to the legacy probe", () => {
  const packedBus = {
    busId: "pair",
    cornerBandExitLaneOffset: 11,
  }
  const legacyOffsets = new Map<string, number | undefined>([["pair", 2]])

  expect(
    getBusWithDenseSearchCornerBandOffset({
      bus: packedBus,
      useGloballyPackedCornerBandLanes: true,
      legacyCornerBandExitLaneOffsetByBusId: legacyOffsets,
    }),
  ).toBe(packedBus)

  const legacyProbeBus = getBusWithDenseSearchCornerBandOffset({
    bus: packedBus,
    useGloballyPackedCornerBandLanes: false,
    legacyCornerBandExitLaneOffsetByBusId: legacyOffsets,
  })
  expect(legacyProbeBus).not.toBe(packedBus)
  expect(legacyProbeBus.cornerBandExitLaneOffset).toBe(2)
  expect(packedBus.cornerBandExitLaneOffset).toBe(11)

  expect(
    getBusWithDenseSearchCornerBandOffset({
      bus: packedBus,
      useGloballyPackedCornerBandLanes: false,
      legacyCornerBandExitLaneOffsetByBusId: new Map([["pair", undefined]]),
    }).cornerBandExitLaneOffset,
  ).toBeUndefined()
})

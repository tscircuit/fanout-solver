import { expect, test } from "bun:test"
import { isDenseCornerSingletonContiguousWithPairBundle } from "../lib/fanout-solver"
import { getCornerTargetTrack } from "../lib/route-bus"
import type { PreparedBus, PreparedConnection } from "../lib/types"

type CornerTargetBus = Parameters<
  typeof isDenseCornerSingletonContiguousWithPairBundle
>[0]["singletonBus"]

const makeCornerTargetBus = ({
  busId,
  componentId = "dram",
  exitEdge = "left",
  preferredExit = "top-left",
  targetTracks,
}: {
  busId: string
  componentId?: string
  exitEdge?: NonNullable<CornerTargetBus["exitEdge"]>
  preferredExit?: NonNullable<CornerTargetBus["preferredExit"]>
  targetTracks: number[]
}): CornerTargetBus => ({
  busId,
  componentId,
  exitEdge,
  preferredExit,
  connections: targetTracks.map((targetTrack) => ({
    exitTargetPoint:
      exitEdge === "left" || exitEdge === "right"
        ? { x: 0, y: targetTrack }
        : { x: targetTrack, y: 0 },
  })),
})

const singleton = makeCornerTargetBus({
  busId: "dmi0",
  targetTracks: [4.9566],
})
const clockPair = makeCornerTargetBus({
  busId: "clock",
  targetTracks: [5.92044, 6.24172],
})
const strobePair = makeCornerTargetBus({
  busId: "dqs0",
  targetTracks: [5.59916, 5.27788],
})

const assignedLayers = (overrides: Readonly<Record<string, string>> = {}) =>
  new Map([
    ["dmi0", overrides.dmi0 ?? "inner5"],
    ["clock", overrides.clock ?? "inner5"],
    ["dqs0", overrides.dqs0 ?? "inner5"],
  ])

test("detects a contiguous corner singleton and pair bundle", () => {
  expect(
    isDenseCornerSingletonContiguousWithPairBundle({
      singletonBus: singleton,
      pairBuses: [clockPair, strobePair],
      assignedLayerByBusId: assignedLayers(),
      routePitch: 0.32128,
    }),
  ).toBe(true)

  expect(
    isDenseCornerSingletonContiguousWithPairBundle({
      singletonBus: singleton,
      pairBuses: [strobePair],
      assignedLayerByBusId: assignedLayers(),
      routePitch: 0.32128,
    }),
  ).toBe(false)

  const interleavedPairA = makeCornerTargetBus({
    busId: "clock",
    targetTracks: [5.27788, 5.92044],
  })
  const interleavedPairB = makeCornerTargetBus({
    busId: "dqs0",
    targetTracks: [5.59916, 6.24172],
  })
  expect(
    isDenseCornerSingletonContiguousWithPairBundle({
      singletonBus: singleton,
      pairBuses: [interleavedPairA, interleavedPairB],
      assignedLayerByBusId: assignedLayers(),
      routePitch: 0.32128,
    }),
  ).toBe(false)

  const gappedClockPair = makeCornerTargetBus({
    busId: "clock",
    targetTracks: [6.2, 6.52128],
  })
  expect(
    isDenseCornerSingletonContiguousWithPairBundle({
      singletonBus: singleton,
      pairBuses: [strobePair, gappedClockPair],
      assignedLayerByBusId: assignedLayers(),
      routePitch: 0.32128,
    }),
  ).toBe(false)
})

test("does not count pairs from another component, edge, or assigned layer", () => {
  const otherComponentPair = {
    ...clockPair,
    componentId: "soc",
  }
  const otherEdgePair = makeCornerTargetBus({
    busId: "clock",
    exitEdge: "right",
    preferredExit: "top-right",
    targetTracks: [5.92044, 6.24172],
  })

  for (const pairBuses of [
    [strobePair, otherComponentPair],
    [strobePair, otherEdgePair],
  ]) {
    expect(
      isDenseCornerSingletonContiguousWithPairBundle({
        singletonBus: singleton,
        pairBuses,
        assignedLayerByBusId: assignedLayers(),
        routePitch: 0.32128,
      }),
    ).toBe(false)
  }

  expect(
    isDenseCornerSingletonContiguousWithPairBundle({
      singletonBus: singleton,
      pairBuses: [clockPair, strobePair],
      assignedLayerByBusId: assignedLayers({ clock: "inner4" }),
      routePitch: 0.32128,
    }),
  ).toBe(false)
})

test("detects the symmetric minimum-corner bundle", () => {
  const minimumSingleton = makeCornerTargetBus({
    busId: "dmi0",
    preferredExit: "bottom-left",
    targetTracks: [-4.9566],
  })
  const minimumStrobePair = makeCornerTargetBus({
    busId: "dqs0",
    preferredExit: "bottom-left",
    targetTracks: [-5.27788, -5.59916],
  })
  const minimumClockPair = makeCornerTargetBus({
    busId: "clock",
    preferredExit: "bottom-left",
    targetTracks: [-5.92044, -6.24172],
  })
  expect(
    isDenseCornerSingletonContiguousWithPairBundle({
      singletonBus: minimumSingleton,
      pairBuses: [minimumClockPair, minimumStrobePair],
      assignedLayerByBusId: assignedLayers(),
      routePitch: 0.32128,
    }),
  ).toBe(true)
})

test("keeps coordinated target order on a positive-direction corner", () => {
  const connections = [5, 6].map(
    (targetTrack, connectionIndex) =>
      ({
        connectionIndex,
        connection: {
          name: `signal-${connectionIndex}`,
          pointsToConnect: [],
        },
        sourcePoint: { x: 1, y: targetTrack },
        sourceLayer: "top",
        targetPoint: { x: 8, y: targetTrack, layer: "inner1" },
        exitTargetPoint: { x: 10, y: targetTrack, layer: "inner1" },
        hasExplicitLayeredExitTarget: true,
      }) as unknown as PreparedConnection,
  )
  const bus = {
    busId: "mirrored-corner-pair",
    componentId: "dram",
    direction: "right",
    exitEdge: "right",
    preferredExit: "top-right",
    termination: { type: "boundary" },
    sharedBoundary: { minX: -8, maxX: 8, minY: -8, maxY: 8 },
    connections,
  } as PreparedBus
  const tracks = connections.map((connection) =>
    getCornerTargetTrack({
      bus,
      connection,
      cornerExitLaneOffset: 0,
      traceWidth: 0.08,
      viaDiameter: 0.24,
      clearance: 0.08128,
      layerNames: ["top", "inner1", "bottom"],
      targetLayer: "inner1",
      windingOrderIndex: 0,
    }),
  )

  expect(tracks[0]).toBeLessThan(tracks[1]!)
  expect(tracks).toEqual([3.83936, 4.16064])
})

import type { PreparedConnection } from "../types"
import { getAxis, getPerpendicularAxis } from "./directions"
import type {
  CoordinatedTerminalPattern,
  RouteBusBoundaryContext,
  ViaHandedness,
} from "./types"

export function getMixedDogboneTerminalPatterns(
  context: RouteBusBoundaryContext,
): CoordinatedTerminalPattern[] {
  const {
    bus,
    acceptedPlans,
    allowBlindAndBuriedVias,
    reservedVias,
    viaHandednesses,
  } = context
  const maximumThroughAllRouteOrderAttempts = 24
  const connectionsBySourceTrack = bus.connections.toSorted(
    (first, second) =>
      getPerpendicularAxis(first.sourcePoint, bus.direction) -
        getPerpendicularAxis(second.sourcePoint, bus.direction) ||
      getAxis(first.sourcePoint, bus.direction) -
        getAxis(second.sourcePoint, bus.direction) ||
      first.connectionIndex - second.connectionIndex,
  )
  const sourceTrackRankByConnectionIndex = new Map(
    connectionsBySourceTrack.map((connection, rank) => [
      connection.connectionIndex,
      rank,
    ]),
  )
  const getTowardMedianHandedness = (rank: number): ViaHandedness =>
    rank < connectionsBySourceTrack.length / 2 ? 1 : -1
  const middleRank = Math.floor(connectionsBySourceTrack.length / 2)
  const singleFlipRanks = [
    0,
    1,
    middleRank,
    middleRank + 1,
    ...connectionsBySourceTrack.map((_, rank) => rank),
  ].filter(
    (rank, index, ranks) =>
      rank >= 0 &&
      rank < connectionsBySourceTrack.length &&
      ranks.indexOf(rank) === index,
  )
  const towardMedianFlipRankSets = [
    [middleRank],
    [middleRank + 1],
    [0],
    [1],
    [0, middleRank + 1],
    [1, middleRank],
    [0, middleRank],
    [1, middleRank + 1],
    [0, 1],
    [middleRank, middleRank + 1],
    ...singleFlipRanks.map((rank) => [rank]),
  ]
    .map((ranks) =>
      ranks
        .filter((rank) => rank >= 0 && rank < connectionsBySourceTrack.length)
        .toSorted((first, second) => first - second),
    )
    .filter(
      (ranks, index, rankSets) =>
        ranks.length > 0 &&
        rankSets.findIndex(
          (candidate) => candidate.join(",") === ranks.join(","),
        ) === index,
    )
  const mixedDogboneTerminalPatterns: CoordinatedTerminalPattern[] =
    !allowBlindAndBuriedVias &&
    (reservedVias.length > 0 ||
      acceptedPlans.some((plan) => plan.termination.type === "plane")) &&
    viaHandednesses.includes(-1) &&
    viaHandednesses.includes(1)
      ? [
          {
            label: "toward-source-median",
            useViaInPad: false,
            maximumRouteOrderAttempts: maximumThroughAllRouteOrderAttempts,
            getViaHandedness: (connection) =>
              getTowardMedianHandedness(
                sourceTrackRankByConnectionIndex.get(
                  connection.connectionIndex,
                ) ?? 0,
              ),
          },
          ...towardMedianFlipRankSets.slice(0, 12).map((flippedRanks) => ({
            label: `toward-source-median-with-ranks-${flippedRanks.join("-")}-flipped`,
            useViaInPad: false,
            maximumRouteOrderAttempts: 6,
            getViaHandedness: (connection: PreparedConnection) => {
              const rank =
                sourceTrackRankByConnectionIndex.get(
                  connection.connectionIndex,
                ) ?? 0
              const towardMedian = getTowardMedianHandedness(rank)
              return flippedRanks.includes(rank)
                ? (-towardMedian as ViaHandedness)
                : towardMedian
            },
          })),
          {
            label: "alternating-source-grid-a",
            useViaInPad: false,
            maximumRouteOrderAttempts: 3,
            getViaHandedness: (connection) =>
              (sourceTrackRankByConnectionIndex.get(
                connection.connectionIndex,
              ) ?? 0) %
                2 ===
              0
                ? -1
                : 1,
          },
          {
            label: "alternating-source-grid-b",
            useViaInPad: false,
            maximumRouteOrderAttempts: 3,
            getViaHandedness: (connection) =>
              (sourceTrackRankByConnectionIndex.get(
                connection.connectionIndex,
              ) ?? 0) %
                2 ===
              0
                ? 1
                : -1,
          },
          {
            label: "away-from-source-median",
            useViaInPad: false,
            maximumRouteOrderAttempts: maximumThroughAllRouteOrderAttempts,
            getViaHandedness: (connection) =>
              (sourceTrackRankByConnectionIndex.get(
                connection.connectionIndex,
              ) ?? 0) <
              connectionsBySourceTrack.length / 2
                ? -1
                : 1,
          },
        ]
      : []
  return mixedDogboneTerminalPatterns
}

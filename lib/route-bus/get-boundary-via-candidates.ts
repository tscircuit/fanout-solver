import type { FanoutDirection, Point2D } from "../types"
import { directionSign, getCornerSide, makePoint } from "./directions"
import type { RouteBusBoundaryContext } from "./types"

export function getBoundaryViaCandidates(
  {
    finalTracks,
    boundaryDirection,
    boundaryExitAxis,
  }: {
    finalTracks: number[]
    boundaryDirection: FanoutDirection
    boundaryExitAxis: number
  },
  context: RouteBusBoundaryContext,
): { points: Point2D[]; boundarySide: boolean }[] {
  const {
    bus,
    viaDiameter,
    clearance,
    preferCornerBoundaryVia,
    fixedViaPointsByConnectionIndex,
  } = context
  if (!fixedViaPointsByConnectionIndex)
    throw new Error(
      "FanoutSolver: boundary via candidates require fixed source vias",
    )
  const insetStep = Math.max(
    viaDiameter / 2 + clearance,
    Math.min(bus.pitchX, bus.pitchY) / 2,
  )
  const cornerSide = preferCornerBoundaryVia ? getCornerSide(bus) : undefined
  const boundaryViaCandidates = [1, 2, 3, 4, 5].flatMap((multiple) => {
    const inset = multiple * insetStep
    const straight = finalTracks.map((finalTrack) =>
      makePoint({
        axis: boundaryExitAxis - directionSign(boundaryDirection) * inset,
        perpendicularAxis: finalTrack,
        direction: boundaryDirection,
      }),
    )
    if (!cornerSide) return [straight]
    // Approach corner exits diagonally to leave the adjacent pair's tuning
    // lane free of the through-via barrel. Retain the straight fallback.
    return [
      finalTracks.map((finalTrack) =>
        makePoint({
          axis: boundaryExitAxis - directionSign(boundaryDirection) * inset,
          perpendicularAxis:
            finalTrack + (cornerSide === "maximum" ? inset : -inset),
          direction: boundaryDirection,
        }),
      ),
      straight,
    ]
  })
  const sourceCenter = {
    x:
      bus.connections.reduce(
        (sum, connection) => sum + connection.sourcePoint.x,
        0,
      ) / bus.connections.length,
    y:
      bus.connections.reduce(
        (sum, connection) => sum + connection.sourcePoint.y,
        0,
      ) / bus.connections.length,
  }
  const directions = [
    { x: -1, y: 0, distance: sourceCenter.x - Math.min(...bus.xCoordinates) },
    { x: 1, y: 0, distance: Math.max(...bus.xCoordinates) - sourceCenter.x },
    { x: 0, y: -1, distance: sourceCenter.y - Math.min(...bus.yCoordinates) },
    { x: 0, y: 1, distance: Math.max(...bus.yCoordinates) - sourceCenter.y },
  ].toSorted((first, second) => first.distance - second.distance)
  const displacedViaCandidates =
    bus.connections.length === 2
      ? directions.flatMap((direction) =>
          [3].map((multiple) =>
            bus.connections.map((connection) => {
              const original = fixedViaPointsByConnectionIndex.get(
                connection.connectionIndex,
              )!
              return {
                x: original.x + direction.x * multiple * bus.pitchX,
                y: original.y + direction.y * multiple * bus.pitchY,
              }
            }),
          ),
        )
      : []
  const matchedVias = bus.connections.map(
    (connection) =>
      fixedViaPointsByConnectionIndex.get(connection.connectionIndex)!,
  )
  const packageEdgeViaCandidates = [
    {
      distance: sourceCenter.x - bus.componentBounds.minX,
      axis: "x" as const,
      value: bus.componentBounds.minX - 2 * insetStep,
    },
    {
      distance: bus.componentBounds.maxX - sourceCenter.x,
      axis: "x" as const,
      value: bus.componentBounds.maxX + 2 * insetStep,
    },
    {
      distance: sourceCenter.y - bus.componentBounds.minY,
      axis: "y" as const,
      value: bus.componentBounds.minY - 2 * insetStep,
    },
    {
      distance: bus.componentBounds.maxY - sourceCenter.y,
      axis: "y" as const,
      value: bus.componentBounds.maxY + 2 * insetStep,
    },
  ]
    .toSorted((a, b) => a.distance - b.distance)
    .flatMap(({ axis, value }) => {
      const otherAxis = axis === "x" ? "y" : "x"
      const mean =
        matchedVias.reduce((sum, via) => sum + via[otherAxis], 0) /
        matchedVias.length
      const order = matchedVias
        .map((via, index) => ({ index, track: via[otherAxis] }))
        .toSorted((a, b) => a.track - b.track || a.index - b.index)
      const pitch = viaDiameter + clearance
      const points = matchedVias.map((via, index) => ({
        ...via,
        [axis]: value,
        [otherAxis]:
          order.length === 2 &&
          Math.abs(order[1]!.track - order[0]!.track) < pitch
            ? mean + (order.findIndex((v) => v.index === index) - 0.5) * pitch
            : via[otherAxis],
      }))
      return points.length === 2 ? [points, [points[1]!, points[0]!]] : [points]
    })
  const preferPackageEdgeVias =
    bus.connections.length === 2 && Boolean(getCornerSide(bus))
  const viaCandidates = [
    ...(preferPackageEdgeVias ? packageEdgeViaCandidates : []).map(
      (points) => ({
        points,
        boundarySide: false,
      }),
    ),
    ...displacedViaCandidates.map((points) => ({
      points,
      boundarySide: false,
    })),
    ...boundaryViaCandidates.map((points) => ({
      points,
      boundarySide: true,
    })),
    // Preserve existing centered and singleton escapes before trying a short
    // source-layer route beyond the package. The target layer can then wind to the exit
    // without a local via being fenced in by an already-routed wide bus.
    ...(!preferPackageEdgeVias ? packageEdgeViaCandidates : []).map(
      (points) => ({
        points,
        boundarySide: false,
      }),
    ),
  ]
  return viaCandidates
}

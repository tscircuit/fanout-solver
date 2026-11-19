import type { Point2D } from "../types"
import { getExpandedPlaneSourcePaths } from "./get-expanded-plane-source-paths"
import {
  directionSign,
  getAxis,
  getDirectionalPitch,
  getExitAxis,
  getPerpendicularAxis,
  getPerpendicularPitch,
  makePoint,
} from "./directions"
import {
  chamferOrthogonalCorners,
  getInitialViaPoint,
  getStraightOr45ConnectorVariants,
} from "./source-escape"
import type { BuildPlanParams, RouteBusParams } from "./types"

export function getPlaneSourceEscapePaths(
  {
    preparedConnection,
    viaHandedness,
    candidateTier = "ordinary",
    collectingAlternatives = false,
  }: Pick<BuildPlanParams, "preparedConnection" | "viaHandedness"> & {
    candidateTier?: "ordinary" | "expanded"
    collectingAlternatives?: boolean
  },
  route: RouteBusParams,
): Iterable<Point2D[]> {
  const {
    bus: directionalBus,
    targetLayer,
    traceWidth,
    viaDiameter,
    clearance,
  } = route
  if (candidateTier === "expanded") {
    return getExpandedPlaneSourcePaths(
      { connection: preparedConnection, collectingAlternatives },
      route,
    )
  }
  const direction = directionalBus.direction
  const adjacentViaPoint = getInitialViaPoint({
    preparedConnection,
    bus: directionalBus,
    targetLayer,
    traceWidth,
    viaDiameter,
    clearance,
    viaHandedness,
  })
  const directionPitch = getDirectionalPitch(directionalBus)
  const sign = directionSign(direction)
  const boundaryAxis = getExitAxis(directionalBus, direction)
  const availableTravel =
    sign * (boundaryAxis - getAxis(adjacentViaPoint, direction)) -
    (viaDiameter / 2 + clearance)
  const maximumEscapeSteps = Math.max(
    0,
    Math.floor(availableTravel / directionPitch),
  )
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const adjacentAxis = getAxis(adjacentViaPoint, direction)
  const adjacentPerpendicularAxis = getPerpendicularAxis(
    adjacentViaPoint,
    direction,
  )
  const perpendicularPitch = getPerpendicularPitch(directionalBus)
  const sourceEscapePaths: Point2D[][] = []
  const maximumCandidatePaths = 128
  for (
    let totalSteps = 0;
    totalSteps <= maximumEscapeSteps &&
    sourceEscapePaths.length < maximumCandidatePaths;
    totalSteps++
  ) {
    const straightViaPoint = makePoint({
      axis: adjacentAxis + sign * totalSteps * directionPitch,
      perpendicularAxis: adjacentPerpendicularAxis,
      direction,
    })
    if (totalSteps === 0) {
      sourceEscapePaths.push([sourcePoint, adjacentViaPoint])
    } else {
      for (const connector of getStraightOr45ConnectorVariants(
        sourcePoint,
        straightViaPoint,
      )) {
        sourceEscapePaths.push(connector)
        if (sourceEscapePaths.length >= maximumCandidatePaths) break
      }
      if (sourceEscapePaths.length < maximumCandidatePaths) {
        sourceEscapePaths.push([
          sourcePoint,
          adjacentViaPoint,
          straightViaPoint,
        ])
      }
    }

    for (
      let lateralSteps = 1;
      lateralSteps <= Math.min(3, totalSteps - 1) &&
      sourceEscapePaths.length < maximumCandidatePaths;
      lateralSteps++
    ) {
      const outwardSteps = totalSteps - lateralSteps
      if (outwardSteps < 1 || outwardSteps > maximumEscapeSteps) {
        continue
      }
      for (const lateralSign of [-1, 1] as const) {
        const lateralAxis =
          adjacentPerpendicularAxis +
          lateralSign * lateralSteps * perpendicularPitch
        const lateralPoint = makePoint({
          axis: adjacentAxis,
          perpendicularAxis: lateralAxis,
          direction,
        })
        const outwardPoint = makePoint({
          axis: adjacentAxis + sign * outwardSteps * directionPitch,
          perpendicularAxis: adjacentPerpendicularAxis,
          direction,
        })
        const detourViaPoint = makePoint({
          axis: adjacentAxis + sign * outwardSteps * directionPitch,
          perpendicularAxis: lateralAxis,
          direction,
        })
        const chamfer = Math.min(directionPitch, perpendicularPitch) * 0.2
        for (const connector of getStraightOr45ConnectorVariants(
          sourcePoint,
          detourViaPoint,
        )) {
          sourceEscapePaths.push(connector)
          if (sourceEscapePaths.length >= maximumCandidatePaths) break
        }
        if (sourceEscapePaths.length >= maximumCandidatePaths) break
        sourceEscapePaths.push(
          chamferOrthogonalCorners(
            [sourcePoint, adjacentViaPoint, lateralPoint, detourViaPoint],
            chamfer,
          ),
          chamferOrthogonalCorners(
            [sourcePoint, adjacentViaPoint, outwardPoint, detourViaPoint],
            chamfer,
          ),
        )
        if (sourceEscapePaths.length >= maximumCandidatePaths) break
      }
    }
  }
  return sourceEscapePaths
}

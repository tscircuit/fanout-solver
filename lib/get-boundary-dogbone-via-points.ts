import {
  type DogboneViaSiteGeometryRules,
  getComponentDogboneViaSiteCandidates,
} from "./match-component-dogbone-via-sites"
import type { Point2D, PreparedBus, PreparedConnection } from "./types"

const EPSILON = 1e-9

export function* getBoundaryDogboneViaPoints({
  bus,
  preparedConnection,
  targetLayer,
  rules,
}: {
  bus: PreparedBus
  preparedConnection: PreparedConnection
  targetLayer: string
  rules: DogboneViaSiteGeometryRules
}): Generator<Point2D> {
  if (targetLayer === preparedConnection.sourceLayer) return

  // Sparse BGAs can omit a neighboring ball. Search one pitch around the
  // source, using the existing matcher to validate each proposed barrel/stub.
  const source = preparedConnection.sourcePoint
  const neighboringX = bus.xCoordinates.filter(
    (x) => Math.abs(x - source.x) <= bus.pitchX + EPSILON,
  )
  const neighboringY = bus.yCoordinates.filter(
    (y) => Math.abs(y - source.y) <= bus.pitchY + EPSILON,
  )
  for (const x of neighboringX) {
    for (const y of neighboringY) {
      const deltaX = Math.abs(x - source.x)
      const deltaY = Math.abs(y - source.y)
      if (deltaX <= EPSILON && deltaY <= EPSILON) continue
      if (
        deltaX > EPSILON &&
        deltaY > EPSILON &&
        Math.abs(deltaX - deltaY) > EPSILON
      )
        continue
      if (
        bus.componentObstacles.some(
          (obstacle) =>
            Math.abs(obstacle.center.x - x) <= EPSILON &&
            Math.abs(obstacle.center.y - y) <= EPSILON,
        )
      )
        continue
      const candidates = getComponentDogboneViaSiteCandidates(
        [{ ...bus, connections: [preparedConnection] }],
        {
          ...rules,
          fixedViaPointsByConnectionIndex: new Map([
            [preparedConnection.connectionIndex, { x, y }],
          ]),
        },
      )
      for (const candidate of candidates) yield candidate.point
    }
  }
}

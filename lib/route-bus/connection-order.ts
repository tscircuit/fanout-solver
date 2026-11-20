import type { PreparedBus, PreparedConnection } from "../types"
import {
  directionSign,
  getAxis,
  getDirectionalPitch,
  getPerpendicularAxis,
  isHorizontal,
} from "./directions"

export function getDepthInRows(bus: PreparedBus): number {
  const directionalCoordinates = (
    isHorizontal(bus.direction) ? bus.xCoordinates : bus.yCoordinates
  ).toSorted((a, b) => a - b)
  const averageDirectionalSource =
    bus.connections.reduce(
      (sum, candidate) => sum + getAxis(candidate.sourcePoint, bus.direction),
      0,
    ) / bus.connections.length
  const outwardCoordinate =
    directionSign(bus.direction) > 0
      ? directionalCoordinates.at(-1)!
      : directionalCoordinates[0]!

  return (
    Math.abs(outwardCoordinate - averageDirectionalSource) /
    getDirectionalPitch(bus)
  )
}

export function busIsOnOutwardComponentEdge(bus: PreparedBus): boolean {
  const directionalCoordinates = isHorizontal(bus.direction)
    ? bus.xCoordinates
    : bus.yCoordinates
  const averageDirectionalSource =
    bus.connections.reduce(
      (sum, connection) => sum + getAxis(connection.sourcePoint, bus.direction),
      0,
    ) / bus.connections.length
  const outwardCoordinate =
    directionSign(bus.direction) > 0
      ? Math.max(...directionalCoordinates)
      : Math.min(...directionalCoordinates)
  return Math.abs(averageDirectionalSource - outwardCoordinate) < 1e-6
}

export function getConnectionRank(
  bus: PreparedBus,
  connection: PreparedConnection,
): number {
  const connectionRank = [...bus.connections]
    .sort(
      (a, b) =>
        getPerpendicularAxis(a.sourcePoint, bus.direction) -
        getPerpendicularAxis(b.sourcePoint, bus.direction),
    )
    .findIndex(
      (candidate) => candidate.connectionIndex === connection.connectionIndex,
    )
  if (connectionRank < 0) {
    throw new Error(
      `FanoutSolver: connection "${connection.connection.name}" is missing from bus "${bus.busId}"`,
    )
  }
  return connectionRank
}

export function getConnectionOrders(bus: PreparedBus): PreparedConnection[][] {
  const sign = directionSign(bus.direction)
  const outwardFirst = [...bus.connections].sort((a, b) => {
    const directionalDifference =
      sign *
      (getAxis(b.sourcePoint, bus.direction) -
        getAxis(a.sourcePoint, bus.direction))
    if (Math.abs(directionalDifference) > 1e-6) {
      return directionalDifference
    }
    return (
      getPerpendicularAxis(a.sourcePoint, bus.direction) -
      getPerpendicularAxis(b.sourcePoint, bus.direction)
    )
  })
  const perpendicularFirst = [...bus.connections].sort(
    (a, b) =>
      getPerpendicularAxis(a.sourcePoint, bus.direction) -
        getPerpendicularAxis(b.sourcePoint, bus.direction) ||
      sign *
        (getAxis(b.sourcePoint, bus.direction) -
          getAxis(a.sourcePoint, bus.direction)),
  )
  const orders = [
    outwardFirst,
    [...outwardFirst].reverse(),
    perpendicularFirst,
    [...perpendicularFirst].reverse(),
  ]
  for (let offset = 1; offset < Math.min(outwardFirst.length, 8); offset++) {
    orders.push([
      ...outwardFirst.slice(offset),
      ...outwardFirst.slice(0, offset),
    ])
  }
  const seenOrders = new Set<string>()
  return orders.filter((order) => {
    const orderKey = order
      .map((connection) => connection.connectionIndex)
      .join(",")
    if (seenOrders.has(orderKey)) return false
    seenOrders.add(orderKey)
    return true
  })
}

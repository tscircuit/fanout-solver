import type { PreparedBus } from "./types"

const EPSILON = 1e-9

/**
 * A failed arc-consistency chain ends with the domain that removed the last
 * supported candidate. When that plane pad has an adjacent peer farther into
 * the component, reserving the peer keeps the outer pad available for a
 * displaced route while protecting the same local dogbone corridor.
 */
export function refineAdaptivePlaneReservationCore(params: {
  candidateBusIds: readonly string[]
  activeBusIds: ReadonlySet<string>
  planeBuses: readonly PreparedBus[]
}): string[] {
  const core = params.candidateBusIds.filter(
    (busId) => !params.activeBusIds.has(busId),
  )
  if (core.length < 2) return core

  const terminalIndex = core.length - 1
  const terminal = params.planeBuses.find(
    (bus) => bus.busId === core[terminalIndex],
  )
  const source = terminal?.connections[0]?.sourcePoint
  if (
    !terminal ||
    !source ||
    terminal.connections.length !== 1 ||
    terminal.termination.type !== "plane"
  )
    return core
  const terminalLayer = terminal.termination.layer

  const perpendicularAxis =
    terminal.direction === "up" || terminal.direction === "down" ? "x" : "y"
  const parallelAxis = perpendicularAxis === "x" ? "y" : "x"
  const componentCoordinates =
    perpendicularAxis === "x" ? terminal.xCoordinates : terminal.yCoordinates
  const pitch = perpendicularAxis === "x" ? terminal.pitchX : terminal.pitchY
  if (
    componentCoordinates.length === 0 ||
    !Number.isFinite(pitch) ||
    pitch <= EPSILON
  ) {
    return core
  }

  const componentCenter =
    (Math.min(...componentCoordinates) + Math.max(...componentCoordinates)) / 2
  const inwardSign = Math.sign(componentCenter - source[perpendicularAxis])
  if (inwardSign === 0) return core

  const coreIds = new Set(core)
  const replacement = params.planeBuses
    .filter((bus) => {
      const candidateSource = bus.connections[0]?.sourcePoint
      if (
        bus === terminal ||
        bus.componentId !== terminal.componentId ||
        bus.termination.type !== "plane" ||
        bus.termination.layer !== terminalLayer ||
        bus.direction !== terminal.direction ||
        bus.connections.length !== 1 ||
        !candidateSource ||
        params.activeBusIds.has(bus.busId) ||
        coreIds.has(bus.busId) ||
        Math.abs(candidateSource[parallelAxis] - source[parallelAxis]) > EPSILON
      ) {
        return false
      }
      const inwardDistance =
        (candidateSource[perpendicularAxis] - source[perpendicularAxis]) *
        inwardSign
      return inwardDistance > EPSILON && inwardDistance <= pitch + EPSILON
    })
    .toSorted((first, second) => {
      const firstSource = first.connections[0]!.sourcePoint
      const secondSource = second.connections[0]!.sourcePoint
      return (
        Math.abs(firstSource[perpendicularAxis] - source[perpendicularAxis]) -
          Math.abs(
            secondSource[perpendicularAxis] - source[perpendicularAxis],
          ) ||
        first.connections[0]!.connectionIndex -
          second.connections[0]!.connectionIndex
      )
    })[0]

  if (!replacement) return core
  return core.map((busId, index) =>
    index === terminalIndex ? replacement.busId : busId,
  )
}

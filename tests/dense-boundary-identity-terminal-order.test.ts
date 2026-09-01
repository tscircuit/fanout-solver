import { expect, test } from "bun:test"
import {
  assignRemappedExitPointsPreservingBusTargetOrder,
  projectPointToBoundaryExitEdge,
  routeIdentityTerminalsBeforeRemaps,
} from "../lib/fanout-solver"

type Terminal = { id: string }

test("projects bundled terminal tracks onto the exact declared boundary edge", () => {
  const boundary = { minX: -2, maxX: 3, minY: -5, maxY: 7 }
  const point = { x: 1.25, y: -0.75 }

  expect(
    projectPointToBoundaryExitEdge({ point, exitEdge: "left", boundary }),
  ).toEqual({ x: -2, y: -0.75 })
  expect(
    projectPointToBoundaryExitEdge({ point, exitEdge: "right", boundary }),
  ).toEqual({ x: 3, y: -0.75 })
  expect(
    projectPointToBoundaryExitEdge({ point, exitEdge: "top", boundary }),
  ).toEqual({ x: 1.25, y: 7 })
  expect(
    projectPointToBoundaryExitEdge({ point, exitEdge: "bottom", boundary }),
  ).toEqual({ x: 1.25, y: -5 })
})

test("preserves each bus target rank inside a source-ordered grouped remap", () => {
  const makeConnection = (connectionIndex: number, targetY: number) => ({
    connectionIndex,
    targetPoint: { x: 3, y: targetY },
  })
  const dmi1 = makeConnection(16, 2.387192121212122)
  const dqs1Low = makeConnection(14, 1.382072121212122)
  const dqs1High = makeConnection(15, 1.884632121212122)
  const clockLow = makeConnection(8, -1.6332878787878782)
  const clockHigh = makeConnection(9, -1.1307278787878783)
  const dqs0Low = makeConnection(18, 3.3923121212121217)
  const dqs0High = makeConnection(19, 3.8948721212121216)
  const dmi0 = makeConnection(17, 2.8897521212121218)
  const groupedBuses = [
    { connections: [dqs1Low, dqs1High] },
    { connections: [clockLow, clockHigh] },
    { connections: [dqs0High, dqs0Low] },
    { connections: [dmi0] },
    { connections: [dmi1] },
  ]
  const sourceOrderedConnections = [
    dmi1,
    dqs1High,
    dqs1Low,
    clockHigh,
    clockLow,
    dqs0Low,
    dqs0High,
    dmi0,
  ]
  const orderedExitPoints = [
    -1.6332878787878782, -1.1307278787878783, 1.382072121212122,
    1.884632121212122, 2.387192121212122, 2.8897521212121218,
    3.3923121212121217, 3.8948721212121216,
  ].map((y) => ({ x: 3, y }))

  const exitPointByConnectionIndex =
    assignRemappedExitPointsPreservingBusTargetOrder({
      sourceOrderedConnections,
      groupedBuses,
      orderedExitPoints,
      tangentAxis: "y",
    })
  const exitY = (connection: (typeof sourceOrderedConnections)[number]) =>
    exitPointByConnectionIndex.get(connection.connectionIndex)!.y

  expect(exitY(dqs1Low)).toBeLessThan(exitY(dqs1High))
  expect(exitY(clockLow)).toBeLessThan(exitY(clockHigh))
  expect(exitY(dqs0Low)).toBeLessThan(exitY(dqs0High))
  expect(exitY(dqs1High)).toBeLessThan(exitY(clockLow))
  expect(exitY(clockHigh)).toBeLessThan(exitY(dqs0Low))
  expect(exitY(dmi0)).toBeGreaterThan(exitY(dqs0High))
})

test("routes literal identity terminals before constructing remaps", () => {
  const identityTerminals: Terminal[] = [{ id: "identity" }]
  const identityBudget = { remaining: 10 }
  let remapsWereConstructed = false
  const result = routeIdentityTerminalsBeforeRemaps({
    identityTerminals,
    identityBudget,
    createRemapBudget: () => ({ remaining: 10 }),
    getRemappedTerminalCandidates: () => {
      remapsWereConstructed = true
      return [[{ id: "remapped" }]]
    },
    route: (terminals, budget) => {
      expect(terminals).toBe(identityTerminals)
      expect(budget).toBe(identityBudget)
      budget.remaining -= 3
      return ["routed"]
    },
  })

  expect(remapsWereConstructed).toBe(false)
  expect(result).toEqual({
    selectedTerminals: identityTerminals,
    alternatives: ["routed"],
    consumedStates: 3,
  })
})

test("gives remapped terminals an independent bounded search pool", () => {
  const identityTerminals: Terminal[] = [{ id: "identity" }]
  const firstRemap: Terminal[] = [{ id: "first-remap" }]
  const secondRemap: Terminal[] = [{ id: "second-remap" }]
  const identityBudget = { remaining: 10 }
  const remapBudget = { remaining: 6 }
  const calls: Array<{
    terminals: Terminal[]
    budget: { remaining: number }
    initialRemaining: number
  }> = []
  const result = routeIdentityTerminalsBeforeRemaps({
    identityTerminals,
    identityBudget,
    createRemapBudget: (identityConsumedStates) => {
      expect(identityConsumedStates).toBe(4)
      return remapBudget
    },
    getRemappedTerminalCandidates: () => [firstRemap, secondRemap],
    route: (terminals, budget) => {
      calls.push({
        terminals,
        budget,
        initialRemaining: budget.remaining,
      })
      if (terminals === identityTerminals) {
        budget.remaining -= 4
        return []
      }
      if (terminals === firstRemap) {
        budget.remaining -= 2
        return []
      }
      budget.remaining -= 1
      return ["routed"]
    },
  })

  expect(calls.map((call) => call.terminals)).toEqual([
    identityTerminals,
    firstRemap,
    secondRemap,
  ])
  expect(calls.map((call) => call.initialRemaining)).toEqual([10, 6, 4])
  expect(calls[0]!.budget).toBe(identityBudget)
  expect(calls[1]!.budget).toBe(remapBudget)
  expect(calls[2]!.budget).toBe(remapBudget)
  expect(result).toEqual({
    selectedTerminals: secondRemap,
    alternatives: ["routed"],
    consumedStates: 7,
  })
})

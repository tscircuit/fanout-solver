import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus, type RouteBusStaticClearanceCache } from "lib/route-bus"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("plane candidates retain explicit headings across a warm clearance cache", () => {
  const { input, options } = createTwoViaWindows()
  const solver = new FanoutSolver(input, options)
  const bus = solver.preparedBuses.find((bus) => bus.busId === "ground")
  if (!bus) throw new Error("Expected the declared ground plane bus")
  expect(bus.requestedDirection).toBe("left")
  const overridden = new FanoutSolver(input, {
    ...options,
    busDirections: { ground: "right" },
  })
  expect(
    overridden.preparedBuses.find((bus) => bus.busId === "ground")
      ?.requestedDirection,
  ).toBe("right")
  const staticClearanceCache: RouteBusStaticClearanceCache = new Map()
  const source = { x: 0, y: 0 }
  const via = { x: -0.24, y: 0.3 }
  const params = {
    ...solver.config,
    srj: input,
    bus,
    targetLayer: "inner1",
    acceptedPlans: [],
    staticClearanceCache,
    fixedViaPointsByConnectionIndex: new Map([
      [bus.connections[0]!.connectionIndex, via],
    ]),
    sourceEscapePaths: new Map([
      [
        bus.connections[0]!.connectionIndex,
        [source, { x: -0.24, y: 0.24 }, via],
      ],
    ]),
  }
  expect(routeBus(params)).toHaveLength(1)
  expect(
    routeBus({ ...params, bus: { ...bus, requestedDirection: "right" } }),
  ).toBeNull()
  expect(
    routeBus({
      ...params,
      sourceEscapePaths: new Map([
        [bus.connections[0]!.connectionIndex, [source, { x: 0, y: 0.3 }, via]],
      ]),
    }),
  ).toBeNull()
  expect(
    routeBus({ ...params, bus: { ...bus, requestedDirection: undefined } }),
  ).toHaveLength(1)
})

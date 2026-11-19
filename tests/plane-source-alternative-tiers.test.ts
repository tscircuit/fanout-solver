import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus, routeBusAlternatives } from "lib/route-bus"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("plane alternatives preserve every legacy candidate before neighboring sites", () => {
  const { input, options } = createTwoViaWindows()
  const solver = new FanoutSolver(input, options)
  const ground = solver.preparedBuses.find((bus) => bus.busId === "ground")
  if (!ground) throw new Error("Expected the ground plane request")
  const params = {
    ...solver.config,
    srj: input,
    bus: ground,
    targetLayer: "inner1",
    acceptedPlans: [],
  }
  const winner = routeBus(params)
  expect(winner?.[0]!.via?.center).toEqual({ x: 0.3, y: 0 })
  for (const maximumAlternatives of [1, 2, 4]) {
    const alternatives = routeBusAlternatives(params, maximumAlternatives)
    expect(alternatives.map((plans) => plans[0]!.trace.route)).toEqual(
      Array.from(
        { length: maximumAlternatives },
        () => winner![0]!.trace.route,
      ),
    )
  }
  const expanded = routeBusAlternatives(params, 5)
  expect(expanded).toHaveLength(5)
  expect(expanded[4]![0]!.via?.center).toEqual({ x: -0.24, y: 0.3 })

  const openInput = {
    ...input,
    obstacles: input.obstacles.filter(
      (obstacle) => obstacle.componentId === "U1",
    ),
  }
  const openSolver = new FanoutSolver(openInput, options)
  const openGround = openSolver.preparedBuses.find(
    (bus) => bus.busId === "ground",
  )
  if (!openGround) throw new Error("Expected the open ground plane request")
  const legacy = routeBusAlternatives(
    { ...params, srj: openInput, bus: openGround },
    8,
  )
  expect(
    legacy.map(([plan]) => {
      if (!plan) throw new Error("Expected a complete plane candidate")
      const viaIndex = plan.trace.route.findIndex(
        (point) => point.route_type === "via",
      )
      return plan.trace.route
        .slice(0, viaIndex)
        .filter((point) => point.route_type === "wire")
        .map((point) => [Math.round(point.x * 1e6) / 1e6, point.y])
    }),
  ).toEqual([
    [
      [0, 0],
      [-0.3, 0],
    ],
    [
      [0, 0],
      [-0.9, 0],
    ],
    [
      [0, 0],
      [-0.3, 0],
      [-0.9, 0],
    ],
    [
      [0, 0],
      [-0.3, 0],
    ],
    [
      [0, 0],
      [-0.9, 0],
    ],
    [
      [0, 0],
      [-0.3, 0],
      [-0.9, 0],
    ],
    [
      [0, 0],
      [-0.3, 0],
    ],
    [
      [0, 0],
      [-0.9, 0],
    ],
  ])
})

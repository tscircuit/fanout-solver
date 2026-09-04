import { expect, test } from "bun:test"
import {
  iterateUniqueRouteOrders,
  type RouteViaMinimalWindingParams,
  routeViaMinimalWindingAlternativesSteps,
} from "lib/route-via-minimal-winding"

test("bounded route-order iteration is lazy and preserves dedupe order", () => {
  const factoryCalls: string[] = []
  const createOrder = (label: string, order: string[]) => () => {
    factoryCalls.push(label)
    return order
  }
  const rotationBase = ["A", "B", "C", "D"]
  const boundedOrders = [
    ...iterateUniqueRouteOrders({
      initialOrderFactories: [
        createOrder("target", rotationBase),
        createOrder("duplicate", [...rotationBase]),
        createOrder("reverse", [...rotationBase].reverse()),
        createOrder("unreachable", ["A", "C", "B", "D"]),
      ],
      rotationBase,
      getItemKey: (item) => item,
      maximumOrderCount: 2,
    }),
  ]

  expect(boundedOrders).toEqual([
    ["A", "B", "C", "D"],
    ["D", "C", "B", "A"],
  ])
  expect(factoryCalls).toEqual(["target", "duplicate", "reverse"])

  const allOrders = [
    ...iterateUniqueRouteOrders({
      initialOrderFactories: [
        () => rotationBase,
        () => [...rotationBase].reverse(),
        () => [...rotationBase],
      ],
      rotationBase,
      getItemKey: (item) => item,
    }),
  ]
  expect(allOrders).toEqual([
    ["A", "B", "C", "D"],
    ["D", "C", "B", "A"],
    ["B", "C", "D", "A"],
    ["C", "D", "A", "B"],
    ["D", "A", "B", "C"],
  ])
})

test("winding search expansion limits must be positive integers", () => {
  for (const maximumExpandedStateCount of [0, -1, 1.5]) {
    const steps = routeViaMinimalWindingAlternativesSteps(
      {
        maximumExpandedStateCount,
      } as unknown as RouteViaMinimalWindingParams,
      1,
    )
    expect(() => steps.next()).toThrow(
      "maximumExpandedStateCount must be a positive integer",
    )
  }
})

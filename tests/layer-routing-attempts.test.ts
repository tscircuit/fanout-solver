import { expect, test } from "bun:test"
import { LayerRoutingAttempts } from "lib/layer-routing-attempts"

test("layer retries preserve the first successful choice and distinguish topology from length failures", () => {
  const options = {
    wideSingleLayer: false,
    firstRipCost: 64,
    transitLayers: [],
    allTransitLayers: ["top"],
  }
  const successful = new LayerRoutingAttempts(options)
  expect(successful.next()).toEqual({
    ripCost: 64,
    shuffleSeed: 1,
    transitLayers: [],
  })
  expect(successful.next()).toBeUndefined()
  for (const reason of ["routing", "lengths"] as const) {
    const queue = new LayerRoutingAttempts(options)
    const first = queue.next()!
    queue.failed(first, reason)
    const retry = queue.next()!
    expect(retry).toEqual({
      ripCost: reason === "routing" ? 64 : 8,
      shuffleSeed: 1,
      transitLayers: ["top"],
    })
    queue.failed(retry, reason)
    if (reason === "routing") {
      const costRetry = queue.next()!
      expect(costRetry).toEqual({ ...retry, ripCost: 256 })
      queue.failed(costRetry, reason)
    }
    expect(queue.next()).toBeUndefined()
  }
  const constrained = new LayerRoutingAttempts({
    ...options,
    wideSingleLayer: true,
    allTransitLayers: [],
  })
  const original = constrained.next()!
  constrained.failed(original, "lengths")
  const lengthRetry = constrained.next()!
  expect(lengthRetry).toEqual({ ...original, ripCost: 256 })
  constrained.failed(lengthRetry, "routing")
  const orderingRetry = constrained.next()!
  expect(orderingRetry).toEqual({ ...original, shuffleSeed: 2 })
  constrained.failed(orderingRetry, "lengths")
  expect(constrained.next()).toBeUndefined()
  const topology = new LayerRoutingAttempts({
    ...options,
    wideSingleLayer: true,
    allTransitLayers: [],
  })
  const first = topology.next()!
  topology.failed(first, "routing")
  expect(topology.next()).toEqual({ ...first, shuffleSeed: 2 })
  const transitFirst = new LayerRoutingAttempts({
    ...options,
    preferSourceTransit: true,
  })
  const lowCost = transitFirst.next()!
  expect(lowCost).toEqual({
    ripCost: 8,
    shuffleSeed: 1,
    transitLayers: ["top"],
  })
  transitFirst.failed(lowCost, "lengths")
  const fallback = transitFirst.next()!
  expect(fallback).toEqual({ ripCost: 64, shuffleSeed: 1, transitLayers: [] })
  transitFirst.failed(fallback, "lengths")
  expect(transitFirst.next()).toBeUndefined()
})

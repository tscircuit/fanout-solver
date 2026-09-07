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
  const coherentTransit = new LayerRoutingAttempts({
    ...options,
    preferSourceTransit: true,
    sourceTransitRipCost: 64,
  })
  const coherentFirst = coherentTransit.next()!
  expect(coherentFirst).toEqual({
    ripCost: 64,
    shuffleSeed: 1,
    transitLayers: ["top"],
  })
  coherentTransit.failed(coherentFirst, "lengths")
  const coherentFallback = coherentTransit.next()!
  expect(coherentFallback).toEqual({
    ripCost: 64,
    shuffleSeed: 1,
    transitLayers: [],
  })
  coherentTransit.failed(coherentFallback, "routing")
  const finalCost = coherentTransit.next()!
  expect(finalCost).toEqual({
    ripCost: 256,
    shuffleSeed: 1,
    transitLayers: ["top"],
  })
  coherentTransit.failed(finalCost, "routing")
  expect(coherentTransit.next()).toBeUndefined()
  const coherentOrigin = new LayerRoutingAttempts({
    ...options,
    preferSourceOrigin: true,
    sourceOriginRipCost: 64,
  })
  const joint = coherentOrigin.next()!
  expect(joint).toEqual({
    ripCost: 64,
    shuffleSeed: 1,
    transitLayers: [],
    routeFromSourcePads: true,
  })
  coherentOrigin.failed(joint, "lengths")
  expect(coherentOrigin.next()).toEqual({
    ripCost: 64,
    shuffleSeed: 1,
    transitLayers: [],
  })
  expect(coherentOrigin.next()).toBeUndefined()
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
  for (const failure of ["routing", "lengths"] as const) {
    const physical = new LayerRoutingAttempts({
      ...options,
      wideSingleLayer: true,
      allTransitLayers: [],
      retrySourceOriginPhysicalGridPhase: true,
    })
    const original = physical.next()!
    expect(original).toEqual({ ripCost: 64, shuffleSeed: 1, transitLayers: [] })
    physical.failed(original, "lengths")
    const alternative = physical.next()!
    expect(alternative).toEqual({
      ...original,
      sourceOriginPhysicalGridPhase: true,
    })
    physical.failed(alternative, failure)
    const ordinary = physical.next()!
    expect(ordinary).toEqual({ ...original, ripCost: 256 })
    physical.failed(ordinary, "routing")
    const final = physical.next()!
    expect(final).toEqual({ ...original, shuffleSeed: 2 })
    physical.failed(final, "lengths")
    expect(physical.next()).toBeUndefined()
  }
  for (const firstFailure of ["routing", "lengths"] as const) {
    for (const originalFailure of ["routing", "lengths"] as const) {
      const queue = new LayerRoutingAttempts({
        ...options,
        wideSingleLayer: true,
        allTransitLayers: [],
        preferAlternateOrder: true,
      })
      const preferred = queue.next()!
      expect(preferred).toEqual({
        ripCost: 64,
        shuffleSeed: 2,
        transitLayers: [],
      })
      queue.failed(preferred, firstFailure)
      const original = queue.next()!
      expect(original).toEqual({ ...preferred, shuffleSeed: 1 })
      queue.failed(original, originalFailure)
      if (firstFailure === "lengths" || originalFailure === "lengths") {
        const cost = queue.next()!
        expect(cost).toEqual({ ...original, ripCost: 256 })
        queue.failed(cost, "routing")
      }
      expect(queue.next()).toBeUndefined()
    }
  }
  for (const failure of ["routing", "lengths"] as const) {
    const fresh = new LayerRoutingAttempts({
      ...options,
      wideSingleLayer: true,
      allTransitLayers: [],
      retrySourceOriginFreshReservations: true,
      retrySourceOriginPhysicalGridPhase: true,
    })
    const original = fresh.next()!
    expect(original).toEqual({ ripCost: 64, shuffleSeed: 1, transitLayers: [] })
    expect(fresh.next()).toBeUndefined()
    fresh.failed(original, "lengths")
    const alternative = fresh.next()!
    expect(alternative).toEqual({
      ...original,
      sourceLayerTravelCost: 3,
      reserveFutureApproaches: false,
    })
    fresh.failed(alternative, failure)
    const physical = fresh.next()!
    expect(physical).toEqual({
      ...original,
      sourceOriginPhysicalGridPhase: true,
    })
    fresh.failed(physical, failure)
    const cost = fresh.next()!
    expect(cost).toEqual({ ...original, ripCost: 256 })
    fresh.failed(cost, "routing")
    const order = fresh.next()!
    expect(order).toEqual({ ...original, shuffleSeed: 2 })
    fresh.failed(order, "lengths")
    expect(fresh.next()).toBeUndefined()
  }
  const firstPreferredSuccess = new LayerRoutingAttempts({
    ...options,
    wideSingleLayer: true,
    allTransitLayers: [],
    preferAlternateOrder: true,
  })
  expect(firstPreferredSuccess.next()).toEqual({
    ripCost: 64,
    shuffleSeed: 2,
    transitLayers: [],
  })
  expect(firstPreferredSuccess.next()).toBeUndefined()
})

import { expect, test } from "bun:test"
import "bun-match-svg"
import { routeBusWithNativePlaneRecoverySteps } from "../lib/route-bus-with-native-plane-recovery"

import { fixture } from "./fixtures/native-plane-recovery-fixture"

test("continues an unchanged leading prefix and exposes a physically checked failure frontier", () => {
  const { params } = fixture()
  const first = routeBusWithNativePlaneRecoverySteps(params)
  let original = first.next()
  while (!original.done) original = first.next()
  if (!original.value) throw Error("Expected fixture recovery")
  const recovered = original.value
  const terminals = params.terminals.toSorted(
    (a, b) => a.exitPoint.x - b.exitPoint.x,
  )
  const initialPlans = terminals
    .slice(0, 2)
    .map(
      (t) =>
        recovered.plans.find(
          (p) => p.connectionIndex === t.connection.connectionIndex,
        )!,
    )
  const acceptedPlans = recovered.plans.filter(
    (p) => p.busId !== params.bus.busId,
  )
  const nextParams = {
    ...params,
    acceptedPlans,
    sourceEscapes: recovered.sourceEscapes,
    initialPlans,
  }
  const before = JSON.stringify(nextParams)
  const continuation = routeBusWithNativePlaneRecoverySteps(nextParams)
  let next = continuation.next()
  while (!next.done) next = continuation.next()
  expect(next.value).not.toBeNull()
  for (const plan of initialPlans)
    expect(
      next.value?.plans.find((p) => p.connectionIndex === plan.connectionIndex),
    ).toBe(plan)
  expect(JSON.stringify(nextParams)).toBe(before)
  expect(() =>
    routeBusWithNativePlaneRecoverySteps({
      ...nextParams,
      initialPlans: initialPlans.slice(1),
    }).next(),
  ).toThrow("leading prefix")
  expect(() =>
    routeBusWithNativePlaneRecoverySteps({
      ...nextParams,
      initialPlans: [
        {
          ...initialPlans[0]!,
          targetPoint: { ...initialPlans[0]!.targetPoint, x: 99 },
        },
      ],
    }).next(),
  ).toThrow("unchanged leading prefix")
  const failures: import("../lib/route-bus-with-native-plane-recovery").NativePlaneRecoveryFailure[] =
    []
  const blocked = routeBusWithNativePlaneRecoverySteps({
    ...params,
    srj: {
      ...params.srj,
      obstacles: [
        ...params.srj.obstacles,
        {
          type: "rect",
          center: { x: 0, y: -1.8 },
          width: 4.4,
          height: 0.4,
          layers: ["inner1"],
          connectedTo: [],
        },
      ],
    },
    onFailure: (failure) => failures.push(failure),
  })
  let failure = blocked.next()
  while (!failure.done) failure = blocked.next()
  expect(failure.value).toBeNull()
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({
    kind: "no-blocker",
    blockedConnectionIndex: terminals[0]!.connection.connectionIndex,
    blockerConnectionIndices: [],
    prefixPlans: [],
  })
})

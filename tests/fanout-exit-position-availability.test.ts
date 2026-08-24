import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type {
  FanoutAvailableCornerAndSide,
  FanoutExitPosition,
} from "lib/types"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

test("canonical positions use physical-edge availability", () => {
  const matchingRegions = {
    topside_left: "top_left",
    topside_center: "top_middle",
    topside_right: "top_right",
    rightside_top: "right_top",
    rightside_center: "right_middle",
    rightside_bottom: "right_bottom",
    bottomside_right: "bottom_right",
    bottomside_center: "bottom_middle",
    bottomside_left: "bottom_left",
    leftside_bottom: "left_bottom",
    leftside_center: "left_middle",
    leftside_top: "left_top",
  } satisfies Record<
    Exclude<FanoutExitPosition, "center">,
    FanoutAvailableCornerAndSide
  >

  for (const [exitPosition, availableRegion] of Object.entries(
    matchingRegions,
  ) as Array<
    [Exclude<FanoutExitPosition, "center">, FanoutAvailableCornerAndSide]
  >) {
    const fixture = createSingleSignalFanoutFixture({ exitPosition })
    expect(
      () =>
        new FanoutSolver(fixture.simpleRouteJson, {
          buses: [fixture.bus],
          availableCornersAndSides: [availableRegion],
        }),
    ).not.toThrow()
  }

  const canonicalFixture = createSingleSignalFanoutFixture({
    exitPosition: "rightside_top",
  })
  const permittedSolver = new FanoutSolver(canonicalFixture.simpleRouteJson, {
    buses: [canonicalFixture.bus],
    availableCornersAndSides: ["right_top"],
  })
  expect(permittedSolver.preparedBuses[0]).toMatchObject({
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
  })

  expect(
    () =>
      new FanoutSolver(canonicalFixture.simpleRouteJson, {
        buses: [canonicalFixture.bus],
        availableCornersAndSides: ["top_right"],
      }),
  ).toThrow("cannot use its requested exit with availableCornersAndSides")

  const legacyFixture = createSingleSignalFanoutFixture({
    direction: "up",
    preferredExit: "top-right",
  })
  expect(
    () =>
      new FanoutSolver(legacyFixture.simpleRouteJson, {
        buses: [legacyFixture.bus],
        availableCornersAndSides: ["top_right"],
      }),
  ).not.toThrow()
})

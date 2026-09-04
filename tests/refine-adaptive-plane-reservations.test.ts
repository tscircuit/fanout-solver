import { expect, test } from "bun:test"
import capturedSample from "../datasets/fixtures/fanout31-am62l-top-center.json"
import { prepareFanoutBuses } from "../lib/prepare-buses"
import { refineAdaptivePlaneReservationCore } from "../lib/refine-adaptive-plane-reservations"
import type { FanoutSolver } from "../lib/fanout-solver"

const fixture = capturedSample as unknown as {
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

test("moves the terminal reservation inward to protect the same corridor", () => {
  const planeBuses = prepareFanoutBuses(
    fixture.simpleRouteJson,
    fixture.solverOptions,
  ).filter((bus) => bus.termination.type === "plane")

  expect(
    refineAdaptivePlaneReservationCore({
      candidateBusIds: [
        "U1_VSS_H7_DROP",
        "U1_VSS_F5_DROP",
        "U1_VSS_E6_DROP",
        "U1_VSS_F6_DROP",
        "U1_VSS_G7_DROP",
      ],
      activeBusIds: new Set(planeBuses.slice(0, 8).map((bus) => bus.busId)),
      planeBuses,
    }),
  ).toEqual([
    "U1_VSS_H7_DROP",
    "U1_VSS_F5_DROP",
    "U1_VSS_E6_DROP",
    "U1_VSS_F6_DROP",
    "U1_VSS_G8_DROP",
  ])
})

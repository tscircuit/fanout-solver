import { expect, test } from "bun:test"
import {
  createFanoutPlanClearanceValidator,
  fanoutPlansAreClear,
} from "lib/route-bus"
import { createCapacitorPlaneContact } from "./fixtures/capacitor-plane-contact"

test("cached plane-pour permission never transfers to a signal candidate sharing its segments", () => {
  const { inputSrj, plan, rules } = createCapacitorPlaneContact()
  // Isolate the trace's top-pour permission: a separate via/pour rejection
  // must not conceal reuse of a cached segment result from the wrong policy.
  const clearanceRules = {
    ...rules,
    srj: {
      ...inputSrj,
      obstacles: inputSrj.obstacles.filter(
        (obstacle) => obstacle.obstacleId !== "inner-ground-plane",
      ),
    },
  }
  const signalPlan = { ...plan, termination: { type: "boundary" as const } }
  for (const candidates of [
    [plan, signalPlan],
    [signalPlan, plan],
  ]) {
    const validate = createFanoutPlanClearanceValidator(clearanceRules)
    for (const candidate of candidates) {
      const expected = candidate === plan
      expect(
        fanoutPlansAreClear({ ...clearanceRules, plans: [candidate] }),
      ).toBe(expected)
      expect(validate([candidate])).toBe(expected)
    }
  }
})

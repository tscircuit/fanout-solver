import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import {
  createFanoutPlanClearanceValidator,
  fanoutPlansAreClear,
} from "lib/route-bus"
import { createCapacitorPlaneContact } from "./fixtures/capacitor-plane-contact"

test("plane-pour contact preserves physical pad and foreign or unknown copper clearance across the whole barrel", () => {
  const { inputSrj, plan, rules } = createCapacitorPlaneContact()
  expect(fanoutPlansAreClear({ ...rules, plans: [plan] })).toBe(true)
  const blockers: Obstacle[] = [
    // The logical transition ends on inner1; a through barrel also spans bottom.
    {
      type: "rect",
      obstacleId: "backside-ground-pad",
      componentId: "C2",
      center: { x: 1, y: 0 },
      width: 0.3,
      height: 0.3,
      layers: ["bottom"],
      connectedTo: ["GND"],
    },
    {
      type: "rect",
      obstacleId: "inner4-power-plane",
      isCopperPour: true,
      center: { x: 0, y: 0 },
      width: 6,
      height: 3,
      layers: ["inner4"],
      connectedTo: ["VDD"],
    },
    {
      type: "rect",
      obstacleId: "unidentified-inner-copper",
      isCopperPour: true,
      center: { x: 1, y: 0 },
      width: 0.5,
      height: 0.5,
      layers: ["inner4"],
      connectedTo: [],
    },
    // A matching net permits pour contact, not a stub crossing a physical pad.
    {
      type: "rect",
      obstacleId: "top-ground-pad",
      componentId: "U2",
      center: { x: 0, y: 0 },
      width: 0.4,
      height: 0.8,
      layers: ["top"],
      connectedTo: ["GND"],
    },
    {
      type: "rect",
      obstacleId: "top-power-island",
      isCopperPour: true,
      center: { x: 0, y: 0 },
      width: 0.4,
      height: 0.8,
      layers: ["top"],
      connectedTo: ["VDD"],
    },
  ]
  for (const blocker of blockers) {
    const srj = { ...inputSrj, obstacles: [...inputSrj.obstacles, blocker] }
    expect(fanoutPlansAreClear({ ...rules, srj, plans: [plan] })).toBe(false)
    expect(createFanoutPlanClearanceValidator({ ...rules, srj })([plan])).toBe(
      false,
    )
  }
})

import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus } from "lib/route-bus"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createIcepiSinglePlaneDrop } from "./fixtures/icepi-single-plane-drop"

test("final plane validation retains terminal-pour and physical through-via clearance", (): void => {
  const { routeParams } = createIcepiSinglePlaneDrop()
  const plans = routeBus(routeParams)
  if (!plans?.[0].via) throw new Error("Native plane drop has no through-via")
  const via = plans[0].via
  // Beyond the wire endpoint, inside via clearance but outside wire clearance.
  const blocker: Obstacle = {
    type: "rect",
    center: { x: via.center.x + 0.3, y: via.center.y },
    width: 0.04,
    height: 0.04,
    layers: ["inner1"],
    connectedTo: ["foreign-plane-net"],
  }
  const cases = [
    {
      label: "crossed foreign pour can form an antipad",
      obstacle: { ...blocker, isCopperPour: true },
      valid: true,
    },
    {
      label: "foreign source-layer pour still blocks",
      obstacle: { ...blocker, layers: ["top"], isCopperPour: true },
      valid: false,
    },
    {
      label: "foreign target-layer pour still blocks",
      obstacle: { ...blocker, layers: ["inner2"], isCopperPour: true },
      valid: false,
    },
    {
      label: "real pad beyond the logical transition still blocks",
      obstacle: { ...blocker, layers: ["bottom"] },
      valid: false,
    },
    {
      label: "non-plated through-hole still blocks",
      obstacle: {
        ...blocker,
        center: { x: via.center.x + 0.4, y: via.center.y },
        width: 0.3,
        height: 0.3,
        layers: routeParams.layerNames,
        connectedTo: [],
        isNonPlatedHole: true,
      },
      valid: false,
    },
  ]
  for (const scenario of cases) {
    const inputSrj = {
      ...routeParams.srj,
      obstacles: [...routeParams.srj.obstacles, scenario.obstacle],
    }
    const outputSrj = buildOutputSimpleRouteJson({
      inputSrj,
      plans,
      layerNames: routeParams.layerNames,
    })
    const validation = validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans,
      preparedBuses: [routeParams.bus],
      sharedBoundary: routeParams.bus.sharedBoundary,
      clearance: routeParams.clearance,
      allowBlindAndBuriedVias: false,
    })
    const copperDrc = validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance: routeParams.clearance,
      allowBlindAndBuriedVias: false,
    })
    expect(validation.valid, scenario.label).toBe(scenario.valid)
    expect(copperDrc.valid, scenario.label).toBe(scenario.valid)
    if (!scenario.valid) {
      expect(validation.issues.map((issue) => issue.code)).toEqual([
        "via-obstacle-clearance",
      ])
      expect(copperDrc.issues.map((issue) => issue.code)).toEqual([
        "via-obstacle-clearance",
      ])
    }
  }
})

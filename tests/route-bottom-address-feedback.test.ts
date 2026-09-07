import { expect, test } from "bun:test"
import "bun-match-svg"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareDataset31Samples } from "../benchmarks/prepare-dataset31"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { FanoutSolver } from "../lib/fanout-solver"
import { routeBottomAddressFeedbackSteps } from "../lib/route-bottom-address-feedback"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("derives a complete address breakout from the original BGA input with every source reserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanout-address-feedback-"))
  try {
    const [sample] = await prepareDataset31Samples(
      ["20-rk3308-bottom-center"],
      directory,
    )
    if (!sample) throw Error("Expected original dataset sample")
    const original = JSON.stringify(sample)
    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    while (!solver.layerAssignments.length) solver.step()
    const bus = solver.preparedBuses
      .filter((b) => b.termination.type === "boundary")
      .toSorted((a, b) => b.connections.length - a.connections.length)[0]!
    const assignment = solver.layerAssignments[0]!
    const events: string[] = []
    const run = routeBottomAddressFeedbackSteps({
      ...solver.config,
      srj: sample.simpleRouteJson,
      bus,
      targetLayer: assignment[bus.busId]!,
      preparedBuses: solver.preparedBuses,
      targetLayerByBusId: new Map(Object.entries(assignment)),
      onFeedback: (event) => events.push(event.phase),
    })
    let result = run.next()
    while (!result.done) result = run.next()
    expect(result.value).not.toBeNull()
    if (!result.value) throw Error("Expected complete address recovery")
    const { plans, source } = result.value
    const own = new Set(bus.connections.map((c) => c.connectionIndex))
    const address = plans.filter((p) => own.has(p.connectionIndex))
    expect(address).toHaveLength(bus.connections.length)
    expect(address.every((p) => p.termination.type === "boundary")).toBe(true)
    expect(plans).toHaveLength(sample.simpleRouteJson.connections.length)
    expect(new Set(plans.map((p) => p.connectionIndex)).size).toBe(plans.length)
    expect(source.sourceEscapes).toHaveLength(plans.length)
    expect(events).toContain("perimeter-source")
    expect(events).toContain("neighbor-source")
    expect(events.at(-1)).toBe("complete")
    expect(JSON.stringify(sample)).toBe(original)
    for (const plan of address) {
      const connection = bus.connections.find(
        (c) => c.connectionIndex === plan.connectionIndex,
      )!
      expect(plan.sourcePoint).toEqual(connection.sourcePoint)
      expect(plan.targetPoint).toEqual(connection.targetPoint)
      expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
      expect(plan.exitEdge).toBe(bus.exitEdge)
      expect(plan.via?.spanLayers).toEqual(solver.config.layerNames)
    }
    const output = buildOutputSimpleRouteJson({
      inputSrj: sample.simpleRouteJson,
      plans,
      layerNames: solver.config.layerNames,
    })
    expect(
      validateRoutedCopperDrc({
        inputSrj: sample.simpleRouteJson,
        routedSrj: output,
        clearance: solver.config.clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({
      valid: true,
      checkedTraceCount: plans.length,
      issues: [],
    })
    await expect(
      getSvgFromGraphicsObject(
        visualizeSimpleRouteJson({
          ...sample.simpleRouteJson,
          connections: [],
          traces: plans.map((p) => p.trace),
        }),
      ),
    ).toMatchSvgSnapshot(import.meta.path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("centered fanout separates overlapping targets from different layers", async () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const centeredBus = {
    ...bus,
    direction: "right" as const,
    preferredExit: "right" as const,
  }
  const input = { ...simpleRouteJson, buses: [centeredBus] }
  const solver = new FanoutSolver(input, {
    buses: [centeredBus],
    sharedBoundary,
    escapeLayers: ["inner1"],
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    brokenOutConnectionCount: 4,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const exits = output.fanoutTraces.map((trace) => {
    expect(
      trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(1)
    const exit = trace.route.at(-1)!
    expect(exit).toMatchObject({
      route_type: "wire",
      layer: output.busLayerAssignments.DATA_BUS,
      x: sharedBoundary.maxX,
    })
    if (exit.route_type !== "wire") throw new Error("Missing boundary wire")
    return { name: trace.connection_name, y: exit.y }
  })
  const sortedExits = exits.toSorted((a, b) => a.y - b.y)
  for (let i = 1; i < sortedExits.length; i++) {
    expect(sortedExits[i]!.y - sortedExits[i - 1]!.y).toBeGreaterThanOrEqual(
      solver.config.traceWidth + solver.config.clearance - 1e-9,
    )
  }
  const exitByName = new Map(exits.map((exit) => [exit.name, exit.y]))
  expect(exitByName.get("DATA1")!).toBeLessThan(exitByName.get("DATA2")!)
  expect(exitByName.get("DATA3")!).toBeLessThan(exitByName.get("DATA0")!)
  for (const connection of output.simpleRouteJson.connections) {
    expect(connection.pointsToConnect.at(-1)).toEqual(
      input.connections
        .find((original) => original.name === connection.name)!
        .pointsToConnect.at(-1),
    )
  }
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 30_000)

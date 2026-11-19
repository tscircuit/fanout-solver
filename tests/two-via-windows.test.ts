import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerNames } from "lib/layer-names"
import { routeBus } from "lib/route-bus"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("a bent plane escape leaves a through-via window for the boundary signal", async () => {
  const { input, options } = createTwoViaWindows()
  const solver = new FanoutSolver(input, options)
  solver.solve()

  // Check a constructive witness against the same obstacles and rules. Neither
  // the bend nor the via choice is supplied to the solver being reproduced.
  const [ground, signal] = solver.preparedBuses
  const params = {
    srj: input,
    layerNames: getCopperLayerNames(input.layerCount),
    traceWidth: input.minTraceWidth,
    compactBusTracks: solver.config.compactBusTracks,
    clearance: input.minTraceToPadEdgeClearance!,
    viaDiameter: input.minViaPadDiameter!,
    viaHoleDiameter: input.minViaHoleDiameter!,
    allowBlindAndBuriedVias: false,
  }
  const groundSource = ground!.connections[0]!
  const via = { x: -0.24, y: 0.3 }
  const groundPlans = routeBus({
    ...params,
    bus: ground!,
    acceptedPlans: [],
    targetLayer: "inner1",
    fixedViaPointsByConnectionIndex: new Map([
      [groundSource.connectionIndex, via],
    ]),
    sourceEscapePaths: new Map([
      [
        groundSource.connectionIndex,
        [groundSource.sourcePoint, { x: -0.24, y: 0.24 }, via],
      ],
    ]),
  })
  if (!groundPlans)
    throw new Error("Expected a legal bent escape to the ground plane")
  const signalPlans = routeBus({
    ...params,
    bus: signal!,
    targetLayer: "bottom",
    acceptedPlans: groundPlans,
  })
  if (!signalPlans)
    throw new Error("Expected a boundary route through the other window")
  const plans = [...groundPlans, ...signalPlans]
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: input,
    plans,
    layerNames: params.layerNames,
  })
  expect(
    validateFanoutSolution({
      ...params,
      inputSrj: input,
      outputSrj,
      plans,
      preparedBuses: solver.preparedBuses,
      sharedBoundary: input.bounds,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 2, issues: [] })
  expect(
    validateRoutedCopperDrc({
      ...params,
      inputSrj: input,
      routedSrj: outputSrj,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })

  const routed = Math.max(
    0,
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(routed).toBe(2)
  expect(
    validateRoutedCopperDrc({
      ...params,
      inputSrj: input,
      routedSrj: solver.getOutput().simpleRouteJson,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
  const graphics = solver.visualize()
  graphics.texts = [
    ...(graphics.texts ?? []),
    {
      x: input.bounds.minX,
      y: input.bounds.maxY + 0.22,
      anchorSide: "center_left",
      fontSize: 0.12,
      color: "#0f172a",
      text: `Ground plane and boundary signal · ${routed}/2 routed`,
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, { backgroundColor: "white" }),
  ).toMatchSvgSnapshot(import.meta.path)
})

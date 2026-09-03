import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import capturedSample from "../datasets/fixtures/fanout31-am62l-top-center.json"
import { FanoutSolver } from "../lib/fanout-solver"
import { inferDensePlaneRoutingHints } from "../lib/infer-dense-plane-routing-hints"

test("routes the raw upstream AM62L top-center sample without caller hints", async () => {
  const { simpleRouteJson, solverOptions } = structuredClone(
    capturedSample,
  ) as unknown as {
    simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
    solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
  }
  expect(solverOptions).not.toHaveProperty("densePlaneReservationBusIds")
  expect(solverOptions).not.toHaveProperty(
    "denseUnrestrictedPlaneRoutingBusIds",
  )

  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    maxLayerCombinations: 1,
  })
  expect(solver.config.densePlaneReservationBusIds).toHaveLength(21)
  expect(solver.config.denseUnrestrictedPlaneRoutingBusIds).toHaveLength(5)
  expect(
    inferDensePlaneRoutingHints(solver.preparedBuses, {
      ...solverOptions,
      densePlaneReservationBusIds: [],
      denseUnrestrictedPlaneRoutingBusIds: [],
    }),
  ).toBeNull()
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.getOutput().validation).toEqual({
    valid: true,
    checkedConnectionCount: 135,
    brokenOutConnectionCount: 135,
    issues: [],
  })
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 180_000)

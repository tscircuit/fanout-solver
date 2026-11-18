import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus } from "lib/route-bus"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiSinglePlaneDrop } from "./fixtures/icepi-single-plane-drop"

test("final validation accepts the native U22 plane drop with crossed pour reservations", async (): Promise<void> => {
  const { routeParams, solverOptions } = createIcepiSinglePlaneDrop()
  const plans = routeBus(routeParams)
  expect(plans).toHaveLength(1)
  if (!plans) throw new Error("Native U22 plane drop has no route")
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: routeParams.srj,
    plans,
    layerNames: routeParams.layerNames,
  })
  const copperDrc = validateRoutedCopperDrc({
    inputSrj: routeParams.srj,
    routedSrj: outputSrj,
    clearance: routeParams.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(copperDrc).toMatchObject({ valid: true, issues: [] })
  const validation = validateFanoutSolution({
    inputSrj: routeParams.srj,
    outputSrj,
    plans,
    preparedBuses: [routeParams.bus],
    sharedBoundary: routeParams.bus.sharedBoundary,
    clearance: routeParams.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(validation.brokenOutConnectionCount).toBe(1)
  const solver = new FanoutSolver(routeParams.srj, solverOptions)
  solver.solve()
  expect(solver.solved).toBe(true)
  const accepted = solver.getOutput()
  expect(accepted.validation).toMatchObject({ valid: true, issues: [] })
  expect(accepted.fanoutTraces).toMatchObject(plans.map((plan) => plan.trace))
  expect(accepted.planeTerminations).toHaveLength(1)

  const boundary = routeParams.bus.sharedBoundary
  const viewport = {
    minX: boundary.minX - 1.5,
    maxX: boundary.maxX + 1.5,
    minY: boundary.minY - 1.5,
    maxY: boundary.maxY + 1.5,
  }
  // Show the searched candidate even when final validation rejects its output.
  const graphics = visualizeSimpleRouteJson({
    ...routeParams.srj,
    bounds: viewport,
    traces: outputSrj.traces,
  })
  graphics.texts = [
    {
      x: viewport.minX,
      y: viewport.maxY + 1.3,
      text: `Native U22 pin101 candidate: ${solver.solved ? 1 : 0}/1 accepted`,
      fontSize: 0.3,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.8,
      text: `1/1 routed; independent DRC: ${copperDrc.issues.length} issues`,
      fontSize: 0.25,
      color: "#475569",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.3,
      text: `${routeParams.srj.obstacles.length} native obstacles; final validation: ${validation.issues.length} issues`,
      fontSize: 0.25,
      color: "#475569",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})

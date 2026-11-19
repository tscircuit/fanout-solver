import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiBoundaryContact } from "./fixtures/icepi-boundary-contact"

test("native boundary inference respects caller-specified exit coordinates", async (): Promise<void> => {
  const { srj, solverOptions } = createIcepiBoundaryContact()
  const connection = srj.connections[0]
  const target = connection.pointsToConnect[1]
  expect(srj.obstacles).toHaveLength(2038)
  expect(srj.nominalTraceWidth).toBe(0.1)
  expect(srj.minViaPadDiameter).toBe(0.45)
  expect(srj.minViaHoleDiameter).toBe(0.2)
  const solver = new FanoutSolver(srj, {
    ...solverOptions,
    buses: [
      {
        busId: "signal",
        connectionNames: [connection.name],
        // Same native position, supplied as coordinate guidance only.
        connectionExitTargets: {
          [connection.name]: { x: target.x, y: target.y },
        },
      },
    ],
  })
  solver.solve()
  const bus = solver.preparedBuses[0]
  expect(solverOptions.defaultDirection).toBeUndefined()
  expect(solverOptions.busDirections?.signal).toBeUndefined()
  expect(bus.connections[0].hasExplicitLayeredExitTarget).toBe(false)
  const output = solver.solved ? solver.getOutput() : undefined
  const copperDrc = output
    ? validateRoutedCopperDrc({
        inputSrj: srj,
        routedSrj: output.simpleRouteJson,
        clearance: 0.1,
        allowBlindAndBuriedVias: false,
      })
    : undefined
  expect(solver.solved).toBe(true)
  expect(output?.validation).toMatchObject({ valid: true, issues: [] })
  expect(copperDrc).toMatchObject({
    valid: true,
    checkedViaCount: 0,
    issues: [],
  })

  const viewport = { minX: 1, maxX: 4.8, minY: 10.3, maxY: 13.2 }
  // Crop only the drawing; every original obstacle participates in routing.
  const graphics = visualizeSimpleRouteJson({
    ...srj,
    obstacles: srj.obstacles.filter(
      (obstacle) =>
        obstacle.center.x >= viewport.minX &&
        obstacle.center.x <= viewport.maxX &&
        obstacle.center.y >= viewport.minY &&
        obstacle.center.y <= viewport.maxY,
    ),
    traces: output?.fanoutTraces ?? [],
  })
  graphics.lines ??= []
  graphics.lines.push({
    points: [
      { x: viewport.minX, y: srj.bounds.minY },
      { x: viewport.maxX, y: srj.bounds.minY },
    ],
    strokeColor: "#334155",
    strokeWidth: 0.015,
    strokeDash: [0.05, 0.05],
    label: "Original shared breakout boundary",
  })
  graphics.texts = [
    "Native geometry; caller-specified exit coordinate",
    `BALL_A5: ${solver.solved ? 1 : 0}/1 accepted; default ${bus.direction}`,
    "No explicit heading or exit layer",
    copperDrc
      ? `${copperDrc.checkedViaCount} vias; ${copperDrc.issues.length} DRC issues`
      : "No accepted copper",
  ].map((text, index) => ({
    x: viewport.minX,
    y: viewport.maxY + 0.9 - index * 0.25,
    text,
    fontSize: 0.13,
    color: "#0f172a",
    anchorSide: "center_left",
  }))
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})

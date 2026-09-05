import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createAm625sipMicrosdFanout } from "./fixtures/create-am625sip-microsd-fanout"

test("routes the AM625SiP inner-row microSD fanout", async () => {
  const { inputSrj, options } = createAm625sipMicrosdFanout()
  expect(inputSrj.connections).toHaveLength(3)
  expect(inputSrj.obstacles).toHaveLength(428)
  expect(
    inputSrj.obstacles.filter(
      (obstacle) => obstacle.componentId === "pcb_component_0",
    ),
  ).toHaveLength(425)
  expect(
    inputSrj.obstacles.every((obstacle) => obstacle.shape === "circle"),
  ).toBe(true)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)

  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 3,
    brokenOutConnectionCount: 3,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output.simpleRouteJson,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedViaCount: 1, issues: [] })
  const bestRoutedConnectionCount = Math.max(
    0,
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 2,
        text: `AM625SiP · solved=${solver.solved} · best=${bestRoutedConnectionCount}/3`,
        color: solver.solved ? "#166534" : "#b91c1c",
        fontSize: 0.75,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )
})

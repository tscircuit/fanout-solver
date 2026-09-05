import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { createAm625sipMicrosdFanout } from "./fixtures/create-am625sip-microsd-fanout"

test("rejects the AM625SiP vacant dogbone site blocked on the bottom layer", async () => {
  const { inputSrj, options } = createAm625sipMicrosdFanout()
  inputSrj.obstacles.push({
    ...inputSrj.obstacles[0]!,
    circuitJsonMetadata: {
      pcb_smtpad_id: "bottom-pad-at-c22",
      pcb_port_id: "bottom-port-at-c22",
      source_port_name: "bottom-pad",
    },
    componentId: "bottom-component",
    center: { x: 4.5, y: 5 },
    layers: ["bottom"],
    connectedTo: ["other-net"],
  })
  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()
  expect(solver.failed).toBe(true)
  expect(solver.solved).toBe(false)
  expect(() => solver.getOutput()).toThrow()
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})

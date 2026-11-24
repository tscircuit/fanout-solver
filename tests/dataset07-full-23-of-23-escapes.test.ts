import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import {
  growBounds,
  RP2350A_BREAKOUT_BOUNDARY,
  rp2350aBreakoutFanoutInput,
} from "../datasets/dataset07"

test("prefers directly connected component pad over unrelated pad containing a (0,0) placeholder endpoint", () => {
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.15,
    bounds: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
    obstacles: [
      // Larger component whose unrelated thermal pad happens to cover (0, 0)
      {
        type: "rect",
        componentId: "u1_qfn",
        layers: ["top"],
        center: { x: 0, y: 0 },
        width: 3.4,
        height: 3.4,
        connectedTo: ["gnd_thermal_pad", "net_gnd"],
      },
      {
        type: "rect",
        componentId: "u1_qfn",
        layers: ["top"],
        center: { x: -2.2, y: 0 },
        width: 0.5,
        height: 0.5,
        connectedTo: ["u1_pin_1"],
      },
      {
        type: "rect",
        componentId: "u1_qfn",
        layers: ["top"],
        center: { x: 2.2, y: 0 },
        width: 0.5,
        height: 0.5,
        connectedTo: ["u1_pin_2"],
      },
      // Smaller decoupling component that actually owns pcb_port_75
      {
        type: "rect",
        componentId: "c_decoupling",
        layers: ["top"],
        center: { x: 4.5, y: 1 },
        width: 0.54,
        height: 0.64,
        connectedTo: ["pcb_port_75", "source_trace_40"],
      },
    ],
    connections: [
      {
        name: "breakout:pcb_breakout_point_11",
        pointsToConnect: [
          {
            x: 4.5,
            y: 1,
            layer: "top",
            pointId: "pcb_port_75",
            pcb_port_id: "pcb_port_75",
          },
          { x: 0, y: 0, layer: "top" },
        ],
      },
    ],
  }

  const solver = new FanoutSolver(srj)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const outputSrj = solver.getOutputSimpleRouteJson()
  const trace = outputSrj.traces?.[0]
  expect(trace).toBeDefined()
  expect(trace?.route[0]).toMatchObject({ x: 4.5, y: 1 })
})

test("Dataset 07 routes all 23/23 escapes at the +1.2mm widened boundary", () => {
  const { simpleRouteJson, solverOptions } = rp2350aBreakoutFanoutInput
  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    sharedBoundary: growBounds(RP2350A_BREAKOUT_BOUNDARY, 1.2),
  })
  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)
  expect(solver.error).toBeNull()
  const outputSrj = solver.getOutputSimpleRouteJson()
  expect(outputSrj.traces).toHaveLength(simpleRouteJson.connections.length)
}, 60_000)

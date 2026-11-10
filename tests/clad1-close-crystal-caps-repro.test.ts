import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset06 } from "../datasets/dataset06"

test("clad1 routes after <1 mm crystal capacitor links are completed", () => {
  const sample = fanoutDataset06[0]!
  const simpleRouteJson = structuredClone(sample.simpleRouteJson)
  const solverOptions = structuredClone(sample.solverOptions)

  const capacitorPads = new Map([
    [
      "fanout:pcb_component_33",
      [
        { x: 7.845, y: -1.6 },
        { x: 8.345, y: -1.6 },
      ],
    ],
    [
      "fanout:pcb_component_34",
      [
        { x: 4.155, y: 0.6 },
        { x: 3.655, y: 0.6 },
      ],
    ],
  ])
  for (const [componentId, centers] of capacitorPads) {
    simpleRouteJson.obstacles
      .filter((obstacle) => obstacle.componentId === componentId)
      .forEach((obstacle, index) => {
        obstacle.center = centers[index]!
      })
  }

  const movedPortCenters = new Map([
    ["pcb_port_254", { x: 8.345, y: -1.6 }],
    ["pcb_port_256", { x: 3.655, y: 0.6 }],
  ])
  for (const connection of simpleRouteJson.connections) {
    for (const point of connection.pointsToConnect) {
      if (point.pcb_port_id) {
        const center = movedPortCenters.get(point.pcb_port_id)
        if (center) Object.assign(point, center)
      }
    }
  }

  // The XIN/XOUT links are already routed directly from capacitor pad to
  // crystal pad. They must be excluded from the later fanout stage.
  const completedConnections = new Set([
    "source_trace_135::fanout:0",
    "source_trace_135::fanout:1",
    "source_trace_137::fanout:0",
    "source_trace_137::fanout:1",
  ])
  simpleRouteJson.connections = simpleRouteJson.connections.filter(
    (connection) => !completedConnections.has(connection.name),
  )
  simpleRouteJson.buses = simpleRouteJson.buses!.filter(
    (bus) => !bus.connectionNames.some((name) => completedConnections.has(name)),
  )
  solverOptions.buses = solverOptions.buses!.filter(
    (bus) => !bus.connectionNames.some((name) => completedConnections.has(name)),
  )

  const solver = new FanoutSolver(simpleRouteJson, solverOptions)
  solver.solve()

  // Current behavior: the solver reports no routed connections. This
  // expectation deliberately describes the intended behavior for the fix.
  expect(solver.solved).toBe(true)
  expect(solver.getOutput().fanoutTraces).toHaveLength(128)
}, 60_000)

import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec, FanoutSolverOptions } from "lib/types"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("dense competing bus layers run the reserved strategy before layer probes and commit only a complete fanout", async () => {
  const bounds = { minX: -4, maxX: 4, minY: -4, maxY: 4 }
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 5,
    minTraceWidth: 0.08128,
    connections: [],
    obstacles: [],
  }
  const buses: FanoutBusSpec[] = []
  const groups = new Map<string, string[]>()
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 6; column++) {
      const name = `N${row * 6 + column}`,
        port = `pad-${row}-${column}`,
        source = { x: (column - 2.5) * 0.65, y: (row - 2.5) * 0.65 },
        plane = column < 3,
        layer = column === 3 ? "inner2" : column === 4 ? "inner3" : "bottom"
      srj.obstacles.push({
        type: "rect",
        shape: "circle",
        obstacleId: port,
        componentId: "U1",
        center: source,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [name, port],
      } as SimpleRouteJson["obstacles"][number])
      srj.connections.push({
        name,
        pointsToConnect: [
          { ...source, pointId: port, pcb_port_id: port, layer: "top" },
          ...(plane
            ? []
            : [
                {
                  x: 4,
                  y:
                    column === 3
                      ? [-1.625, -0.8, -0.45, 0.45, 0.8, 1.625][row]!
                      : source.y,
                  layer,
                },
              ]),
        ],
      })
      if (plane) {
        buses.push({
          busId: name,
          connectionNames: [name],
          sourceComponentId: "U1",
          direction: "left",
          termination: { type: "plane", layer: "inner1" },
        })
      } else {
        const group = `${column}-${Math.floor(row / (column === 3 ? 3 : 2))}`
        groups.set(group, [...(groups.get(group) ?? []), name])
      }
    }
  }
  for (const [id, names] of groups) {
    buses.push({
      busId: `bus-${id}`,
      connectionNames: names,
      sourceComponentId: "U1",
      direction: "right",
      preferredExit: "right",
      exitEdge: "right",
      connectionExitTargets: Object.fromEntries(
        names.map((name) => [
          name,
          srj.connections
            .find((connection) => connection.name === name)!
            .pointsToConnect.at(-1)!,
        ]),
      ),
      allowedLayers: id.startsWith("3-")
        ? ["inner2"]
        : id.startsWith("4-")
          ? ["inner3"]
          : ["inner3", "bottom"],
    })
  }
  const options: FanoutSolverOptions = {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["inner2", "inner3", "bottom"],
    allowBlindAndBuriedVias: false,
    compactBusTracks: true,
    borderDistribution: "even",
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.12,
  }
  const before = JSON.stringify({ srj, options })
  const solver = new FanoutSolver(srj, options)
  solver.step()
  expect(solver.activeSubSolver?.getSolverName()).toBe(
    "FanoutLayerReservedSolver",
  )
  expect(solver.layerAssignments).toHaveLength(0)
  const phases = new Set<string>()
  for (let i = 0; i < 100_000 && !solver.solved && !solver.failed; i++) {
    solver.step()
    phases.add(String(solver.stats.phase))
  }
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expectStraightOr45Fanout(output.fanoutTraces)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 36, issues: [] })
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.fanoutTraces).toHaveLength(36)
  expect(output.planeTerminations).toHaveLength(18)
  expect(output.attempts).toHaveLength(1)
  expect(output.attempts[0]).toMatchObject({
    assignmentIndex: 0,
    routedConnectionCount: 36,
    routedBusCount: buses.length,
    failedBusIds: [],
  })
  expect(phases.has("layer-reserved-route-layer")).toBe(true)
  expect(phases.has("discover-candidate-layers")).toBe(false)
  for (const bus of solver.preparedBuses) {
    const layer = output.busLayerAssignments[bus.busId]
    if (bus.termination.type === "plane") {
      expect(layer).toBe("inner1")
      continue
    }
    expect(bus.allowedLayers).toContain(layer)
    const traces = output.fanoutTraces.filter((trace) =>
      bus.connections.some(
        (connection) => connection.connection.name === trace.connection_name,
      ),
    )
    expect(traces).toHaveLength(bus.connections.length)
    if (bus.busId.startsWith("bus-3-")) {
      for (const trace of traces) {
        const connection = bus.connections.find(
          (connection) => connection.connection.name === trace.connection_name,
        )!
        expect(trace.route.at(-1)).toMatchObject({
          x: bounds.maxX,
          y: connection.exitTargetPoint!.y,
        })
      }
    }
    const exits = traces.map((trace) => trace.route.at(-1)!)
    expect(
      exits.every(
        (point) =>
          point.route_type === "wire" &&
          point.x === bounds.maxX &&
          point.layer === layer,
      ),
    ).toBe(true)
  }
  expect(JSON.stringify({ srj, options })).toBe(before)
  // A single wide constrained bus keeps the established candidate/assignment
  // path. The reservation strategy is also incompatible with blind vias.
  for (const fallbackOptions of [
    {
      ...options,
      buses: buses.map((bus) =>
        bus.busId === "bus-3-1" ? { ...bus, allowedLayers: ["inner3"] } : bus,
      ),
    },
    { ...options, allowBlindAndBuriedVias: true },
    {
      ...options,
      buses: buses.map((bus) =>
        bus.busId === "bus-3-0"
          ? { ...bus, connectionExitTargets: undefined }
          : bus,
      ),
    },
  ]) {
    const fallback = new FanoutSolver(srj, fallbackOptions)
    fallback.step()
    expect(fallback.activeSubSolver?.getSolverName()).toBe(
      "FanoutCandidateLayerSolver",
    )
  }
  // An impossible source reservation declines cleanly, before any attempt
  // or partial plane/source prefix can be mistaken for a completed solution.
  const blocked = structuredClone(srj)
  blocked.obstacles.push({
    type: "rect",
    center: { x: 0, y: 0 },
    width: 9,
    height: 9,
    layers: ["top", "inner1", "inner2", "inner3", "bottom"],
    connectedTo: ["unrelated-blocker"],
  })
  const declined = new FanoutSolver(blocked, options)
  declined.step()
  expect(declined.activeSubSolver?.getSolverName()).toBe(
    "FanoutLayerReservedSolver",
  )
  for (
    let i = 0;
    i < 1000 &&
    declined.activeSubSolver?.getSolverName() !== "FanoutCandidateLayerSolver";
    i++
  )
    declined.step()
  expect(declined.activeSubSolver?.getSolverName()).toBe(
    "FanoutCandidateLayerSolver",
  )
  expect(declined.solved).toBe(false)
  expect(declined.attempts).toHaveLength(0)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...output.simpleRouteJson,
        connections: [],
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)

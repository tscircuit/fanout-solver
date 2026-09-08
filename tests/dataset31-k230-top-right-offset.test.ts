import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import fixture from "./fixtures/dataset31-k230-top-right-offset.json"
import { FanoutSolver } from "../lib/fanout-solver"
import { getLayerReservedBusTargets } from "../lib/route-layer-reserved-buses"
import {
  mergeLayeredBoundaryTargets,
  boundaryTargetsPreserveLayerOrder,
} from "../lib/merge-layered-boundary-targets"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

test("matches offset split buses after protecting aligned opposite approaches", async () => {
  const input = structuredClone(fixture) as unknown as {
    simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
    solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
  }
  const before = JSON.stringify(input)
  const solver = new FanoutSolver(input.simpleRouteJson, input.solverOptions)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 171,
    brokenOutConnectionCount: 171,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(171)
  expect(output.planeTerminations).toHaveLength(106)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input.simpleRouteJson,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 171, issues: [] })
  const targets = getLayerReservedBusTargets({
    ...solver.config,
    srj: input.simpleRouteJson,
    buses: solver.preparedBuses,
  })!
  const finalBuses = solver.preparedBuses.filter(
    (bus) => targets.targetLayerByBusId.get(bus.busId) === "bottom",
  )
  const merged = mergeLayeredBoundaryTargets({
    buses: finalBuses,
    exits: targets.exits,
  })
  for (const bus of finalBuses) {
    expect(boundaryTargetsPreserveLayerOrder(bus, merged)).toBe(true)
    const tracks = (map: typeof merged) =>
      bus.connections
        .map((c) => JSON.stringify(map.get(c.connectionIndex)))
        .sort()
    expect(tracks(merged)).toEqual(tracks(targets.exits))
  }
  const bounds = solver.preparedBuses[0]!.sharedBoundary
  const boundaryTargets = new Map(
    solver.preparedBuses
      .filter((bus) => bus.termination.type === "boundary")
      .flatMap((bus) =>
        bus.connections.map(
          (connection) =>
            [
              connection.connection.name,
              merged.get(connection.connectionIndex)!,
            ] as const,
        ),
      ),
  )
  const sources = new Map(
    solver.preparedBuses.flatMap((bus) =>
      bus.connections.map((c) => [c.connection.name, c.sourcePoint] as const),
    ),
  )
  expect(
    new Set(output.fanoutTraces.map((trace) => trace.connection_name)).size,
  ).toBe(sources.size)
  for (const trace of output.fanoutTraces) {
    const wires = trace.route.filter((point) => point.route_type === "wire")
    const first = wires[0]!,
      source = sources.get(trace.connection_name!)!
    expect(Math.hypot(first.x - source.x, first.y - source.y)).toBeLessThan(
      1e-7,
    )
    const exit = boundaryTargets.get(trace.connection_name!)
    if (exit) {
      const last = wires.at(-1)!
      expect(Math.hypot(last.x - exit.x, last.y - exit.y)).toBeLessThan(1e-7)
    }
    let previous: { x: number; y: number; layer: string } | undefined
    let vector: { x: number; y: number } | undefined
    for (const point of trace.route) {
      if (point.route_type !== "wire") {
        previous = undefined
        vector = undefined
        continue
      }
      const exit = boundaryTargets.get(trace.connection_name!)
      if (exit && Math.hypot(point.x - exit.x, point.y - exit.y) > 1e-7) {
        expect(point.x).toBeGreaterThan(bounds.minX + 1e-7)
        expect(point.x).toBeLessThan(bounds.maxX - 1e-7)
        expect(point.y).toBeGreaterThan(bounds.minY + 1e-7)
        expect(point.y).toBeLessThan(bounds.maxY - 1e-7)
      }
      if (previous && previous.layer === point.layer) {
        const next = { x: point.x - previous.x, y: point.y - previous.y }
        if (Math.hypot(next.x, next.y) > 1e-7) {
          expect(
            Math.abs(next.x) < 1e-7 ||
              Math.abs(next.y) < 1e-7 ||
              Math.abs(Math.abs(next.x) - Math.abs(next.y)) < 1e-7,
          ).toBe(true)
          if (vector) {
            const dot = vector.x * next.x + vector.y * next.y
            const cross = Math.abs(vector.x * next.y - vector.y * next.x)
            expect(
              dot >= -1e-7 && (cross < 1e-7 || Math.abs(cross - dot) < 1e-7),
            ).toBe(true)
          }
          vector = next
        }
      }
      previous = point
    }
  }
  expect(JSON.stringify(input)).toBe(before)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
  // The benchmark independently preserves its 120-second routing deadline.
}, 240_000)

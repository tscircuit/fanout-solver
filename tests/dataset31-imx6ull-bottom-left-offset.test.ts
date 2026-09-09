import { expect, test } from "bun:test"
import { expectSvgSnapshotWithActual } from "./fixtures/expect-svg-snapshot-with-actual"
import { getSvgFromGraphicsObject } from "graphics-debug"
import fixture from "./fixtures/dataset31-imx6ull-bottom-left-offset.json"
import { FanoutSolver } from "../lib/fanout-solver"
import { getLayerReservedBusTargets } from "../lib/route-layer-reserved-buses"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

test("shortens overlong source prefixes and repairs a blocked constrained bus lane", async () => {
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
    checkedConnectionCount: 102,
    brokenOutConnectionCount: 102,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(102)
  expect(output.planeTerminations).toHaveLength(53)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input.simpleRouteJson,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 102, issues: [] })
  const targets = getLayerReservedBusTargets({
    ...solver.config,
    srj: input.simpleRouteJson,
    buses: solver.preparedBuses,
  })!
  const bounds = solver.preparedBuses[0]!.sharedBoundary
  const boundaryTargets = new Map(
    solver.preparedBuses
      .filter((bus) => bus.termination.type === "boundary")
      .flatMap((bus) =>
        bus.connections.map(
          (connection) =>
            [
              connection.connection.name,
              targets.exits.get(connection.connectionIndex)!,
            ] as const,
        ),
      ),
  )
  for (const trace of output.fanoutTraces) {
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
  await expectSvgSnapshotWithActual(
    getSvgFromGraphicsObject(solver.visualize()),
    import.meta.path,
  )
  // The benchmark independently preserves its 120-second routing deadline.
}, 240_000)

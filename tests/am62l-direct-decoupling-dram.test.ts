import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { expectSvgSnapshotWithActual } from "./fixtures/expect-svg-snapshot-with-actual"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import { createAm62lDirectDecouplingDramInput } from "./fixtures/create-am62l-direct-decoupling-dram-input"

function pointIsOnBoundary(
  point: { x: number; y: number },
  boundary: { minX: number; maxX: number; minY: number; maxY: number },
) {
  return (
    Math.abs(point.x - boundary.minX) < 1e-7 ||
    Math.abs(point.x - boundary.maxX) < 1e-7 ||
    Math.abs(point.y - boundary.minY) < 1e-7 ||
    Math.abs(point.y - boundary.maxY) < 1e-7
  )
}

test("finalizes the real AM62L direct-decoupling DRAM fanout", async () => {
  const { inputSrj, options } = createAm62lDirectDecouplingDramInput()
  const throughViaObstacles = inputSrj.obstacles.filter(
    (obstacle) =>
      (obstacle as { circuitJsonMetadata?: { pcb_via_id?: string } })
        .circuitJsonMetadata?.pcb_via_id !== undefined &&
      obstacle.layers.length === inputSrj.layerCount,
  )
  const priorTraces = inputSrj.traces ?? []

  expect(inputSrj.connections).toHaveLength(143)
  expect(inputSrj.obstacles).toHaveLength(457)
  expect(priorTraces).toHaveLength(255)
  expect(new Set(priorTraces.map((trace) => trace.pcb_trace_id)).size).toBe(
    priorTraces.length,
  )
  expect(throughViaObstacles).toHaveLength(120)

  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()

  expect(solver.error).toBeNull()
  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)
  expect(solver.attempts).toHaveLength(1)
  const output = solver.getOutput()
  expectStraightOr45Fanout(output.fanoutTraces)
  expect(output.fanoutTraces).toHaveLength(143)
  expect(output.planeTerminations).toHaveLength(110)
  const boundary = options.sharedBoundary ?? inputSrj.bounds
  for (const trace of output.fanoutTraces) {
    const wires = trace.route.filter(
      (point): point is Extract<typeof point, { route_type: "wire" }> =>
        point.route_type === "wire",
    )
    for (const point of wires.slice(0, -1)) {
      expect(pointIsOnBoundary(point, boundary)).toBe(false)
    }
  }
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 143,
    brokenOutConnectionCount: 143,
    issues: [],
  })

  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 2,
        text: "Real Core TSX · AM62L + LPDDR4 · 60 decouplers · 120 vias",
        color: "#0f172a",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: "Routed 143/143 · solved=true · validation valid",
        color: "#166534",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expectSvgSnapshotWithActual(
    getSvgFromGraphicsObject(visualization),
    import.meta.path,
  )
}, 600_000)

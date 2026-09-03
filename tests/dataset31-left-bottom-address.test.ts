import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import capturedInput from "./fixtures/dataset31-left-bottom-address.json"

// Captured from dataset31's 10-left-bottom-offset via debug-dataset31.ts.
// Only the other connections were removed: all 573 obstacles, the original
// eight address/control targets, stackup, and 15 mm skew limit are retained.
test("dataset31 left-bottom address bus escapes using local inward dogbones", async () => {
  const input = structuredClone(capturedInput) as unknown as {
    simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
    solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
  }
  expect(input.simpleRouteJson.connections).toHaveLength(8)
  expect(input.simpleRouteJson.obstacles).toHaveLength(573)
  expect(input.solverOptions.buses?.[0]?.maxLengthSkew).toBe(15)

  const solver = new FanoutSolver(input.simpleRouteJson, input.solverOptions)
  solver.solve()

  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    brokenOutConnectionCount: 8,
    issues: [],
  })
  expect(output.busLayerAssignments.DDR_ADDR_CTRL).toBe("inner6")
  expect(output.fanoutTraces).toHaveLength(8)
  for (const trace of output.fanoutTraces) {
    expect(
      trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(1)
    expect(trace.route.at(-1)).toMatchObject({
      route_type: "wire",
      layer: "inner6",
      x: input.solverOptions.sharedBoundary!.minX,
    })
  }
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)

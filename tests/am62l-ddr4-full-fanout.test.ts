import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const captured: readonly [
  ConstructorParameters<typeof FanoutSolver>[0],
  FanoutSolverOptions,
] = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/am62l-ddr4-soc-fanout.json.gz", import.meta.url),
    ),
  ).toString("utf8"),
)

test("routes every connection in the exact AM62L DDR4 SoC fanout", async () => {
  // This is the exact SOC_ESCAPE constructor input captured from the real
  // AM62L + x16 DDR4 Core TSX circuit, including all physical obstacles.
  const [inputSrj, options] = captured
  expect(inputSrj.connections).toHaveLength(49)
  expect(inputSrj.obstacles).toHaveLength(469)

  const solver = new FanoutSolver(
    structuredClone(inputSrj),
    structuredClone(options),
  )
  solver.solve()

  const routedCount = solver.solved
    ? solver.getOutput().fanoutTraces.length
    : Number(solver.error?.match(/routed (\d+)\/49/)?.[1] ?? 0)
  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: `Exact AM62L DDR4 · solved=${solver.solved} · routed=${routedCount}/49`,
        color: solver.solved ? "#166534" : "#b91c1c",
        fontSize: 0.5,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )

  expect(solver.failed, solver.error ?? undefined).toBe(false)
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(49)
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  for (const trace of output.fanoutTraces) {
    let wireRun: Array<{ x: number; y: number; layer: string }> = []
    for (const routePoint of trace.route) {
      if (routePoint.route_type !== "wire") {
        wireRun = []
        continue
      }
      if (wireRun.at(-1)?.layer !== routePoint.layer) wireRun = []
      wireRun.push(routePoint)
      if (wireRun.length < 3) continue
      const start = wireRun.at(-3)!
      const corner = wireRun.at(-2)!
      const end = wireRun.at(-1)!
      const incoming = {
        x: corner.x - start.x,
        y: corner.y - start.y,
      }
      const outgoing = {
        x: end.x - corner.x,
        y: end.y - corner.y,
      }
      const incomingLength = Math.hypot(incoming.x, incoming.y)
      const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
      if (incomingLength < 1e-9 || outgoingLength < 1e-9) continue
      const normalizedDot =
        (incoming.x * outgoing.x + incoming.y * outgoing.y) /
        (incomingLength * outgoingLength)
      expect(Math.abs(normalizedDot)).toBeGreaterThan(1e-6)
    }
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: {
        ...output.simpleRouteJson,
        traces: output.fanoutTraces,
      },
      clearance: inputSrj.minViaEdgeToPadEdgeClearance!,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 49,
    checkedViaCount: 49,
    issues: [],
  })
}, 1_800_000)

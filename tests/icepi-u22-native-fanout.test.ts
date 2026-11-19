import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"

test("reproduces the native iCE/Pi U22 fanout", async () => {
  const capture = new URL(
    "./fixtures/icepi-plane-drop.json.gz",
    import.meta.url,
  )
  const { solverParams, solverOptions } = JSON.parse(
    gunzipSync(new Uint8Array(readFileSync(capture))).toString("utf8"),
  )
  const solver = new FanoutSolver(solverParams, solverOptions)
  solver.solve()

  expect(solverParams.connections).toHaveLength(32)
  expect(
    Math.max(
      ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
    ),
  ).toBe(17)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 180_000)

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FanoutSolver } from "lib/fanout-solver"

test("native decoupler plane drops join retained ground without relaxing physical clearance", () => {
  // Unmodified constructor arguments emitted by the real TSX circuit in
  // tscircuit/core#3877. Its native PCB snapshot is fixed in core#3878.
  const [srj, options]: ConstructorParameters<typeof FanoutSolver> = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/decoupler-plane-retained-ground.json",
        import.meta.url,
      ),
      "utf8",
    ),
  )
  if (!options) throw new Error("Repro must include native fanout options")
  const before = JSON.stringify([srj, options])
  expect(options.allowSameNetMerges).toBeUndefined()
  const solver = new FanoutSolver(srj, options)
  solver.solve()

  // Record the existing failure so the repro-only PR remains a passing test.
  // The stacked fix must solve this exact input without changing its geometry.
  expect(solver.failed).toBe(true)
  expect(solver.solved).toBe(false)
  expect(JSON.stringify([srj, options])).toBe(before)
})

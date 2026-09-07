import { mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { FanoutSolver } from "../../lib/fanout-solver"

// Temporary diagnostics for the Linux/macOS routing discrepancy in PR #186.
export function solveWithCiRoutingDiagnostics(
  solver: FanoutSolver,
  testPath: string,
): void {
  const report = (thrown?: unknown) => {
    const summary = {
      test: basename(testPath),
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      solved: solver.solved,
      failed: solver.failed,
      error: solver.error,
      thrown: thrown instanceof Error ? thrown.message : String(thrown ?? ""),
      iterations: solver.iterations,
      maximumIterations: solver.MAX_ITERATIONS,
      stats: Object.fromEntries(
        Object.entries(solver.stats)
          .filter(
            ([, value]) =>
              value === null ||
              ["string", "number", "boolean"].includes(typeof value),
          )
          .map(([key, value]) => [
            key,
            typeof value === "string" ? value.slice(0, 500) : value,
          ]),
      ),
      attemptCount: solver.attempts.length,
      recentAttempts: solver.attempts.slice(-8).map((attempt) => ({
        assignmentIndex: attempt.assignmentIndex,
        routedBusCount: attempt.routedBusCount,
        routedConnectionCount: attempt.routedConnectionCount,
        failedBusIds: attempt.failedBusIds.slice(0, 16),
        score: attempt.score,
        validationIssueCount: attempt.validationIssues?.length ?? 0,
        validationIssueCodes: attempt.validationIssues
          ?.slice(0, 12)
          .map((issue) => issue.code),
      })),
    }
    const json = JSON.stringify(summary, null, 2)
    console.error(`CI routing failure diagnostics:\n${json}`)
    mkdirSync(".ci-routing-diagnostics", { recursive: true })
    writeFileSync(
      join(".ci-routing-diagnostics", `${basename(testPath)}.failure.json`),
      `${json}\n`,
    )
  }
  try {
    solver.solve()
  } catch (error) {
    report(error)
    throw error
  }
  if (!solver.solved || solver.failed) report()
}

export function writeCiActualSvg(testPath: string, svg: string): void {
  const directory = join(dirname(testPath), "__snapshots__")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(
      directory,
      `${basename(testPath).replace(/\.test\.tsx?$/, "")}.actual.svg`,
    ),
    svg,
  )
}

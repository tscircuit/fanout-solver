import { expect, test } from "bun:test"

test("comment reporting uses trusted workflow code on a different runner from PR execution", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/benchmark.yml", import.meta.url),
    ).text(),
  ) as any
  expect(workflow.on.issue_comment.types).toEqual(["created"])
  expect(workflow.permissions).toEqual({})
  const { prepare, benchmark, report } = workflow.jobs
  expect(benchmark["runs-on"]).toBe("blacksmith-32vcpu-ubuntu-2404-arm")
  expect(benchmark.permissions).toEqual({ contents: "read" })
  expect(report.permissions.issues).toBe("write")
  expect(report.needs).toEqual(["prepare", "benchmark"])
  expect(report.if).toContain("always()")
  for (const job of [prepare, report]) {
    const checkout = job.steps.find(
      (step: any) => step.uses === "actions/checkout@v4",
    )
    expect(checkout.with.ref).toBe("${{ github.workflow_sha }}")
    expect(checkout.with["persist-credentials"]).toBe(false)
  }
  const checkout = benchmark.steps.find(
    (step: any) => step.uses === "actions/checkout@v4",
  )
  expect(checkout.with.ref).toBe("${{ needs.prepare.outputs.ref }}")
  expect(checkout.with["persist-credentials"]).toBe(false)
  expect(
    benchmark.steps.find((step: any) => step.name === "Run every sample").run,
  ).toContain("./benchmark.sh")
  expect(JSON.stringify(benchmark)).not.toContain("secrets.")
})

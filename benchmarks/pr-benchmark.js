/** Trusted automation: import this from the workflow revision, never the PR checkout. */
export const isBenchmarkComment = (payload) =>
  Boolean(payload.issue?.pull_request) &&
  payload.comment?.user?.type !== "Bot" &&
  payload.comment?.body?.trim() === "/benchmark"

export async function preparePrBenchmark({ github, context, core }) {
  core.setOutput("enabled", "false")
  if (
    context.eventName !== "workflow_dispatch" &&
    !isBenchmarkComment(context.payload)
  )
    return
  // Check current access rather than trusting a comment's cached association.
  const username =
    context.eventName === "issue_comment"
      ? context.payload.comment.user.login
      : context.actor
  let permission
  try {
    permission = (
      await github.rest.repos.getCollaboratorPermissionLevel({
        ...context.repo,
        username,
      })
    ).data.permission
  } catch (error) {
    if (error.status !== 404) throw error
  }
  if (!["admin", "maintain", "write"].includes(permission)) {
    core.notice("Only repository writers can request a benchmark")
    return
  }
  const rawNumber =
    context.eventName === "issue_comment"
      ? String(context.issue.number)
      : (context.payload.inputs?.pr_number ?? "").trim()
  if (
    rawNumber &&
    (!/^[1-9]\d*$/.test(rawNumber) || !Number.isSafeInteger(Number(rawNumber)))
  )
    throw new Error("pr_number must be a positive integer")
  let repository = `${context.repo.owner}/${context.repo.repo}`
  let ref = context.sha
  let commentId = ""
  const runUrl = `${context.serverUrl}/${repository}/actions/runs/${context.runId}`
  if (rawNumber) {
    const pr = (
      await github.rest.pulls.get({
        ...context.repo,
        pull_number: Number(rawNumber),
      })
    ).data
    if (pr.state !== "open")
      throw new Error("Benchmark requests require an open pull request")
    if (!pr.head.repo || !/^[a-f0-9]{40}$/.test(pr.head.sha))
      throw new Error("PR head is unavailable")
    ref = pr.head.sha
    repository = pr.head.repo.full_name
    const comment = await github.rest.issues.createComment({
      ...context.repo,
      issue_number: Number(rawNumber),
      body: `## Fanout benchmark\n\nQueued for \`${ref.slice(0, 7)}\` on Blacksmith. Every available sample will run with a per-sample deadline.\n\n[View run](${runUrl})`,
    })
    commentId = String(comment.data.id)
  }
  core.setOutput("ref", ref)
  core.setOutput("repository", repository)
  core.setOutput("comment_id", commentId)
  core.setOutput("enabled", "true")
}

const escape = (value) =>
  String(value)
    .slice(0, 120)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("@", "&#64;")
    .replaceAll("`", "&#96;")
    .replace(/[\r\n]/g, " ")
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

/** Render data only; never execute scripts or post raw Markdown supplied by the PR. */
export function renderBenchmarkComment(report, { ref, runUrl, result }) {
  const header = [
    "## Fanout benchmark",
    "",
    `Commit: \`${ref.slice(0, 7)}\`. Blacksmith job: **${result}**.`,
    "",
    `[Full JSON/Markdown reports and logs](${runUrl})`,
    "",
  ]
  if (!report)
    return [
      ...header,
      "No readable benchmark report was produced. See the run logs for the failure.",
    ].join("\n")
  if (
    report.version !== 1 ||
    !Array.isArray(report.rows) ||
    report.rows.length > 10000 ||
    !finite(report.totalSamples) ||
    report.totalSamples < report.rows.length
  )
    throw new Error("Invalid benchmark report")
  const keys = new Set()
  for (const row of report.rows) {
    if (
      typeof row.dataset !== "string" ||
      typeof row.sample !== "string" ||
      !["solved", "partial", "error", "timeout"].includes(row.status) ||
      !finite(row.connections) ||
      !finite(row.routed) ||
      row.routed > row.connections ||
      !finite(row.milliseconds)
    )
      throw new Error("Invalid benchmark row")
    const key = JSON.stringify([row.dataset, row.sample])
    if (keys.has(key)) throw new Error("Duplicate benchmark row")
    keys.add(key)
  }
  const { rows } = report
  const count = (group, status) =>
    group.filter((row) => row.status === status).length
  header.push(
    `**Solved ${count(rows, "solved")}/${report.totalSamples} selected samples.** Completed ${rows.length}/${report.totalSamples}; partial ${count(rows, "partial")}; errors ${count(rows, "error")}; timeouts ${count(rows, "timeout")}.`,
    "",
  )
  if (rows.length !== report.totalSamples)
    header.push(
      "⚠️ Incomplete run: unreported samples are not counted as solved.",
      "",
    )
  const config = report.configuration
  if (
    config &&
    finite(config.concurrency) &&
    finite(config.sampleTimeoutSeconds)
  )
    header.push(
      `Concurrency: ${config.concurrency}; per-sample deadline: ${config.sampleTimeoutSeconds}s; assignment budget: ${finite(config.maxLayerCombinations) ? config.maxLayerCombinations : "sample defaults"}.`,
      "",
    )
  header.push(
    "Solved means validated fanout; SRJ29 additionally requires original-endpoint connectivity and independent emitted-copper DRC. Fanout-only success does not imply inter-chip routing.",
    "",
    "| Dataset | Solved / completed | Partial | Error | Timeout |",
    "| --- | ---: | ---: | ---: | ---: |",
  )
  const datasets = [...new Set(rows.map((row) => row.dataset))]
  for (const dataset of datasets.slice(0, 100)) {
    const group = rows.filter((row) => row.dataset === dataset)
    header.push(
      `| ${escape(dataset)} | ${count(group, "solved")}/${group.length} | ${count(group, "partial")} | ${count(group, "error")} | ${count(group, "timeout")} |`,
    )
  }
  if (datasets.length > 100)
    header.push(
      "",
      "Additional dataset summaries are available in the report artifact.",
    )
  header.push(
    "",
    "<details><summary>Per-sample results</summary>",
    "",
    "| Sample | Status | Routed | Seconds |",
    "| --- | --- | ---: | ---: |",
  )
  let length = header.join("\n").length
  for (const [index, row] of rows.entries()) {
    const line = `| ${escape(`${row.dataset}/${row.sample}`)} | ${row.status} | ${row.routed}/${row.connections} | ${(row.milliseconds / 1000).toFixed(2)} |`
    if (length + line.length > 55000) {
      header.push(
        "",
        `${rows.length - index} additional rows are available in the full report artifact.`,
      )
      break
    }
    header.push(line)
    length += line.length + 1
  }
  header.push("", "</details>")
  return header.join("\n")
}

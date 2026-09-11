import { expect, test } from "bun:test"
import {
  isBenchmarkComment,
  preparePrBenchmark,
} from "../benchmarks/pr-benchmark.js"

test("PR benchmark authorizes writers and resolves open heads or merged commits", async () => {
  const payload = {
    issue: { pull_request: {} },
    comment: { body: " /benchmark\n", user: { type: "User", login: "writer" } },
  }
  expect(isBenchmarkComment(payload)).toBe(true)
  for (const body of [
    "/benchmark-all",
    "/benchmark; echo x",
    "Please /benchmark",
    "/benchmark --anything",
  ])
    expect(
      isBenchmarkComment({ ...payload, comment: { ...payload.comment, body } }),
    ).toBe(false)
  expect(isBenchmarkComment({ ...payload, issue: {} })).toBe(false)
  expect(
    isBenchmarkComment({
      ...payload,
      comment: { ...payload.comment, user: { type: "Bot" } },
    }),
  ).toBe(false)
  const outputs: Record<string, string> = {}
  const comments: unknown[] = []
  let permission = "read"
  const sha = "a".repeat(40)
  const mergeSha = "c".repeat(40)
  let pr: {
    state: string
    merged_at: string | null
    merge_commit_sha: string | null
    head: { sha: string; repo: { full_name: string } | null }
  } = {
    state: "open",
    merged_at: null as string | null,
    merge_commit_sha: null as string | null,
    head: { sha, repo: { full_name: "contributor/fork" } },
  }
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
      pulls: {
        get: async () => ({ data: pr }),
      },
      issues: {
        createComment: async (comment: unknown) => {
          comments.push(comment)
          return { data: { id: 42 } }
        },
      },
    },
  }
  const context = {
    eventName: "issue_comment",
    payload,
    issue: { number: 123 },
    repo: { owner: "tscircuit", repo: "fanout-solver" },
    sha: "b".repeat(40),
    actor: "writer",
    serverUrl: "https://github.com",
    runId: 10,
  }
  const core = {
    setOutput: (key: string, value: string) => {
      outputs[key] = value
    },
    notice: () => {},
  }
  await preparePrBenchmark({ github, context, core })
  expect(outputs.enabled).toBe("false")
  expect(comments).toHaveLength(0)
  permission = "write"
  await preparePrBenchmark({ github, context, core })
  expect(outputs).toEqual({
    enabled: "true",
    ref: sha,
    repository: "contributor/fork",
    comment_id: "42",
  })
  expect(comments).toHaveLength(1)
  const openComment = comments[0] as { body: string }
  expect(openComment.body).toContain(
    "All 72 dataset-fanout31-am62l samples (12 AM62L, 12 RK3308, 12 K230, 12 i.MX6ULL, 12 T113-S3, and 12 AM3352)",
  )
  expect(openComment.body).toContain("Queued PR head `aaaaaaa`")

  pr = {
    state: "closed",
    merged_at: "2026-09-11T12:00:00Z",
    merge_commit_sha: mergeSha,
    head: { sha: "unavailable", repo: null },
  }
  await preparePrBenchmark({ github, context, core })
  expect(outputs).toEqual({
    enabled: "true",
    ref: mergeSha,
    repository: "tscircuit/fanout-solver",
    comment_id: "42",
  })
  expect((comments[1] as { body: string }).body).toContain(
    "Queued merged commit `ccccccc`",
  )

  pr = {
    ...pr,
    merged_at: null,
    merge_commit_sha: null,
  }
  await expect(preparePrBenchmark({ github, context, core })).rejects.toThrow(
    "open or merged pull request",
  )

  pr = {
    ...pr,
    merged_at: "2026-09-11T12:00:00Z",
    merge_commit_sha: "not-a-commit",
  }
  await expect(preparePrBenchmark({ github, context, core })).rejects.toThrow(
    "Merged PR commit is unavailable",
  )
})

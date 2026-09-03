import { expect, test } from "bun:test"
import {
  isBenchmarkComment,
  preparePrBenchmark,
} from "../benchmarks/pr-benchmark.js"

test("PR benchmark requires an exact human command and current repository write access", async () => {
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
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            head: { sha, repo: { full_name: "contributor/fork" } },
          },
        }),
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
})

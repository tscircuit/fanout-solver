import { expect, test } from "bun:test"
import { getRuntimeProcess } from "../lib/runtime-process"

test("provides an empty environment when process is unavailable", () => {
  expect(getRuntimeProcess({})).toEqual({ env: {} })
})

test("preserves runtime environment variables when process is available", () => {
  const process = { env: { FANOUT_DEBUG_DENSE: "1" } }

  expect(getRuntimeProcess({ process })).toBe(process)
})

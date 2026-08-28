import "bun-match-svg"
import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))

const runCommand = (command: string[]) =>
  Bun.spawnSync(command, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

const decodeOutput = (result: ReturnType<typeof runCommand>) =>
  `${result.stdout.toString()}\n${result.stderr.toString()}`.trim()

test("repro: published package requires bundler and ESNext consumer settings", async () => {
  const buildResult = runCommand(["bun", "run", "build"])
  expect(buildResult.exitCode, decodeOutput(buildResult)).toBe(0)

  const nodeConsumerResult = runCommand([
    "bunx",
    "tsc",
    "-p",
    "tests/repro/package-consumer/tsconfig.json",
  ])
  const nodeCompilerOutput = decodeOutput(nodeConsumerResult)
  const es2020ConsumerResult = runCommand([
    "bunx",
    "tsc",
    "-p",
    "tests/repro/package-consumer/tsconfig-bundler.json",
  ])
  const es2020CompilerOutput = decodeOutput(es2020ConsumerResult)

  expect(nodeConsumerResult.exitCode).not.toBe(0)
  expect(nodeCompilerOutput).toContain("TS2835")
  expect(es2020ConsumerResult.exitCode).not.toBe(0)
  expect(es2020CompilerOutput).toContain("TS2550")

  const statusSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="260" viewBox="0 0 900 260">
      <rect width="900" height="260" rx="18" fill="#fff7f7" />
      <rect x="28" y="28" width="844" height="204" rx="14" fill="#ffffff" stroke="#dc2626" stroke-width="3" />
      <circle cx="76" cy="77" r="20" fill="#dc2626" />
      <path d="M68 69 L84 85 M84 69 L68 85" stroke="#ffffff" stroke-width="5" stroke-linecap="round" />
      <text x="112" y="84" font-family="sans-serif" font-size="27" font-weight="700" fill="#991b1b">ES2020 Node consumer: compile failed</text>
      <text x="52" y="132" font-family="monospace" font-size="17" fill="#374151">package export: ./lib/index.ts (repository source)</text>
      <text x="52" y="166" font-family="monospace" font-size="17" fill="#374151">consumer: target ES2020 + moduleResolution Node16</text>
      <text x="52" y="200" font-family="sans-serif" font-size="18" fill="#991b1b">Node16 resolution fails (TS2835); ES2020 library support fails (TS2550).</text>
    </svg>
  `

  await expect(statusSvg).toMatchSvgSnapshot(import.meta.path)
})

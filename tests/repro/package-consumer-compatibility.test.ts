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

test("published package supports Node16 resolution and ES2020 consumers", async () => {
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

  expect(nodeConsumerResult.exitCode, nodeCompilerOutput).toBe(0)
  expect(es2020ConsumerResult.exitCode, es2020CompilerOutput).toBe(0)

  const statusSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="260" viewBox="0 0 900 260">
      <rect width="900" height="260" rx="18" fill="#f0fdf4" />
      <rect x="28" y="28" width="844" height="204" rx="14" fill="#ffffff" stroke="#16a34a" stroke-width="3" />
      <circle cx="76" cy="77" r="20" fill="#16a34a" />
      <path d="M66 77 L73 84 L87 68" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
      <text x="112" y="84" font-family="sans-serif" font-size="27" font-weight="700" fill="#166534">ES2020 Node consumer: compile passed</text>
      <text x="52" y="132" font-family="monospace" font-size="17" fill="#374151">artifacts: dist/index.js + dist/index.d.ts</text>
      <text x="52" y="166" font-family="monospace" font-size="17" fill="#374151">consumer: target ES2020 + moduleResolution Node16</text>
      <text x="52" y="200" font-family="sans-serif" font-size="18" fill="#166534">Built JavaScript and declarations isolate consumers from source settings.</text>
    </svg>
  `

  await expect(statusSvg).toMatchSvgSnapshot(import.meta.path)
})

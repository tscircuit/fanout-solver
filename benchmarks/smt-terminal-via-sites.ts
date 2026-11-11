import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { writeFileSync } from "node:fs"
import { createSmtTerminalViaSiteFixture } from "../tests/fixtures/smt-terminal-via-sites"
const { matchComponentDogboneViaSites, validateRoutedCopperDrc } = await import(
    pathToFileURL(resolve(process.argv[2] ?? "lib/index.ts")).href
  ),
  { bus, input, rules } = createSmtTerminalViaSiteFixture(),
  start = performance.now(),
  before = JSON.stringify(input)
let completed = 0,
  sites: any
for (let i = 0; i < 200; i++) {
  sites = matchComponentDogboneViaSites([bus], rules)
  if (sites?.size === 2) completed++
}
const report = {
  revision: Bun.spawnSync([
    "git",
    "-C",
    resolve(process.argv[2] ?? "lib/index.ts", "../.."),
    "rev-parse",
    "HEAD",
  ])
    .stdout.toString()
    .trim(),
  runtime: Bun.version,
  attempts: 200,
  completed,
  assigned: sites?.size ?? 0,
  seconds: (performance.now() - start) / 1000,
  inputUnchanged: JSON.stringify(input) === before,
  sites: sites ? [...sites] : [],
}
console.log(JSON.stringify(report, null, 2))
if (process.argv[3])
  writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n")
if (completed !== 200 || !report.inputUnchanged) process.exitCode = 1

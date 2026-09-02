import { readdirSync } from "node:fs"
import { join } from "node:path"

const [rawShardNumber, rawShardCount] = Bun.argv.slice(2)
const shardNumber = Number(rawShardNumber)
const shardCount = Number(rawShardCount)

if (
  !Number.isInteger(shardNumber) ||
  !Number.isInteger(shardCount) ||
  shardCount <= 0 ||
  shardNumber <= 0 ||
  shardNumber > shardCount
) {
  throw new Error(
    "Usage: bun scripts/run-test-shard.ts <one-based-shard-number> <shard-count>",
  )
}

const collectTestFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectTestFiles(path)
    return entry.isFile() && /\.(test|spec)\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })

const allTestFiles = collectTestFiles("tests").sort()
const selectedTestFiles = allTestFiles.filter(
  (_, testIndex) => testIndex % shardCount === shardNumber - 1,
)

if (selectedTestFiles.length === 0) {
  throw new Error(
    `Test shard ${shardNumber}/${shardCount} does not contain any files`,
  )
}

console.log(
  `Running test shard ${shardNumber}/${shardCount}: ${selectedTestFiles.length} of ${allTestFiles.length} files`,
)
for (const testFile of selectedTestFiles) console.log(`- ${testFile}`)

const testProcess = Bun.spawn(["bun", "test", ...selectedTestFiles], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await testProcess.exited)

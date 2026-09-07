import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { release } from "node:os"

// Read-only, once-per-shard provenance for the temporary PR #186 diagnostics.
const directory = ".ci-routing-diagnostics"
mkdirSync(directory, { recursive: true })
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex")
const fileHash = (path: string) =>
  existsSync(path) ? hash(readFileSync(path)) : null
const nativeEntry = Bun.resolveSync(
  "@tscircuit/capacity-autorouter",
  process.cwd(),
)
const contexts = [
  { name: "checkout", directory: process.cwd() },
  { name: "capacity-autorouter", directory: dirname(nativeEntry) },
]
const modules = contexts.flatMap((context) =>
  [
    "@tscircuit/capacity-autorouter",
    "@tscircuit/solver-utils",
    "object-hash",
    "fast-json-stable-stringify",
    "graphics-debug",
    "flatbush",
    "bun-match-svg",
  ].map((name) => {
    try {
      const entry = realpathSync(Bun.resolveSync(name, context.directory))
      let packageDirectory = dirname(entry)
      while (!existsSync(join(packageDirectory, "package.json"))) {
        const parent = dirname(packageDirectory)
        if (parent === packageDirectory)
          throw new Error(`No package.json for ${name}`)
        packageDirectory = parent
      }
      const packagePath = join(packageDirectory, "package.json")
      const metadata = JSON.parse(readFileSync(packagePath, "utf8"))
      return {
        context: context.name,
        requested: name,
        name: metadata.name,
        version: metadata.version,
        entry,
        entrySha256: fileHash(entry),
        packageSha256: fileHash(packagePath),
      }
    } catch (error) {
      return { context: context.name, requested: name, error: String(error) }
    }
  }),
)
const nativeSourceMap = `${nativeEntry}.map`
let nativeSources: { path: string; sha256: string | null }[] = []
if (existsSync(nativeSourceMap)) {
  const map = JSON.parse(readFileSync(nativeSourceMap, "utf8")) as {
    sources: string[]
    sourcesContent?: (string | null)[]
  }
  nativeSources = map.sources.flatMap((path, index) =>
    /A03|PortfolioSingleIntraNode|cloneAndShuffleArray|object-hash/i.test(path)
      ? [
          {
            path,
            sha256:
              map.sourcesContent?.[index] == null
                ? null
                : hash(map.sourcesContent[index]!),
          },
        ]
      : [],
  )
}
const sourceFiles = [
  ...Array.from(new Bun.Glob("lib/**/*.ts").scanSync({ cwd: process.cwd() })),
  "package.json",
  "scripts/generate-repro/package.json",
  "bun.lock",
  "bun.lockb",
  ...Array.from(
    new Bun.Glob("tests/fixtures/dataset31-imx6ull-*.json").scanSync({
      cwd: process.cwd(),
    }),
  ),
]
  .sort()
  .map((path) => ({ path, sha256: fileHash(path) }))
const graph = Bun.spawnSync([process.execPath, "pm", "ls", "--all"], {
  stdout: "pipe",
  stderr: "pipe",
})
writeFileSync(
  join(directory, "bun-dependency-graph.txt"),
  `${graph.stdout.toString()}\n${graph.stderr.toString()}`,
)
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  stdout: "pipe",
  stderr: "pipe",
})
const report = {
  shard: process.argv[2] ?? "local",
  commit: revision.stdout.toString().trim(),
  runtime: {
    bun: Bun.version,
    bunRevision: Bun.revision,
    executable: process.execPath,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    versions: process.versions,
  },
  modules,
  nativeSourceMap: {
    path: relative(process.cwd(), nativeSourceMap),
    sha256: fileHash(nativeSourceMap),
    sources: nativeSources,
  },
  sourceFiles,
  dependencyGraphExitCode: graph.exitCode,
}
writeFileSync(
  join(directory, "provenance.json"),
  `${JSON.stringify(report, null, 2)}\n`,
)
console.log(
  JSON.stringify(
    {
      diagnostic: "routing-provenance",
      shard: report.shard,
      runtime: report.runtime,
      nativeSources,
      modules,
      sourceFileCount: sourceFiles.length,
    },
    null,
    2,
  ),
)

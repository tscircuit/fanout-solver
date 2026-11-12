import { expect, test } from "bun:test"
import { resolve } from "node:path"
import ts from "typescript"

test("motor-controller autorouter accepts the public fanout bus declaration", () => {
  const fixture = resolve(
    import.meta.dir,
    "fixtures/rp2040-motor-controller-types/tsconfig.json",
  )
  const config = ts.readConfigFile(fixture, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(fixture, ".."),
  )
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  // Other solver implementations use the repo's older autorouter contract.
  // This consumer compatibility check deliberately targets the public bus API;
  // the ordinary typecheck covers all implementations against the pinned API.
  const files = [
    resolve(import.meta.dir, "../lib/types.ts"),
    resolve(import.meta.dir, "fixtures/rp2040-motor-controller-types/index.ts"),
  ].map((path) => {
    const file = program.getSourceFile(path)
    if (!file) throw new Error(`Type reproduction did not load ${path}`)
    return file
  })
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...files.flatMap((file) => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]),
  ]
  expect(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
  ).toEqual([])
})

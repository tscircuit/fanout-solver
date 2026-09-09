import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("failed SVG comparisons retain exact received artifacts and passing comparisons keep the original matcher behavior", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fanout-svg-artifact-"))
  try {
    // Isolate the matcher from a parent `bun test -u` or snapshot-update env.
    const fixture = join(directory, "fixture.test.tsx")
    const script = join(directory, "verify.ts")
    const expected =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>'
    const received = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">
<!-- preserve exact received bytes -->
<rect width="8" height="8" fill="blue"/>
</svg>
`
    writeFileSync(
      script,
      `import { expect as matcherExpect } from "bun:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import "${import.meta.resolve("bun-match-svg")}";
import { expectSvgSnapshotWithActual } from ${JSON.stringify(import.meta.resolve("./fixtures/expect-svg-snapshot-with-actual"))}
const fixture = ${JSON.stringify(fixture)}
const snapshots = ${JSON.stringify(join(directory, "__snapshots__"))}
const expected = ${JSON.stringify(expected)}
const received = ${JSON.stringify(received)}
mkdirSync(snapshots)
for (const name of [undefined, "named"]) {
  const stem = snapshots + '/fixture' + (name ? '-' + name : '')
  writeFileSync(stem + '.snap.svg', expected)
  await expectSvgSnapshotWithActual(expected, fixture, name)
  assert.equal(existsSync(stem + '.actual.svg'), false)
  const visuallyEqual = expected.replace('</svg>', '<!-- no visual change --></svg>')
  await expectSvgSnapshotWithActual(visuallyEqual, fixture, name)
  assert.equal(readFileSync(stem + '.snap.svg', 'utf8'), expected)
  assert.equal(existsSync(stem + '.actual.svg'), false)
  await assert.rejects(expectSvgSnapshotWithActual(received, fixture, name), /Snapshot does not match/)
  assert.equal(readFileSync(stem + '.actual.svg', 'utf8'), received)
  assert.equal(readFileSync(stem + '.snap.svg', 'utf8'), expected)
  assert.equal(existsSync(stem + '.diff.png'), true)
}
const originalError = new Error('original matcher failure')
matcherExpect.extend({ toMatchSvgSnapshot() { throw originalError } })
await assert.rejects(expectSvgSnapshotWithActual(received, fixture), error => error === originalError)
assert.equal(readFileSync(snapshots + '/fixture.actual.svg', 'utf8'), received)
console.log('passing, named, failed, original error, and exact artifact checks passed')
`,
    )
    const env = { ...process.env }
    delete env.BUN_UPDATE_SNAPSHOTS
    delete env.FORCE_BUN_UPDATE_SNAPSHOTS
    const child = Bun.spawn([process.execPath, script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("exact artifact checks passed")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

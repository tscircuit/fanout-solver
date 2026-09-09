import { expect } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/** Retain the exact received SVG when the existing snapshot matcher fails. */
export async function expectSvgSnapshotWithActual(
  svg: string,
  testPath: string,
  name?: string,
) {
  try {
    return await expect(svg).toMatchSvgSnapshot(testPath, name)
  } catch (error) {
    // Follow bun-match-svg's test suffix and optional snapshot name convention.
    const base = testPath.replace(/\.test\.tsx?$/, "")
    const directory = join(dirname(base), "__snapshots__")
    const filename = `${basename(base)}${name ? `-${name}` : ""}.actual.svg`
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, filename), svg)
    } catch (artifactError) {
      console.error("Could not save received SVG snapshot:", artifactError)
    }
    throw error
  }
}

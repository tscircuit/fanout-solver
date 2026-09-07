import { expect, test } from "bun:test"
import { StaticEdgeClearanceCache } from "lib/static-edge-clearance-cache"

test("static edge cache preserves exact collisions, owners, layers, and uncached terminal connectors", () => {
  const planeSize = 128
  const cache = new StaticEdgeClearanceCache(planeSize, 2)
  const origin = 35
  // These different targets share the same compact slot. They must retain
  // independent clear, blocked, and owner-specific classifications.
  cache.set(origin, 0, true)
  cache.set(origin, 17, false)
  cache.set(origin, 34, "first-owner")
  cache.set(origin, 51, "second-owner")
  expect(cache.get(origin, 0)).toBe(true)
  expect(cache.get(origin, 17)).toBe(false)
  expect(cache.get(origin, 34)).toBe("first-owner")
  expect(cache.get(origin, 51)).toBe("second-owner")
  expect(cache.get(origin, 68)).toBeUndefined()
  expect(cache.get(34, origin)).toBeUndefined()
  expect(cache.get(origin + planeSize, 17)).toBeUndefined()
  cache.set(origin + planeSize, 17, true)
  expect(cache.get(origin + planeSize, 17)).toBe(true)
  expect(cache.get(origin, 17)).toBe(false)

  // The active source/exit may be off-grid even when its cell is unchanged.
  // A terminal check must neither reuse nor overwrite the grid-edge answer.
  expect(cache.get(origin, 17, true)).toBeUndefined()
  cache.set(origin, 17, true, true)
  expect(cache.get(origin, 17)).toBe(false)
  cache.set(origin, 68, "terminal-owner", true)
  expect(cache.get(origin, 68)).toBeUndefined()

  // Exercise primary slots and collisions across both layers against exact
  // directed keys, including repeated ownership and classification updates.
  const expected = new Map<number, boolean | string>()
  for (let from = 0; from < planeSize * 2; from++) {
    for (let to = 0; to < planeSize; to += 7) {
      const value =
        (from + to) % 3 === 0
          ? true
          : (from + to) % 3 === 1
            ? false
            : `owner-${to % 5}`
      cache.set(from, to, value)
      expected.set(from * planeSize + to, value)
    }
  }
  for (const [key, value] of expected)
    expect(cache.get(Math.floor(key / planeSize), key % planeSize)).toBe(value)
})

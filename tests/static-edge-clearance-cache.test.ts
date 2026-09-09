import { expect, test } from "bun:test"
import { StaticEdgeClearanceCache } from "lib/static-edge-clearance-cache"

test("static edge cache preserves native neighbors, via cells, exact fallback keys, owners, layers, and uncached terminal connectors", () => {
  const planeSize = 128
  const neighborOffset = new Int32Array(planeSize + 1)
  const neighbors: number[] = []
  for (let cell = 0; cell < planeSize; cell++) {
    neighborOffset[cell] = neighbors.length
    // Irregular degrees and long edges also cover extended terminal neighbors.
    // Cell 34 has no neighbors, and cell 35 has more than sixteen.
    if (cell !== 34)
      neighbors.push(
        ...(cell === 35
          ? Array.from({ length: 20 }, (_, i) => (i * 17) % planeSize)
          : [0, 17, 34, 51]),
      )
  }
  neighborOffset[planeSize] = neighbors.length
  const neighborIds = Int32Array.from(neighbors)
  const originalOffsets = neighborOffset.slice()
  const originalIds = neighborIds.slice()
  const cache = new StaticEdgeClearanceCache(
    planeSize,
    2,
    neighborOffset,
    neighborIds,
  )
  const origin = 35
  // These different targets used to share a compact hash slot. Exact native
  // neighbor entries retain independent owner and clearance classifications.
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

  // Same-cell moves on each layer have separate slots for their via checks.
  cache.set(origin, origin, "via-owner")
  cache.set(origin + planeSize, origin, false)
  cache.set(34, 34, true)
  expect(cache.get(origin, origin)).toBe("via-owner")
  expect(cache.get(origin + planeSize, origin)).toBe(false)
  expect(cache.get(34, 34)).toBe(true)

  // A key outside the supplied topology remains independently cacheable.
  cache.set(34, origin, "non-neighbor")
  cache.set(34 + planeSize, origin, false)
  expect(cache.get(34, origin)).toBe("non-neighbor")
  expect(cache.get(34 + planeSize, origin)).toBe(false)
  cache.set(34, origin, true)
  expect(cache.get(34, origin)).toBe(true)

  // The active source/exit may be off-grid even when its cell is unchanged.
  // A terminal check must neither reuse nor overwrite any grid-edge answer.
  expect(cache.get(origin, 17, true)).toBeUndefined()
  cache.set(origin, 17, true, true)
  expect(cache.get(origin, 17)).toBe(false)
  cache.set(origin, 68, "terminal-owner", true)
  expect(cache.get(origin, 68)).toBeUndefined()
  expect(cache.get(34, origin, true)).toBeUndefined()
  cache.set(34, origin, false, true)
  expect(cache.get(34, origin)).toBe(true)

  // Exercise every exact key across two layers, including non-neighbors and
  // repeated ownership/classification updates, against an independent oracle.
  const expected = new Map<number, boolean | string>()
  for (let from = 0; from < planeSize * 2; from++) {
    for (let to = 0; to < planeSize; to++) {
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

  // Owner codes remain 32-bit; repeated updates must not wrap at 65535.
  cache.set(origin, 0, "retained-owner")
  for (let i = 0; i < 70_000; i++) cache.set(origin, 17, `distinct-owner-${i}`)
  expect(cache.get(origin, 17)).toBe("distinct-owner-69999")
  expect(cache.get(origin, 0)).toBe("retained-owner")
  expect(neighborOffset).toEqual(originalOffsets)
  expect(neighborIds).toEqual(originalIds)
})

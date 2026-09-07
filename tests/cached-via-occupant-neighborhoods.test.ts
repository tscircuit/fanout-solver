import { expect, test } from "bun:test"
import { cacheViaOccupantNeighborhoods } from "lib/cache-via-occupant-neighborhoods"

test("cached native via neighborhoods preserve order and read fresh owners after rip-ups", () => {
  const makeRouter = () => ({
    _viaOccs: [] as number[],
    owners: new Map<number, number[]>([
      [0, [3]],
      [2, [7]],
      [3, [2, 3]],
      [7, [5, 2]],
    ]),
    visited: [] as number[],
    traversals: 0,
    failNext: false,
    fillViaOccupants(cell: number, active: number) {
      this.traversals++
      this._viaOccs.length = 0
      const neighborhood = cell === 4 ? [7, 3, 3, 0] : [2, 7, 0]
      for (const flat of neighborhood) {
        this.pushFlatOccupants(flat, active, this._viaOccs)
        if (this.failNext) {
          this.failNext = false
          throw new Error("interrupted native traversal")
        }
      }
    },
    pushFlatOccupants(flat: number, active: number, out: number[]) {
      this.visited.push(flat)
      for (const owner of this.owners.get(flat) ?? [])
        if (owner !== active && !out.includes(owner)) out.push(owner)
    },
  })
  const native = makeRouter()
  const cached = makeRouter()
  cacheViaOccupantNeighborhoods(cached)
  const compare = (cell: number, active: number) => {
    native.visited.length = 0
    cached.visited.length = 0
    native.fillViaOccupants(cell, active)
    cached.fillViaOccupants(cell, active)
    expect(cached.visited).toEqual(native.visited)
    expect(cached._viaOccs).toEqual(native._viaOccs)
  }
  compare(4, 3)
  expect(cached._viaOccs).toEqual([5, 2])
  for (const router of [native, cached]) {
    router.owners.set(3, [9, 3])
    router.owners.set(7, [5])
  }
  compare(4, 3)
  expect(cached._viaOccs).toEqual([5, 9])
  compare(4, 5)
  expect(cached._viaOccs).toEqual([9, 3])
  compare(5, 7)
  for (const router of [native, cached]) router.owners.clear()
  compare(4, 3)
  expect(cached._viaOccs).toEqual([])
  expect(cached.traversals).toBe(2)
  expect(native.traversals).toBe(5)

  const push = cached.pushFlatOccupants
  cached.failNext = true
  expect(() => cached.fillViaOccupants(6, 3)).toThrow(
    "interrupted native traversal",
  )
  expect(cached.pushFlatOccupants).toBe(push)
  compare(6, 3)
  expect(cached.traversals).toBe(4)
})

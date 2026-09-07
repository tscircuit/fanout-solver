import { expect, test } from "bun:test"
import { cacheViaOccupantNeighborhoods } from "../lib/cache-via-occupant-neighborhoods"

test("cached via neighborhoods skip only cells without live primary or shared owners", () => {
  const makeRouter = () => ({
    _viaOccs: [] as number[],
    usedCellsFlat: Int32Array.from([4, -1, 5, -1]),
    sharedCellsFlat: [undefined, [7], [8], undefined] as (
      | number[]
      | undefined
    )[],
    visits: 0,
    fillViaOccupants(_cell: number, active: number) {
      this._viaOccs.length = 0
      for (const flat of [0, 1, 2, 3])
        this.pushFlatOccupants(flat, active, this._viaOccs)
    },
    pushFlatOccupants(flat: number, active: number, out: number[]) {
      this.visits++
      for (const owner of [
        this.usedCellsFlat[flat]!,
        ...(this.sharedCellsFlat[flat] ?? []),
      ])
        if (owner !== -1 && owner !== active && !out.includes(owner))
          out.push(owner)
    },
  })
  const native = makeRouter()
  const cached = makeRouter()
  cacheViaOccupantNeighborhoods(cached)
  const compare = () => {
    native.visits = cached.visits = 0
    native.fillViaOccupants(0, 4)
    cached.fillViaOccupants(0, 4)
    expect(cached._viaOccs).toEqual(native._viaOccs)
  }
  compare()
  expect(cached._viaOccs).toEqual([7, 5, 8])
  expect(cached.visits).toBe(4)
  compare()
  expect(cached.visits).toBe(3)
  // A formerly empty cell gains an owner while an occupied cell is ripped up.
  for (const router of [native, cached]) {
    router.usedCellsFlat[2] = -1
    router.sharedCellsFlat[2] = undefined
    router.usedCellsFlat[3] = 9
  }
  compare()
  expect(cached._viaOccs).toEqual([7, 9])
  expect(cached.visits).toBe(3)
  // A search may replace its occupancy stores; do not retain the old arrays.
  for (const router of [native, cached]) {
    router.usedCellsFlat = Int32Array.from([-1, -1, -1, -1])
    router.sharedCellsFlat = [undefined, undefined, [11], undefined]
  }
  compare()
  expect(cached._viaOccs).toEqual([11])
  expect(cached.visits).toBe(1)
})

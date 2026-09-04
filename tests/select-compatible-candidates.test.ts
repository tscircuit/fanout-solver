import { expect, test } from "bun:test"
import { selectCompatibleCandidates } from "lib/select-compatible-candidates"

test("selects one compatible value from each independent candidate group", () => {
  const candidateSets = [
    Array.from({ length: 24 }, (_, value) => ({ group: 0, value })),
    Array.from({ length: 24 }, (_, value) => ({ group: 1, value })),
    Array.from({ length: 24 }, (_, value) => ({ group: 2, value })),
  ]
  const result = selectCompatibleCandidates({
    candidateSets,
    maximumSearchStates: 10_000,
    areCompatible: (first, second) =>
      first.group === second.group || first.value === second.value,
  })

  expect(result.selection).toHaveLength(3)
  expect(new Set(result.selection?.map(({ value }) => value)).size).toBe(1)
  expect(result.searchStates).toBeLessThan(100)
  expect(result.emptyDomainIndices).toEqual([])
})

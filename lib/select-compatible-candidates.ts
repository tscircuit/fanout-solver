/**
 * Select one candidate per group under a symmetric pairwise constraint.
 * Arc consistency exposes impossible groups early; deterministic min-conflicts
 * and bounded backtracking handle the remaining nonlocal choices.
 */
export function selectCompatibleCandidates<T>(params: {
  candidateSets: readonly (readonly T[])[]
  areCompatible: (first: T, second: T) => boolean
  maximumSearchStates: number
}): {
  selection: T[] | null
  searchStates: number
  emptyDomainIndices: number[]
  conflictDomainIndices: number[]
} {
  const candidates = params.candidateSets.flat()
  const count = candidates.length
  const compatibility = new Uint8Array(count * count)
  const emptyDomainIndices = new Set<number>()
  const revisionParent = new Map<number, number>()
  let nextIndex = 0
  const initialDomains = params.candidateSets.map((set) =>
    set.map(() => nextIndex++),
  )
  let searchStates = 0
  const compatible = (first: number, second: number): boolean => {
    const index = Math.min(first, second) * count + Math.max(first, second)
    const cached = compatibility[index]!
    if (cached) return cached === 1
    const result = params.areCompatible(candidates[first]!, candidates[second]!)
    compatibility[index] = result ? 1 : 2
    return result
  }
  const neighbors = initialDomains.map(() => [] as number[])
  for (let first = 0; first < initialDomains.length; first++) {
    for (let second = first + 1; second < initialDomains.length; second++) {
      if (
        initialDomains[first]!.some((a) =>
          initialDomains[second]!.some((b) => !compatible(a, b)),
        )
      ) {
        neighbors[first]!.push(second)
        neighbors[second]!.push(first)
      }
    }
  }
  const propagate = (
    domains: number[][],
    indices: number[],
    changed?: number,
  ): boolean => {
    const queue: Array<[number, number]> = []
    let allDomainsRemainNonempty = true
    for (const first of indices) {
      if (domains[first]!.length === 0) {
        emptyDomainIndices.add(first)
        allDomainsRemainNonempty = false
        continue
      }
      for (const second of neighbors[first]!) {
        if (
          indices.includes(second) &&
          (changed === undefined || second === changed)
        )
          queue.push([first, second])
      }
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [first, second] = queue[cursor]!
      if (domains[first]!.length === 0 || domains[second]!.length === 0)
        continue
      const retained = domains[first]!.filter((candidate) =>
        domains[second]!.some((other) => compatible(candidate, other)),
      )
      if (retained.length === domains[first]!.length) continue
      revisionParent.set(first, second)
      domains[first] = retained
      if (retained.length === 0) {
        emptyDomainIndices.add(first)
        allDomainsRemainNonempty = false
        continue
      }
      for (const neighbor of neighbors[first]!) {
        if (neighbor !== second && indices.includes(neighbor))
          queue.push([neighbor, first])
      }
    }
    return allDomainsRemainNonempty
  }
  const allIndices = initialDomains.map((_, index) => index)
  const getConflictDomainIndices = (seeds: readonly number[]): number[] => {
    const pending = [...seeds]
    const seen = new Set(pending)
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const parent = revisionParent.get(pending[cursor]!)
      if (parent !== undefined && !seen.has(parent)) {
        seen.add(parent)
        pending.push(parent)
      }
    }
    return [...seen]
  }
  const rootDomains = initialDomains.map((domain) => [...domain])
  if (!propagate(rootDomains, allIndices)) {
    return {
      selection: null,
      searchStates,
      emptyDomainIndices: [...emptyDomainIndices],
      conflictDomainIndices: getConflictDomainIndices([...emptyDomainIndices]),
    }
  }
  const findLocallyCompatibleSelection = (): number[] | null => {
    const restartCount = 12
    const stepsPerRestart = Math.max(
      1,
      Math.min(5_000, Math.floor(params.maximumSearchStates / restartCount)),
    )
    for (let restart = 0; restart < restartCount; restart++) {
      const selection = rootDomains.map(
        (domain, index) => domain[(restart * 17 + index * 7) % domain.length]!,
      )
      for (let step = 0; step < stepsPerRestart; step++) {
        const conflictCounts = selection.map(() => 0)
        for (let first = 0; first < selection.length; first++) {
          for (const second of neighbors[first]!) {
            if (
              second <= first ||
              compatible(selection[first]!, selection[second]!)
            )
              continue
            conflictCounts[first]++
            conflictCounts[second]++
          }
        }
        const maximumConflictCount = Math.max(...conflictCounts)
        if (maximumConflictCount === 0) return selection
        const conflicted = conflictCounts
          .map((conflicts, index) => ({ conflicts, index }))
          .filter(({ conflicts }) => conflicts === maximumConflictCount)
        const selected = conflicted[(step + restart) % conflicted.length]!.index
        const scored = rootDomains[selected]!.map((candidate, index) => ({
          candidate,
          index,
          conflicts: neighbors[selected]!.filter(
            (neighbor) => !compatible(candidate, selection[neighbor]!),
          ).length,
        })).toSorted(
          (first, second) =>
            first.conflicts - second.conflicts ||
            ((first.index - step - restart) % rootDomains[selected]!.length) -
              ((second.index - step - restart) % rootDomains[selected]!.length),
        )
        selection[selected] = scored[0]!.candidate
      }
    }
    return null
  }
  const locallyCompatibleSelection = findLocallyCompatibleSelection()
  if (locallyCompatibleSelection) {
    return {
      selection: locallyCompatibleSelection.map((index) => candidates[index]!),
      searchStates,
      emptyDomainIndices: [],
      conflictDomainIndices: [],
    }
  }
  const search = (
    domains: number[][],
    indices: number[],
    changed?: number,
  ): number[][] | null => {
    if (!propagate(domains, indices, changed)) return null
    const pending = new Set(
      indices.filter((index) => domains[index]!.length > 1),
    )
    const components: number[][] = []
    while (pending.size > 0) {
      const component = [pending.values().next().value!]
      pending.delete(component[0]!)
      for (let cursor = 0; cursor < component.length; cursor++) {
        for (const neighbor of neighbors[component[cursor]!]!) {
          if (pending.delete(neighbor)) component.push(neighbor)
        }
      }
      components.push(component)
    }
    if (components.length > 1) {
      let combined = domains
      for (const component of components) {
        const solved = search(combined.slice(), component)
        if (!solved) return null
        combined = solved
      }
      return combined
    }
    let selected = -1
    for (const index of indices) {
      if (
        domains[index]!.length > 1 &&
        (selected < 0 || domains[index]!.length < domains[selected]!.length)
      )
        selected = index
    }
    if (selected < 0) return domains
    const orderedCandidates = domains[selected]!.map((candidate) => {
      const supportCounts = neighbors[selected]!.filter(
        (neighbor) =>
          indices.includes(neighbor) && domains[neighbor]!.length > 1,
      ).map(
        (neighbor) =>
          domains[neighbor]!.filter((other) => compatible(candidate, other))
            .length,
      )
      return {
        candidate,
        minimumSupport: Math.min(...supportCounts),
        totalSupport: supportCounts.reduce((sum, count) => sum + count, 0),
      }
    }).toSorted(
      (first, second) =>
        second.minimumSupport - first.minimumSupport ||
        second.totalSupport - first.totalSupport,
    )
    for (const { candidate } of orderedCandidates) {
      if (searchStates >= params.maximumSearchStates) return null
      searchStates++
      const nextDomains = domains.slice()
      nextDomains[selected] = [candidate]
      const result = search(nextDomains, indices, selected)
      if (result) return result
    }
    return null
  }
  const result = search(rootDomains, allIndices)
  const diagnosticIndices =
    emptyDomainIndices.size > 0 || result
      ? [...emptyDomainIndices]
      : [
          allIndices.toSorted(
            (first, second) =>
              neighbors[second]!.length - neighbors[first]!.length ||
              rootDomains[first]!.length - rootDomains[second]!.length,
          )[0]!,
        ]
  return {
    selection: result?.map((domain) => candidates[domain[0]!]!) ?? null,
    searchStates,
    emptyDomainIndices: diagnosticIndices,
    conflictDomainIndices: result
      ? []
      : getConflictDomainIndices(diagnosticIndices),
  }
}

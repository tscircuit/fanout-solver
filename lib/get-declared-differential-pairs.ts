import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export interface DeclaredDifferentialPair {
  connectionNames: [string, string]
  connectionIndices: [number, number]
  lengthTolerance: number
}

/** Resolve only original connection identities; electrical aliases are not pair names. */
export function getDeclaredDifferentialPairs(
  srj: SimpleRouteJson,
): DeclaredDifferentialPair[] {
  const declarations: unknown = srj.differentialPairs
  if (declarations === undefined) return []
  if (!Array.isArray(declarations))
    throw new Error("Differential pairs must be an array")
  const indicesByName = new Map<string, number[]>()
  srj.connections.forEach((connection, index) => {
    const indices = indicesByName.get(connection.name) ?? []
    indices.push(index)
    indicesByName.set(connection.name, indices)
  })
  return declarations.map((value: unknown, index) => {
    const pair = value as {
      connectionNames?: unknown
      lengthTolerance?: unknown
    } | null
    const names = pair?.connectionNames
    const tolerance = pair?.lengthTolerance
    if (
      !Array.isArray(names) ||
      names.length !== 2 ||
      names.some((name) => typeof name !== "string" || name.length === 0) ||
      names[0] === names[1] ||
      typeof tolerance !== "number" ||
      !Number.isFinite(tolerance) ||
      tolerance < 0
    )
      throw new Error(
        `Differential pair ${index} requires two distinct connection names and a finite nonnegative tolerance`,
      )
    const indices = names.map((name) => {
      const resolved = indicesByName.get(name)
      if (resolved?.length !== 1)
        throw new Error(
          `Differential pair ${index} cannot resolve original connection ${name}`,
        )
      return resolved[0]!
    })
    return {
      connectionNames: names as [string, string],
      connectionIndices: indices as [number, number],
      lengthTolerance: tolerance,
    }
  })
}

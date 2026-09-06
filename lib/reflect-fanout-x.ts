/**
 * View horizontal fanout geometry from its opposite edge. A shared memo keeps
 * pad identity intact: clearance checks compare a plan's sourceObstacle with
 * the same obstacle in the transformed SRJ.
 */
export function reflectFanoutX<T>(value: T): T {
  const memo = new Map<object, unknown>()
  const reflect = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item
    if (memo.has(item)) return memo.get(item)
    if (item instanceof Map) {
      const result = new Map()
      memo.set(item, result)
      for (const [key, entry] of item) result.set(key, reflect(entry))
      return result
    }
    if (item instanceof Set) {
      const result = new Set(item)
      memo.set(item, result)
      return result
    }
    if (Array.isArray(item)) {
      const result: unknown[] = []
      memo.set(item, result)
      for (const entry of item) result.push(reflect(entry))
      return result
    }
    const original = item as Record<string, unknown>
    const result: Record<string, unknown> = {}
    memo.set(item, result)
    for (const [key, entry] of Object.entries(original))
      result[key] = reflect(entry)
    if (typeof original.x === "number" && typeof original.y === "number")
      result.x = -original.x
    if (
      typeof original.minX === "number" &&
      typeof original.maxX === "number"
    ) {
      result.minX = -original.maxX
      result.maxX = -original.minX
    }
    if (Array.isArray(original.xCoordinates))
      result.xCoordinates = original.xCoordinates
        .map((x: number) => -x)
        .sort((a, b) => a - b)
    if (typeof original.ccwRotationDegrees === "number")
      result.ccwRotationDegrees = -original.ccwRotationDegrees
    const edge = (direction: string) =>
      direction === "left"
        ? "right"
        : direction === "right"
          ? "left"
          : direction
    for (const key of ["direction", "exitEdge", "preferredExit"] as const) {
      if (typeof original[key] === "string")
        result[key] = original[key].split("-").map(edge).join("-")
    }
    if (
      original.cornerBandSide &&
      (original.exitEdge === "top" || original.exitEdge === "bottom")
    )
      result.cornerBandSide =
        original.cornerBandSide === "minimum" ? "maximum" : "minimum"
    return result
  }
  return reflect(value) as T
}

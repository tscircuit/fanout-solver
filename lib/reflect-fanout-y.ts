const reflectedDirection: Readonly<Record<string, string>> = {
  up: "down",
  down: "up",
  top: "bottom",
  bottom: "top",
  "top-left": "bottom-left",
  "bottom-left": "top-left",
  "top-right": "bottom-right",
  "bottom-right": "top-right",
  rightside_top: "rightside_bottom",
  rightside_bottom: "rightside_top",
  leftside_top: "leftside_bottom",
  leftside_bottom: "leftside_top",
}

/**
 * Reflect fanout routing geometry across the board-world X axis. Coordinates
 * are millimetre points in the usual right-handed PCB frame (+Y is top); PCB
 * layer names are unchanged, while Y directions and corner bands are swapped.
 * Shared object identity is retained so source-pad clearance exemptions remain
 * attached to the corresponding reflected SRJ obstacle.
 */
export function reflectFanoutY<T>(value: T): T {
  const reflectedObjects = new WeakMap<object, unknown>()
  const reflect = (current: unknown, key?: string): unknown => {
    if (typeof current === "number") {
      if (key === "y" || key === "ccwRotationDegrees") return -current
      return current
    }
    if (typeof current === "string") {
      if (key === "cornerBandSide") {
        if (current === "minimum") return "maximum"
        if (current === "maximum") return "minimum"
      }
      if (
        key === "direction" ||
        key === "exitEdge" ||
        key === "preferredExit" ||
        key === "exitPosition"
      )
        return reflectedDirection[current] ?? current
      return current
    }
    if (current === null || typeof current !== "object") return current
    const existing = reflectedObjects.get(current)
    if (existing !== undefined) return existing
    if (Array.isArray(current)) {
      const result: unknown[] = []
      reflectedObjects.set(current, result)
      result.push(...current.map((item) => reflect(item)))
      return result
    }
    if (current instanceof Map) {
      const result = new Map()
      reflectedObjects.set(current, result)
      for (const [mapKey, mapValue] of current)
        result.set(mapKey, reflect(mapValue))
      return result
    }
    if (current instanceof Set) {
      const result = new Set(current)
      reflectedObjects.set(current, result)
      return result
    }

    const source = current as Record<string, unknown>
    const result: Record<string, unknown> = {}
    reflectedObjects.set(current, result)
    for (const [childKey, childValue] of Object.entries(source)) {
      if (childKey === "minY" && typeof source.maxY === "number") {
        result.minY = -source.maxY
      } else if (childKey === "maxY" && typeof source.minY === "number") {
        result.maxY = -source.minY
      } else {
        result[childKey] = reflect(childValue, childKey)
      }
    }
    return result
  }

  return reflect(value) as T
}

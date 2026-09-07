import type {
  Bounds,
  FanoutBorderTarget,
  FanoutDirection,
  FanoutEdge,
  FanoutRoutePlan,
  Point2D,
  PreparedConnection,
} from "./types"

/** The eight isometries of an axis-aligned routing grid, around the origin. */
export const ORTHOGONAL_MATRICES = {
  identity: [1, 0, 0, 1],
  clockwise: [0, 1, -1, 0],
  halfTurn: [-1, 0, 0, -1],
  counterclockwise: [0, -1, 1, 0],
  reflectX: [-1, 0, 0, 1],
  reflectY: [1, 0, 0, -1],
  transpose: [0, 1, 1, 0],
  antiTranspose: [0, -1, -1, 0],
} as const
export type OrthogonalMatrix =
  (typeof ORTHOGONAL_MATRICES)[keyof typeof ORTHOGONAL_MATRICES]

const edgeVectors: Record<FanoutEdge, Point2D> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
}

export function createOrthogonalFanoutView(matrix: OrthogonalMatrix) {
  const [a, b, c, d] = matrix
  if (
    ![a, b, c, d].every((n) => n === -1 || n === 0 || n === 1) ||
    Math.abs(a) + Math.abs(b) !== 1 ||
    Math.abs(c) + Math.abs(d) !== 1 ||
    Math.abs(a) + Math.abs(c) !== 1 ||
    Math.abs(b) + Math.abs(d) !== 1
  )
    throw new Error("Expected a signed permutation matrix")
  const inverse = [a, c, b, d] as OrthogonalMatrix
  const forwardMemo = new Map<object, unknown>()
  const originalObstacles = new Map<object, unknown>()

  /** Reuse this view for the entire SRJ/bus/source graph to preserve identity. */
  function toCanonical<T>(value: T): T {
    return transform(value, matrix, forwardMemo, originalObstacles) as T
  }
  /** Restores source-pad identity even for newly constructed canonical plans. */
  function toOriginal<T>(value: T): T {
    return transform(value, inverse, new Map(originalObstacles)) as T
  }
  function restorePlan<T extends FanoutRoutePlan>(
    plan: T,
    connection: PreparedConnection,
  ): T {
    if (
      plan.connectionIndex !== connection.connectionIndex ||
      plan.sourcePointIndex !== connection.sourcePointIndex
    )
      throw new Error("Cannot restore a plan to a different connection")
    return {
      ...toOriginal(plan),
      sourcePoint: connection.sourcePoint,
      sourceObstacle: connection.sourceObstacle,
      sourceLayer: connection.sourceLayer,
      targetPoint: connection.targetPoint,
    }
  }
  return { toCanonical, toOriginal, restorePlan }
}

function transform(
  value: unknown,
  matrix: OrthogonalMatrix,
  memo: Map<object, unknown>,
  originalObstacles?: Map<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value
  if (memo.has(value)) return memo.get(value)
  const visit = (item: unknown) =>
    transform(item, matrix, memo, originalObstacles)
  if (value instanceof Map) {
    const result = new Map<unknown, unknown>()
    memo.set(value, result)
    for (const [key, entry] of value) result.set(visit(key), visit(entry))
    return result
  }
  if (value instanceof Set) {
    const result = new Set<unknown>()
    memo.set(value, result)
    for (const entry of value) result.add(visit(entry))
    return result
  }
  if (Array.isArray(value)) {
    const result: unknown[] = []
    memo.set(value, result)
    for (const entry of value) result.push(visit(entry))
    return result
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(
      "Fanout views accept only plain routing data, Maps and Sets",
    )
  const original = value as Record<string, unknown>
  const result: Record<string, unknown> = Object.create(prototype)
  memo.set(value, result)
  for (const [key, entry] of Object.entries(original))
    result[key] = visit(entry)
  const [a, b, c, d] = matrix
  const determinant = a * d - b * c
  const point = ({ x, y }: Point2D): Point2D => ({
    x: a * x + b * y,
    y: c * x + d * y,
  })
  if (isPoint(original)) Object.assign(result, point(original))
  if (isBounds(original)) {
    const corners = [
      point({ x: original.minX, y: original.minY }),
      point({ x: original.minX, y: original.maxY }),
      point({ x: original.maxX, y: original.minY }),
      point({ x: original.maxX, y: original.maxY }),
    ]
    Object.assign(result, {
      minX: Math.min(...corners.map((p) => p.x)),
      maxX: Math.max(...corners.map((p) => p.x)),
      minY: Math.min(...corners.map((p) => p.y)),
      maxY: Math.max(...corners.map((p) => p.y)),
    })
  }
  if (
    typeof original.width === "number" &&
    typeof original.height === "number"
  ) {
    // geometry.ts defines a circle by width alone; inconsistent height metadata
    // must never change its radius when the coordinate axes are exchanged.
    if (original.shape !== "circle") {
      result.width =
        Math.abs(a) * original.width + Math.abs(b) * original.height
      result.height =
        Math.abs(c) * original.width + Math.abs(d) * original.height
    }
    // Swapping dimensions already accounts for quarter-turns. Reflections
    // reverse the residual rotation; adding another 90° would rotate twice.
    if (typeof original.ccwRotationDegrees === "number")
      result.ccwRotationDegrees = determinant * original.ccwRotationDegrees
    if (isPoint(original.center) && Array.isArray(original.layers))
      originalObstacles?.set(result, value)
  }
  if (
    Array.isArray(original.xCoordinates) &&
    Array.isArray(original.yCoordinates)
  ) {
    const transformAxis = (coordinates: unknown[], sign: number) =>
      coordinates
        .map((coordinate) => {
          if (typeof coordinate !== "number")
            throw new Error("Invalid coordinate cache")
          return sign * coordinate
        })
        .sort((x, y) => x - y)
    result.xCoordinates = transformAxis(
      a ? original.xCoordinates : original.yCoordinates,
      a || b,
    )
    result.yCoordinates = transformAxis(
      c ? original.xCoordinates : original.yCoordinates,
      c || d,
    )
  }
  if (
    typeof original.pitchX === "number" &&
    typeof original.pitchY === "number"
  ) {
    result.pitchX = a ? original.pitchX : original.pitchY
    result.pitchY = c ? original.pitchX : original.pitchY
  }
  const edge = (input: string): FanoutEdge => {
    if (!Object.hasOwn(edgeVectors, input))
      throw new Error(`Invalid fanout edge: ${input}`)
    const p = point(edgeVectors[input as FanoutEdge])
    return p.x < 0 ? "left" : p.x > 0 ? "right" : p.y > 0 ? "top" : "bottom"
  }
  const direction = (input: string): FanoutDirection => {
    const output = edge(
      input === "up" ? "top" : input === "down" ? "bottom" : input,
    )
    return output === "top" ? "up" : output === "bottom" ? "down" : output
  }
  const preference = (input: string): FanoutBorderTarget => {
    const parts = input.split("-").map(edge)
    if (parts.length === 1) return parts[0]
    if (parts.length !== 2) throw new Error(`Invalid fanout corner: ${input}`)
    const vertical = parts.find((part) => part === "top" || part === "bottom")
    const horizontal = parts.find((part) => part === "left" || part === "right")
    if (!vertical || !horizontal)
      throw new Error(`Invalid fanout corner: ${input}`)
    return `${vertical}-${horizontal}`
  }
  for (const key of ["direction", "defaultDirection"])
    if (typeof original[key] === "string")
      result[key] = direction(original[key])
  if (typeof original.exitEdge === "string")
    result.exitEdge = edge(original.exitEdge)
  for (const key of ["preferredExit", "defaultPreferredExit"])
    if (typeof original[key] === "string")
      result[key] = preference(original[key])
  for (const [key, convert] of [
    ["busDirections", direction],
    ["busExitPreferences", preference],
  ] as const) {
    const record = original[key]
    if (record && typeof record === "object" && !Array.isArray(record))
      result[key] = Object.fromEntries(
        Object.entries(record).map(([id, item]) => {
          if (typeof item !== "string") throw new Error(`Invalid ${key} value`)
          return [id, convert(item)]
        }),
      )
  }
  if (
    typeof original.exitPosition === "string" &&
    original.exitPosition !== "center"
  ) {
    const [side, band] = original.exitPosition.split("side_")
    result.exitPosition = `${edge(side)}side_${band === "center" ? band : edge(band)}`
  }
  if (Array.isArray(original.availableCornersAndSides))
    result.availableCornersAndSides = original.availableCornersAndSides.map(
      (region) => {
        if (typeof region !== "string")
          throw new Error("Invalid available boundary region")
        const [side, band] = region.split("_")
        return band
          ? `${edge(side)}_${band === "middle" ? band : edge(band)}`
          : edge(side)
      },
    )
  if (original.cornerBandSide && typeof original.exitEdge === "string") {
    const tangent = point(
      original.exitEdge === "left" || original.exitEdge === "right"
        ? { x: 0, y: 1 }
        : { x: 1, y: 0 },
    )
    const newVertical =
      result.exitEdge === "left" || result.exitEdge === "right"
    if ((newVertical ? tangent.y : tangent.x) < 0)
      result.cornerBandSide =
        original.cornerBandSide === "minimum" ? "maximum" : "minimum"
  }
  return result
}

function isPoint(value: unknown): value is Point2D {
  return (
    value !== null &&
    typeof value === "object" &&
    "x" in value &&
    typeof value.x === "number" &&
    "y" in value &&
    typeof value.y === "number"
  )
}
function isBounds(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Bounds {
  return ["minX", "minY", "maxX", "maxY"].every(
    (key) => typeof value[key] === "number",
  )
}

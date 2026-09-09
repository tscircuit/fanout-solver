/** A static grid edge is clear, blocked, or usable only by the named owner. */
export type StaticEdgeClearance = boolean | string

/**
 * Store directed grid edges in the native router's immutable neighbor order.
 * Each layer also has one slot per cell for a via move. Non-neighbor edges
 * retain their complete directed key in a Map. Terminal connectors bypass
 * caching because their physical endpoints depend on the active connection.
 */
export class StaticEdgeClearanceCache {
  private readonly classes: Uint32Array
  private readonly layerStride: number
  private readonly values: (StaticEdgeClearance | undefined)[] = [
    undefined,
    true,
    false,
  ]
  private readonly ownerIds = new Map<string, number>()
  private readonly overflow = new Map<number, StaticEdgeClearance>()

  constructor(
    private readonly planeSize: number,
    layerCount: number,
    private readonly neighborOffset: Int32Array,
    private readonly neighborIds: Int32Array,
  ) {
    this.layerStride = neighborIds.length + planeSize
    this.classes = new Uint32Array(this.layerStride * layerCount)
  }

  private getSlot(origin: number, target: number): number {
    const cell = origin < this.planeSize ? origin : origin % this.planeSize
    const layerBase =
      origin < this.planeSize
        ? 0
        : ((origin - cell) / this.planeSize) * this.layerStride
    if (target === cell) return layerBase + this.neighborIds.length + cell
    const end = this.neighborOffset[cell + 1]!
    for (let i = this.neighborOffset[cell]!; i < end; i++)
      if (this.neighborIds[i] === target) return layerBase + i
    return -1
  }

  get(
    origin: number,
    target: number,
    usesTerminal = false,
  ): StaticEdgeClearance | undefined {
    if (usesTerminal) return undefined
    const slot = this.getSlot(origin, target)
    return slot < 0
      ? this.overflow.get(origin * this.planeSize + target)
      : this.values[this.classes[slot]!]
  }

  set(
    origin: number,
    target: number,
    value: StaticEdgeClearance,
    usesTerminal = false,
  ): void {
    if (usesTerminal) return
    const slot = this.getSlot(origin, target)
    if (slot < 0) {
      this.overflow.set(origin * this.planeSize + target, value)
      return
    }
    let code =
      value === true ? 1 : value === false ? 2 : this.ownerIds.get(value)
    if (code === undefined) {
      code = this.values.length
      this.values.push(value)
      this.ownerIds.set(value as string, code)
    }
    this.classes[slot] = code
  }
}

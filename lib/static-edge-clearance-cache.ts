/** A static grid edge is clear, blocked, or usable only by the named owner. */
export type StaticEdgeClearance = boolean | string

/**
 * Keep common directed edges in compact slots without assuming grid topology.
 * A hash hit is usable only when its exact target cell matches; collisions
 * retain the original complete edge key in a Map. Terminal connectors bypass
 * caching because their physical endpoints depend on the active connection.
 */
export class StaticEdgeClearanceCache {
  private readonly targets: Int32Array
  private readonly classes: Uint32Array
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
  ) {
    this.targets = new Int32Array(planeSize * layerCount * 16)
    this.classes = new Uint32Array(this.targets.length)
  }

  get(
    origin: number,
    target: number,
    usesTerminal = false,
  ): StaticEdgeClearance | undefined {
    if (usesTerminal) return undefined
    const slot = origin * 16 + ((target ^ (target >>> 4)) & 15)
    const code = this.classes[slot]!
    return code !== 0 && this.targets[slot] === target
      ? this.values[code]
      : this.overflow.get(origin * this.planeSize + target)
  }

  set(
    origin: number,
    target: number,
    value: StaticEdgeClearance,
    usesTerminal = false,
  ): void {
    if (usesTerminal) return
    const slot = origin * 16 + ((target ^ (target >>> 4)) & 15)
    if (this.classes[slot] === 0 || this.targets[slot] === target) {
      let code =
        value === true ? 1 : value === false ? 2 : this.ownerIds.get(value)
      if (code === undefined) {
        code = this.values.length
        this.values.push(value)
        this.ownerIds.set(value as string, code)
      }
      this.targets[slot] = target
      this.classes[slot] = code
    } else {
      this.overflow.set(origin * this.planeSize + target, value)
    }
  }
}

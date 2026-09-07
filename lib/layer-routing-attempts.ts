export interface LayerRoutingAttempt {
  ripCost: number
  shuffleSeed: number
  transitLayers: string[]
  routeFromSourcePads?: boolean
  sourceOriginPhysicalGridPhase?: boolean
}

/** Bounded retry order; successful attempts never schedule extra work. */
export class LayerRoutingAttempts {
  private readonly pending: LayerRoutingAttempt[]
  private readonly attempted = new Set<string>()
  private readonly preferredOrder?: LayerRoutingAttempt
  private readonly originalOrder?: LayerRoutingAttempt

  constructor(
    private readonly options: {
      wideSingleLayer: boolean
      firstRipCost: number
      transitLayers: string[]
      allTransitLayers: string[]
      preferSourceTransit?: boolean
      preferSourceOrigin?: boolean
      sourceOriginRipCost?: number
      sourceTransitRipCost?: number
      retrySourceOriginPhysicalGridPhase?: boolean
      preferAlternateOrder?: boolean
    },
  ) {
    this.pending = [
      options.preferSourceTransit
        ? {
            ripCost: options.sourceTransitRipCost ?? 8,
            shuffleSeed: 1,
            transitLayers: options.allTransitLayers,
          }
        : {
            ripCost: options.firstRipCost,
            shuffleSeed: 1,
            transitLayers: options.transitLayers,
          },
    ]
    if (options.preferAlternateOrder && options.wideSingleLayer) {
      this.originalOrder = this.pending[0]!
      this.preferredOrder = { ...this.originalOrder, shuffleSeed: 2 }
      this.pending[0] = this.preferredOrder
    }
    if (options.preferSourceOrigin)
      this.pending.unshift({
        ripCost: options.sourceOriginRipCost ?? 256,
        shuffleSeed: 1,
        transitLayers: [],
        routeFromSourcePads: true,
      })
  }

  next(): LayerRoutingAttempt | undefined {
    while (this.pending.length > 0) {
      const attempt = this.pending.shift()!
      const key = JSON.stringify(attempt)
      if (this.attempted.has(key)) continue
      this.attempted.add(key)
      return attempt
    }
    return undefined
  }

  failed(attempt: LayerRoutingAttempt, reason: "routing" | "lengths"): void {
    // The original fixed-source attempt is already pending. Do not multiply
    // the source-origin search if either topology or length matching fails.
    if (attempt.routeFromSourcePads) return
    const enqueue = (candidate: LayerRoutingAttempt) => {
      if (!this.attempted.has(JSON.stringify(candidate)))
        this.pending.unshift(candidate)
    }
    if (attempt === this.preferredOrder) {
      // A geometry-selected ordering may succeed before the usual attempt.
      // On failure, retain that original attempt regardless of failure kind;
      // a complete but untunable topology also keeps the original cost retry.
      enqueue(this.originalOrder!)
      if (reason === "lengths")
        this.pending.push({ ...this.originalOrder!, ripCost: 256 })
      return
    }
    if (attempt.sourceOriginPhysicalGridPhase) {
      const { sourceOriginPhysicalGridPhase, ...ordinary } = attempt
      enqueue({ ...ordinary, ripCost: 256, shuffleSeed: 1 })
      return
    }
    if (
      this.options.preferSourceTransit &&
      attempt.ripCost === (this.options.sourceTransitRipCost ?? 8) &&
      attempt.transitLayers.length === this.options.allTransitLayers.length
    ) {
      enqueue({
        ripCost: this.options.firstRipCost,
        shuffleSeed: 1,
        transitLayers: this.options.transitLayers,
      })
    } else if (this.options.wideSingleLayer) {
      // Preserve the existing length-cost retry. Change route order only when
      // the previous search did not find the complete group topology.
      if (reason === "lengths" && attempt.ripCost === 64) {
        const physical = {
          ...attempt,
          shuffleSeed: 1,
          sourceOriginPhysicalGridPhase: true,
        }
        if (
          this.options.retrySourceOriginPhysicalGridPhase &&
          !this.attempted.has(JSON.stringify(physical))
        )
          enqueue(physical)
        else enqueue({ ...attempt, ripCost: 256, shuffleSeed: 1 })
      }
      if (reason === "routing" && attempt.shuffleSeed === 1)
        enqueue({ ...attempt, ripCost: 64, shuffleSeed: 2 })
    } else if (
      attempt.transitLayers.length < this.options.allTransitLayers.length
    ) {
      const retry = {
        ripCost: reason === "lengths" ? 8 : this.options.firstRipCost,
        shuffleSeed: 1,
        transitLayers: this.options.allTransitLayers,
      }
      // A preferred source-transit search may have already tried this exact
      // choice. Preserve the ordinary final topology-cost retry after the
      // fixed-source fallback instead of ending on that duplicate.
      if (
        reason === "routing" &&
        retry.ripCost !== 256 &&
        this.attempted.has(JSON.stringify(retry))
      )
        enqueue({ ...retry, ripCost: 256 })
      else enqueue(retry)
    } else if (reason === "routing" && attempt.ripCost !== 256) {
      enqueue({ ...attempt, ripCost: 256 })
    }
  }
}

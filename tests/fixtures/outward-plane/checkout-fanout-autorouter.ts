import type {
  AutorouterCompleteEvent,
  AutorouterErrorEvent,
  AutorouterProgressEvent,
  GenericLocalAutorouter,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/core"
import type { SimpleRouteJsonWithFanoutPlanes } from "../../../lib"
import { FanoutSolver } from "../../../lib/fanout-solver"

type AutorouterEvents = {
  complete: AutorouterCompleteEvent
  error: AutorouterErrorEvent
  progress: AutorouterProgressEvent
}

/** Uses the checkout's solver at core's documented local-autorouter boundary.
 * Core creates the real routing problem and materializes every returned trace.
 * Neither that problem nor the solver's copper geometry is reconstructed here.
 */
export class CheckoutFanoutAutorouter implements GenericLocalAutorouter {
  isRouting = false
  readonly solver: FanoutSolver
  private listeners: {
    [Event in keyof AutorouterEvents]: Array<
      (event: AutorouterEvents[Event]) => void
    >
  } = { complete: [], error: [], progress: [] }

  constructor(readonly input: SimpleRouteJson) {
    this.solver = new FanoutSolver(input as SimpleRouteJsonWithFanoutPlanes, {
      // Plane endpoints coincide, so choose a preferred search direction explicitly.
      busDirections: Object.fromEntries(
        (input.buses ?? []).map((bus) => [bus.busId, "right" as const]),
      ),
      borderDistribution: "even",
      compactBusTracks: true,
      escapeLayers: ["top", "bottom"],
      allowBlindAndBuriedVias: false,
    })
  }

  on<Event extends keyof AutorouterEvents>(
    event: Event,
    listener: (event: AutorouterEvents[Event]) => void,
  ): void {
    this.listeners[event].push(listener)
  }

  start(): void {
    this.isRouting = true
    try {
      const traces = this.solveSync()
      this.isRouting = false
      for (const listener of this.listeners.complete)
        listener({ type: "complete", traces })
    } catch (error) {
      this.isRouting = false
      for (const listener of this.listeners.error)
        listener({
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        })
    }
  }

  stop(): void {
    this.isRouting = false
  }

  solveSync(): SimplifiedPcbTrace[] {
    this.solver.solve()
    if (this.solver.failed)
      throw new Error(this.solver.error ?? "Fanout routing failed")
    return this.solver.getOutput().fanoutTraces
  }

  getOutputSimpleRouteJson(): SimpleRouteJson {
    return this.solver.getOutput().simpleRouteJson as SimpleRouteJson
  }
}

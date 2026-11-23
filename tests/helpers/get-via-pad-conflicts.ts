import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distancePointToObstacle } from "lib/geometry"
import { getPlanVias } from "lib/route-bus/plan-copper"
import type { FanoutRoutePlan } from "lib/types"

export function getViaPadConflicts(
  input: SimpleRouteJson,
  plans: readonly FanoutRoutePlan[],
  clearance: number,
) {
  return plans.flatMap((plan) =>
    getPlanVias(plan).flatMap((via) =>
      input.obstacles.filter(
        (obstacle) =>
          !obstacle.isCopperPour &&
          (
            obstacle as typeof obstacle & {
              circuitJsonMetadata?: { pcb_smtpad_id?: string }
            }
          ).circuitJsonMetadata?.pcb_smtpad_id &&
          obstacle.layers.some((layer) => via.spanLayers.includes(layer)) &&
          distancePointToObstacle(via.center, obstacle) <
            via.diameter / 2 + clearance - 1e-9,
      ),
    ),
  )
}

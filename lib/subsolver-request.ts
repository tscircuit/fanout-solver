import { BaseSolver } from "@tscircuit/solver-utils"

export interface SubsolverRequest {
  type: "subsolver"
  solver: BaseSolver
}

export function isSubsolverRequest(
  request: unknown,
): request is SubsolverRequest {
  return (
    typeof request === "object" &&
    request !== null &&
    "type" in request &&
    request.type === "subsolver" &&
    "solver" in request &&
    request.solver instanceof BaseSolver
  )
}

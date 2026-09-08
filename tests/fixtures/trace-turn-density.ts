import type { FanoutSimplifiedPcbTrace } from "lib/types"

type WireTrace = Omit<FanoutSimplifiedPcbTrace, "route"> & {
  route: Extract<
    FanoutSimplifiedPcbTrace["route"][number],
    { route_type: "wire" }
  >[]
}

/** Build a route from intentional turns, with lengths measured along its path. */
export function createTurnTrace(
  id: string,
  turnsDegrees: number[],
  segmentLengths: number | number[] = 0.6,
  layer = "top",
): WireTrace {
  const route: WireTrace["route"] = [
    { route_type: "wire", x: 0, y: 0, width: 0.12, layer },
  ]
  let x = 0
  let y = 0
  let headingDegrees = 0
  for (let index = 0; index <= turnsDegrees.length; index++) {
    if (index > 0) headingDegrees += turnsDegrees[index - 1]
    const length =
      typeof segmentLengths === "number"
        ? segmentLengths
        : segmentLengths[index]
    x += Math.cos((headingDegrees * Math.PI) / 180) * length
    y += Math.sin((headingDegrees * Math.PI) / 180) * length
    route.push({ route_type: "wire", x, y, width: 0.12, layer })
  }
  return {
    type: "pcb_trace",
    pcb_trace_id: id,
    connection_name: id,
    route,
  }
}

export const traceTurnDensityExamples = [
  createTurnTrace("Gentle offset", [45, -45], 1.8),
  createTurnTrace("One chamfered corner", [45, 45], 1.6),
  createTurnTrace("Two nearby corners", [45, 45, -45, -45], 0.9),
  createTurnTrace(
    "Dense alternating corners",
    [45, 45, -45, -45, -45, -45, 45, 45],
    0.55,
  ),
]

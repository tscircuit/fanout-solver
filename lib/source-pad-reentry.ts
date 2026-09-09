import {
  distancePointToObstacle,
  distanceSegmentToObstacle,
  pointIsInsideObstacle,
} from "./geometry"
import type { FanoutRoutePlan } from "./types"

const EPSILON = 1e-7

export interface SourcePadReentry {
  segmentIndex: number
  kind: "outline" | "copper" | "clearance"
}

/** Once a route leaves its own pad, that pad is no longer an escape exemption. */
export function getSourcePadReentries(
  plan: FanoutRoutePlan,
  clearance: number,
): SourcePadReentry[] {
  const pad = plan.sourceObstacle
  // Shrinking preserves the original circle/rotation metadata and excludes a
  // centerline tangent to the outline from the outline-intersection check.
  const interior = {
    ...pad,
    width: pad.width - 2e-8,
    height: pad.height - 2e-8,
  }
  const issues: SourcePadReentry[] = []
  let outlineExited = false,
    copperExited = false,
    clearanceExited = false
  for (const [segmentIndex, segment] of [
    ...plan.segments,
    ...(plan.planeEndpointSegments ?? []),
  ].entries()) {
    if (!pad.layers.includes(segment.layer)) continue
    const separation = distanceSegmentToObstacle(segment, pad)
    const radius = segment.width / 2
    if (
      outlineExited &&
      interior.width > 0 &&
      interior.height > 0 &&
      distanceSegmentToObstacle(segment, interior) < 1e-10
    )
      issues.push({ segmentIndex, kind: "outline" })
    if (copperExited && separation < radius - EPSILON)
      issues.push({ segmentIndex, kind: "copper" })
    if (clearanceExited && separation < radius + clearance - EPSILON)
      issues.push({ segmentIndex, kind: "clearance" })
    if (!pointIsInsideObstacle(segment.end, pad, 1e-9)) outlineExited = true
    const endSeparation = distancePointToObstacle(segment.end, pad)
    if (endSeparation > radius + EPSILON) copperExited = true
    if (endSeparation >= radius + clearance - EPSILON) clearanceExited = true
  }
  return issues
}

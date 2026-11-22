import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { connectionsShareElectricalNet } from "lib/net-identity"
import { routeBus } from "lib/route-bus"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

test("near native escape obstacles retain exact clearance and ownership exemptions", (): void => {
  const params = createIcepiPlaneDrop()
  const plan = routeBus(params)?.[0]
  if (!plan?.via) throw new Error("Native plane drop has no through-via")
  const sameNetConnection = params.srj.connections.find(
    (connection) =>
      connection.name !== plan.connectionName &&
      connectionsShareElectricalNet(
        params.srj,
        connection.name,
        plan.connectionName,
      ),
  )
  if (!sameNetConnection) {
    throw new Error("Native source net has no other connection")
  }
  const sourceEscapePath = [
    plan.segments[0].start,
    ...plan.segments.map((segment) => segment.end),
  ]
  const firstSegment = plan.segments[0]
  const midpoint = {
    x: (firstSegment.start.x + firstSegment.end.x) / 2,
    y: (firstSegment.start.y + firstSegment.end.y) / 2,
  }
  const foreignPad: Obstacle = {
    type: "rect",
    center: midpoint,
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    connectedTo: ["foreign-segment-net"],
  }
  const wireClearance = firstSegment.width / 2 + params.clearance
  const circularPadOffset = wireClearance + foreignPad.width / 2
  const rotatedPadOffset = wireClearance + 0.03
  const cases = [
    {
      label: "foreign pad intersects the source wire",
      obstacle: foreignPad,
      allowSameNetMerges: false,
      clear: false,
    },
    {
      label: "circular pad at exact configured clearance",
      obstacle: {
        ...foreignPad,
        shape: "circle" as const,
        center: {
          x: midpoint.x + Math.SQRT1_2 * circularPadOffset,
          y: midpoint.y + Math.SQRT1_2 * circularPadOffset,
        },
      },
      allowSameNetMerges: false,
      clear: true,
    },
    {
      label: "rotated narrow pad clears despite overlapping axis bounds",
      obstacle: {
        ...foreignPad,
        width: 0.6,
        height: 0.02,
        ccwRotationDegrees: -45,
        center: {
          x: midpoint.x + Math.SQRT1_2 * rotatedPadOffset,
          y: midpoint.y + Math.SQRT1_2 * rotatedPadOffset,
        },
      },
      allowSameNetMerges: false,
      clear: true,
    },
    {
      label: "direct connection copper remains exempt",
      obstacle: { ...foreignPad, connectedTo: [plan.connectionName] },
      allowSameNetMerges: false,
      clear: true,
    },
    {
      label: "same-net aliases require merge permission",
      obstacle: {
        ...foreignPad,
        connectedTo: [sameNetConnection.name],
      },
      allowSameNetMerges: false,
      clear: false,
    },
    {
      label: "same-net aliases remain exempt with merge permission",
      obstacle: {
        ...foreignPad,
        connectedTo: [sameNetConnection.name],
      },
      allowSameNetMerges: true,
      clear: true,
    },
    {
      label: "terminal can leave its component body outward",
      obstacle: {
        ...foreignPad,
        componentId: params.bus.componentId,
        center: { x: sourceEscapePath[0].x, y: sourceEscapePath[0].y + 0.2 },
        width: 0.8,
        height: 0.8,
        connectedTo: [],
      },
      allowSameNetMerges: false,
      clear: true,
    },
    {
      label: "component body cannot hide an inward wire collision",
      obstacle: {
        ...foreignPad,
        componentId: params.bus.componentId,
        connectedTo: [],
      },
      allowSameNetMerges: false,
      clear: false,
    },
  ]
  for (const scenario of cases) {
    const plans = routeBus({
      ...params,
      srj: {
        ...params.srj,
        obstacles: [...params.srj.obstacles, scenario.obstacle],
      },
      fixedViaPointsByConnectionIndex: new Map([
        [plan.connectionIndex, plan.via.center],
      ]),
      sourceEscapePaths: new Map([[plan.connectionIndex, sourceEscapePath]]),
      allowSameNetMerges: scenario.allowSameNetMerges,
    })
    expect(plans !== null, scenario.label).toBe(scenario.clear)
  }
})

import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import dramBreakoutFixture from "./fixtures/soc-dram/northeast/dram-breakout.srj.json"
import socBreakoutFixture from "./fixtures/soc-dram/northeast/soc-breakout.srj.json"

const fixtures = [
  {
    id: "soc",
    input: socBreakoutFixture as unknown as SimpleRouteJson,
  },
  {
    id: "dram",
    input: dramBreakoutFixture as unknown as SimpleRouteJson,
  },
] as const

test("records the current SoC and DRAM northeast breakout failures", async () => {
  for (const fixture of fixtures) {
    const input = structuredClone(fixture.input)
    const solver = new FanoutSolver(input)
    solver.solve()

    const bestRoutedConnectionCount = Math.max(
      0,
      ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
    )
    const directions = [
      ...new Set(solver.preparedBuses.map((bus) => bus.direction)),
    ].join(", ")
    const sharedBoundary = solver.preparedBuses[0]?.sharedBoundary
    const annotationX = input.bounds.minX
    const annotationY = input.bounds.maxY + 1
    const visualization = mergeGraphics(solver.visualize(), {
      texts: [
        {
          x: annotationX,
          y: annotationY + 2,
          text: `${fixture.id.toUpperCase()} · ${input.connections.length} connections · ${input.buses?.length ?? 0} buses · ${input.layerCount} layers`,
          color: "#0f172a",
          fontSize: 0.75,
          anchorSide: "bottom_left",
        },
        {
          x: annotationX,
          y: annotationY + 1,
          text: `solved=${solver.solved} · failed=${solver.failed} · attempts=${solver.attempts.length} · best=${bestRoutedConnectionCount}/${input.connections.length}`,
          color: "#b91c1c",
          fontSize: 0.75,
          anchorSide: "bottom_left",
        },
        {
          x: annotationX,
          y: annotationY,
          text: `${String(solver.error)} · directions=${directions} · boundary=${JSON.stringify(sharedBoundary)}`,
          color: "#b91c1c",
          fontSize: 0.75,
          anchorSide: "bottom_left",
        },
      ],
    })

    await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
      import.meta.path,
      `${fixture.id}-current-failure`,
    )
  }
}, 30_000)

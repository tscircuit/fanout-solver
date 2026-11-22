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
    // Frame the breakout itself and size the annotations to that frame, so
    // the routed escapes stay legible instead of shrinking under the board.
    const sharedBoundary =
      solver.preparedBuses[0]?.sharedBoundary ?? input.bounds
    const frameSize = Math.max(
      sharedBoundary.maxX - sharedBoundary.minX,
      sharedBoundary.maxY - sharedBoundary.minY,
    )
    const fontSize = frameSize * 0.02
    const lineHeight = fontSize * 1.4
    const annotationX = sharedBoundary.minX
    const annotationY = sharedBoundary.maxY + lineHeight
    const visualization = mergeGraphics(
      solver.visualizeFanoutRegion({ margin: lineHeight * 5 }),
      {
        texts: [
          {
            x: annotationX,
            y: annotationY + 2 * lineHeight,
            text: `${fixture.id.toUpperCase()} · ${input.connections.length} connections · ${input.buses?.length ?? 0} buses · ${input.layerCount} layers`,
            color: "#0f172a",
            fontSize,
            anchorSide: "bottom_left",
          },
          {
            x: annotationX,
            y: annotationY + lineHeight,
            text: `solved=${solver.solved} · failed=${solver.failed} · attempts=${solver.attempts.length} · best=${bestRoutedConnectionCount}/${input.connections.length}`,
            color: "#b91c1c",
            fontSize,
            anchorSide: "bottom_left",
          },
          {
            x: annotationX,
            y: annotationY,
            text: `${String(solver.error)} · directions=${directions}`,
            color: "#b91c1c",
            fontSize,
            anchorSide: "bottom_left",
          },
        ],
      },
    )

    await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
      import.meta.path,
      `${fixture.id}-current-failure`,
    )
  }
  // Both large reproduction circuits and their SVGs share this test deadline.
}, 60_000)

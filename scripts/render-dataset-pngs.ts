import { mkdir, writeFile } from "node:fs/promises"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  type GraphicsObject,
  getPngBufferFromGraphicsObject,
  mergeGraphics,
  type Viewbox,
} from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import { fanoutDataset01 } from "../datasets/dataset01"

interface ComponentBounds {
  componentId: string
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function getComponentBounds(
  componentBounds: NonNullable<FanoutSolverOptions["componentBounds"]>,
): ComponentBounds[] {
  return Object.entries(componentBounds).map(([componentId, bounds]) => ({
    componentId,
    ...bounds,
  }))
}

function createVerificationOverlay(
  srj: SimpleRouteJson,
  componentBounds: ComponentBounds[],
): GraphicsObject {
  return {
    rects: componentBounds.map((bounds) => ({
      center: {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      },
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      fill: "#ef444410",
      stroke: "#dc2626",
      label: `${bounds.componentId} chip boundary`,
    })),
    points: srj.connections.flatMap((connection) =>
      connection.pointsToConnect.flatMap((point) =>
        point.pointId?.startsWith("fanout-exit:")
          ? [
              {
                x: point.x,
                y: point.y,
                color: "#16a34a",
              },
            ]
          : [],
      ),
    ),
  }
}

function getVerificationViewbox(componentBounds: ComponentBounds[]): Viewbox {
  const margin = 1.25
  return {
    minX: Math.min(...componentBounds.map((bounds) => bounds.minX)) - margin,
    maxX: Math.max(...componentBounds.map((bounds) => bounds.maxX)) + margin,
    minY: Math.min(...componentBounds.map((bounds) => bounds.minY)) - margin,
    maxY: Math.max(...componentBounds.map((bounds) => bounds.maxY)) + margin,
  }
}

const outputDirectory = process.argv[2] ?? "verification-pngs"
await mkdir(outputDirectory, { recursive: true })

for (const sample of fanoutDataset01) {
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()
  if (solver.failed) {
    throw new Error(
      `${sample.id} failed: ${solver.error ?? "unknown solver error"}`,
    )
  }

  const output = solver.getOutput()
  const configuredComponentBounds = sample.solverOptions.componentBounds
  if (!configuredComponentBounds) {
    throw new Error(`${sample.id} has no component bounds to verify`)
  }
  const componentBounds = getComponentBounds(configuredComponentBounds)
  const graphics = mergeGraphics(
    {
      ...solver.visualize(),
      title: `${sample.id}: ${sample.name}`,
    },
    createVerificationOverlay(output.simpleRouteJson, componentBounds),
  )
  const png = await getPngBufferFromGraphicsObject(graphics, {
    backgroundColor: "#ffffff",
    includeTextLabels: ["rects"],
    padding: 24,
    pngHeight: 1400,
    pngWidth: 1400,
    viewbox: getVerificationViewbox(componentBounds),
  })
  const outputPath = `${outputDirectory}/${sample.id}.png`
  await writeFile(outputPath, png)
  console.log(`wrote ${outputPath}`)
}

import { mkdir, writeFile } from "node:fs/promises"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  type GraphicsObject,
  getPngBufferFromGraphicsObject,
  mergeGraphics,
  type Viewbox,
} from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds } from "lib/types"
import { fanoutDatasets } from "../datasets"

interface ComponentBounds {
  componentId: string
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function getComponentBounds(
  componentBounds: Readonly<Record<string, Bounds>>,
): ComponentBounds[] {
  return Object.entries(componentBounds).map(([componentId, bounds]) => ({
    componentId,
    ...bounds,
  }))
}

function createVerificationOverlay(
  srj: SimpleRouteJson,
  componentBounds: ComponentBounds[],
  sharedBoundary: Bounds,
): GraphicsObject {
  return {
    rects: [
      ...componentBounds.map((bounds) => ({
        center: {
          x: (bounds.minX + bounds.maxX) / 2,
          y: (bounds.minY + bounds.maxY) / 2,
        },
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
        fill: "#64748b0c",
        stroke: "#64748b",
        label: bounds.componentId,
      })),
      {
        center: {
          x: (sharedBoundary.minX + sharedBoundary.maxX) / 2,
          y: (sharedBoundary.minY + sharedBoundary.maxY) / 2,
        },
        width: sharedBoundary.maxX - sharedBoundary.minX,
        height: sharedBoundary.maxY - sharedBoundary.minY,
        fill: "#ef444408",
        stroke: "#dc2626",
      },
    ],
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

function getVerificationViewbox(sharedBoundary: Bounds): Viewbox {
  const margin = 1.25
  return {
    minX: sharedBoundary.minX - margin,
    maxX: sharedBoundary.maxX + margin,
    minY: sharedBoundary.minY - margin,
    maxY: sharedBoundary.maxY + margin,
  }
}

const outputDirectory = process.argv[2] ?? "verification-pngs"
await mkdir(outputDirectory, { recursive: true })

for (const dataset of fanoutDatasets) {
  const datasetDirectory = `${outputDirectory}/${dataset.id}`
  await mkdir(datasetDirectory, { recursive: true })

  for (const sample of dataset.samples) {
    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()
    if (solver.failed) {
      throw new Error(
        `${dataset.id}/${sample.id} failed: ${solver.error ?? "unknown solver error"}`,
      )
    }

    const output = solver.getOutput()
    const componentBounds = getComponentBounds(sample.componentBounds)
    const graphics = mergeGraphics(
      {
        ...solver.visualize(),
        title: `${dataset.id}/${sample.id}: ${sample.name}`,
      },
      createVerificationOverlay(
        output.simpleRouteJson,
        componentBounds,
        sample.sharedBoundary,
      ),
    )
    const png = await getPngBufferFromGraphicsObject(graphics, {
      backgroundColor: "#ffffff",
      includeTextLabels: ["rects"],
      padding: 24,
      pngHeight: 1400,
      pngWidth: 1400,
      viewbox: getVerificationViewbox(sample.sharedBoundary),
    })
    const outputPath = `${datasetDirectory}/${sample.id}.png`
    await writeFile(outputPath, png)
    console.log(`wrote ${outputPath}`)
  }
}

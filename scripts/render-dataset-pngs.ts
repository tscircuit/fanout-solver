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
  statusLabel?: string,
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
      ...(statusLabel
        ? [
            {
              center: {
                x: (sharedBoundary.minX + sharedBoundary.maxX) / 2,
                y: sharedBoundary.maxY + 0.65,
              },
              width: 20,
              height: 0.8,
              fill: "#ffffff",
              stroke: "#dc2626",
              label: statusLabel,
            },
          ]
        : []),
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

function getVerificationViewbox(
  sharedBoundary: Bounds,
  outputBounds: Bounds,
): Viewbox {
  const margin = 1.25
  return {
    minX: Math.min(sharedBoundary.minX - margin, outputBounds.minX),
    maxX: Math.max(sharedBoundary.maxX + margin, outputBounds.maxX),
    minY: Math.min(sharedBoundary.minY - margin, outputBounds.minY),
    maxY: Math.max(sharedBoundary.maxY + margin, outputBounds.maxY),
  }
}

function formatFootprinterStrings(strings: string[]): string {
  const counts = new Map<string, number>()
  for (const value of strings) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .map(([value, count]) => (count === 1 ? value : `${value} × ${count}`))
    .join(" + ")
}

const outputDirectory = process.argv[2] ?? "verification-pngs"
const requestedDatasetId = process.argv[3]
await mkdir(outputDirectory, { recursive: true })

for (const dataset of fanoutDatasets.filter(
  (candidate) => !requestedDatasetId || candidate.id === requestedDatasetId,
)) {
  const datasetDirectory = `${outputDirectory}/${dataset.id}`
  await mkdir(datasetDirectory, { recursive: true })

  for (const sample of dataset.samples) {
    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()

    const visualizedSrj = solver.solved
      ? solver.getOutput().simpleRouteJson
      : sample.simpleRouteJson
    const componentBounds = getComponentBounds(sample.componentBounds)
    const routeStatus = solver.failed
      ? ` · incomplete: ${solver.attempts[0]?.routedConnectionCount ?? 0}/${sample.simpleRouteJson.connections.length}`
      : ""
    const graphics = mergeGraphics(
      {
        ...solver.visualize(),
        title: `${dataset.id}/${sample.id}: ${sample.name} · ${formatFootprinterStrings(sample.footprinterStrings)}${routeStatus}`,
      },
      createVerificationOverlay(
        visualizedSrj,
        componentBounds,
        sample.sharedBoundary,
        solver.failed
          ? `INCOMPLETE ${solver.attempts[0]?.routedConnectionCount ?? 0}/${sample.simpleRouteJson.connections.length}`
          : undefined,
      ),
    )
    const png = await getPngBufferFromGraphicsObject(graphics, {
      backgroundColor: "#ffffff",
      includeTextLabels: ["rects"],
      padding: 24,
      pngHeight: 1400,
      pngWidth: 1400,
      viewbox: getVerificationViewbox(
        sample.sharedBoundary,
        visualizedSrj.bounds,
      ),
    })
    const outputPath = `${datasetDirectory}/${sample.id}.png`
    await writeFile(outputPath, png)
    console.log(`wrote ${outputPath}`)
  }
}

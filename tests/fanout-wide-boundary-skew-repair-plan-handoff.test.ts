import { expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "lib/types"
import fixtureJson from "./fixtures/am62l-north-orbit-search-explosion.json"

const root = resolve(import.meta.dir, "..")
const MATCHED_LENGTH = 123.456
const CHILD_PROCESS_ENV = "FANOUT_WIDE_SKEW_HANDOFF_CHILD"
let lengthMatchCalls = 0

const viaMapFor = (
  buses: readonly PreparedBus[],
  fixed?: ReadonlyMap<number, Point2D>,
): Map<number, Point2D> => {
  const result = new Map(fixed)
  for (const bus of buses) {
    for (const connection of bus.connections) {
      result.set(
        connection.connectionIndex,
        result.get(connection.connectionIndex) ?? {
          x: connection.connectionIndex,
          y: 0,
        },
      )
    }
  }
  return result
}

const makePlans = (params: {
  bus: PreparedBus
  targetLayer: string
  fixedViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
  equalLengths?: boolean
}): FanoutRoutePlan[] =>
  params.bus.connections.map((connection, index) => {
    const viaPoint = params.fixedViaPointsByConnectionIndex?.get(
      connection.connectionIndex,
    ) ?? { x: connection.connectionIndex, y: 0 }
    return {
      busId: params.bus.busId,
      connectionName: connection.connection.name,
      connectionIndex: connection.connectionIndex,
      sourcePointIndex: connection.sourcePointIndex,
      sourcePoint: connection.sourcePoint,
      sourceObstacle: connection.sourceObstacle,
      sourceLayer: connection.sourceLayer,
      targetPoint: connection.targetPoint,
      targetLayer: params.targetLayer,
      termination: params.bus.termination,
      direction: params.bus.direction,
      exitEdge: params.bus.exitEdge,
      exitPoint: { ...connection.targetPoint },
      trace: {
        type: "pcb_trace",
        pcb_trace_id: `trace-${connection.connectionIndex}`,
        connection_name: connection.connection.name,
        route: [],
      },
      segments: [
        {
          start: {
            x: connection.sourcePoint.x,
            y: connection.sourcePoint.y,
          },
          end: viaPoint,
          width: 0.1,
          layer: connection.sourceLayer,
        },
      ],
      via: {
        center: viaPoint,
        diameter: 0.3,
        holeDiameter: 0.15,
        fromLayer: connection.sourceLayer,
        toLayer: params.targetLayer,
        spanLayers: [connection.sourceLayer, params.targetLayer],
      },
      length: params.equalLengths ? 10 : index * 10,
    } as FanoutRoutePlan
  })

function installDeterministicRoutingDoubles(): void {
  mock.module(`${root}/lib/route-bus.ts`, () => ({
    fanoutPlansAreClear: () => true,
    getPrioritizedSourceTopologyConnectionOrders: (bus: PreparedBus) => [
      bus.connections,
    ],
    routeBus: (params: Parameters<typeof makePlans>[0]) => makePlans(params),
    routeBusAlternatives: (
      params: Parameters<typeof makePlans>[0],
    ): FanoutRoutePlan[][] => {
      if (params.bus.connections.length <= 2) return []
      const firstPoint = params.fixedViaPointsByConnectionIndex?.get(
        params.bus.connections[0]!.connectionIndex,
      )
      return [
        makePlans({
          ...params,
          equalLengths: (firstPoint?.y ?? 0) === 100,
        }),
      ]
    },
  }))

  mock.module(`${root}/lib/match-component-dogbone-via-sites.ts`, () => ({
    getComponentDogboneViaSiteCandidates: () => [],
    matchComponentDogboneViaSites: (
      buses: readonly PreparedBus[],
      rules: {
        fixedViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
      },
    ) => viaMapFor(buses, rules.fixedViaPointsByConnectionIndex),
    matchComponentDogboneViaSiteAlternatives: (
      buses: readonly PreparedBus[],
      rules: {
        fixedViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
      },
    ) => {
      const alternative = viaMapFor(
        buses,
        rules.fixedViaPointsByConnectionIndex,
      )
      const wide = buses.find((bus) => bus.connections.length > 2)
      for (const connection of wide?.connections ?? []) {
        alternative.set(connection.connectionIndex, {
          x: connection.connectionIndex,
          y: 100,
        })
      }
      return [alternative]
    },
    matchComponentDogboneViaPaths: (
      buses: readonly PreparedBus[],
      rules: {
        fixedViaPointsByConnectionIndex: ReadonlyMap<number, Point2D>
      },
    ) =>
      new Map(
        buses.flatMap((bus) =>
          bus.connections.map((connection) => {
            const point = rules.fixedViaPointsByConnectionIndex.get(
              connection.connectionIndex,
            )!
            return [
              connection.connectionIndex,
              { point, path: [connection.sourcePoint, point] },
            ] as const
          }),
        ),
      ),
  }))

  mock.module(`${root}/lib/route-via-minimal-winding.ts`, () => ({
    routeViaMinimalWindingAlternatives: (params: {
      bus: PreparedBus
      targetLayer: string
      terminals: Array<{
        connection: PreparedBus["connections"][number]
        viaPoint: Point2D
      }>
    }) => [
      makePlans({
        bus: params.bus,
        targetLayer: params.targetLayer,
        fixedViaPointsByConnectionIndex: new Map(
          params.terminals.map((terminal) => [
            terminal.connection.connectionIndex,
            terminal.viaPoint,
          ]),
        ),
        equalLengths: true,
      }),
    ],
  }))

  mock.module(`${root}/lib/match-bus-lengths.ts`, () => ({
    matchBusPlanLengths: ({ plans }: { plans: FanoutRoutePlan[] }) => {
      lengthMatchCalls++
      return {
        plans:
          lengthMatchCalls === 1
            ? plans.map((plan) => ({ ...plan, length: MATCHED_LENGTH }))
            : plans,
      }
    },
  }))
}

const exerciseWideSkewRepair = async (): Promise<void> => {
  const { FanoutSolver } = await import("lib/fanout-solver")
  const fixture = fixtureJson as any
  const byte0 = fixture.options.buses.find(
    (bus: any) => bus.busId === "DDR_BYTE0",
  )
  const byte1 = fixture.options.buses.find(
    (bus: any) => bus.busId === "DDR_BYTE1",
  )
  const forceLayer = (bus: any, layer: string) => ({
    ...bus,
    allowedLayers: [layer],
    connectionExitTargets: Object.fromEntries(
      bus.connectionNames.map((name: string) => [
        name,
        { ...bus.connectionExitTargets[name], layer },
      ]),
    ),
  })
  const wide = forceLayer(byte0, "inner4")
  const narrow = Array.from({ length: 3 }, (_, index) => {
    const connectionNames = byte1.connectionNames.slice(
      index * 2,
      index * 2 + 2,
    )
    return forceLayer(
      {
        ...byte1,
        busId: `NARROW_${index}`,
        name: `NARROW_${index}`,
        connectionNames,
        maxLengthSkew: 0.25,
        connectionExitTargets: Object.fromEntries(
          connectionNames.map((name: string) => [
            name,
            byte1.connectionExitTargets[name],
          ]),
        ),
      },
      "inner5",
    )
  })
  const buses = [wide, ...narrow]
  const names = new Set(buses.flatMap((bus: any) => bus.connectionNames))
  const solver = new FanoutSolver(
    {
      ...fixture.input,
      connections: fixture.input.connections.filter((connection: any) =>
        names.has(connection.name),
      ),
    },
    { ...fixture.options, buses, maxLayerCombinations: 1 },
  )
  const assignment = Object.fromEntries(
    solver.preparedBuses.map((bus) => [
      bus.busId,
      bus.busId === "DDR_BYTE0" ? "inner4" : "inner5",
    ]),
  )
  const result = (
    solver as unknown as {
      routeDenseThroughAllMixedTerminations: (params: {
        busLayerAssignments: Record<string, string>
        busesInRoutingOrder: PreparedBus[]
      }) => { plans: FanoutRoutePlan[]; failedBusIds: string[] }
    }
  ).routeDenseThroughAllMixedTerminations({
    busLayerAssignments: assignment,
    busesInRoutingOrder: solver.preparedBuses,
  })

  expect(lengthMatchCalls).toBe(2)
  expect(result.failedBusIds).toEqual([])
  expect(result.plans).toHaveLength(14)
  expect(result.plans.every((plan) => plan.length === MATCHED_LENGTH)).toBe(
    true,
  )
}

if (process.env[CHILD_PROCESS_ENV] === "1") {
  installDeterministicRoutingDoubles()
  test("wide dogbone skew repair child harness", exerciseWideSkewRepair)
} else {
  test("wide dogbone skew repair keeps the plans returned by length matching", () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, "test", import.meta.path],
      cwd: root,
      env: { ...process.env, [CHILD_PROCESS_ENV]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (child.exitCode !== 0) {
      const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
      throw new Error(
        `isolated wide-skew regression failed:\n${decode(child.stdout)}${decode(child.stderr)}`,
      )
    }
  })
}

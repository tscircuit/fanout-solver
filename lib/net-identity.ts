import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"

interface ElectricalNetIdentity {
  connectionNetKeys: Map<string, string>
  tokenNetKeys: Map<string, Set<string>>
}

const identityCache = new WeakMap<SimpleRouteJson, ElectricalNetIdentity>()

export function getConnectionNetKey(connection: SimpleRouteConnection): string {
  return (
    connection.netConnectionName ??
    connection.rootConnectionName ??
    connection.name
  )
}

function addTokenNet(
  tokenNetKeys: Map<string, Set<string>>,
  token: string | undefined,
  netKey: string,
): boolean {
  if (!token) return false
  const keys = tokenNetKeys.get(token) ?? new Set<string>()
  const sizeBefore = keys.size
  keys.add(netKey)
  tokenNetKeys.set(token, keys)
  return keys.size !== sizeBefore
}

function getKnownNetKeys(
  tokenNetKeys: Map<string, Set<string>>,
  tokens: readonly string[],
): Set<string> {
  const keys = new Set<string>()
  for (const token of tokens) {
    for (const key of tokenNetKeys.get(token) ?? []) keys.add(key)
  }
  return keys
}

function createElectricalNetIdentity(
  srj: SimpleRouteJson,
): ElectricalNetIdentity {
  const connectionNetKeys = new Map<string, string>()
  const tokenNetKeys = new Map<string, Set<string>>()

  for (const connection of srj.connections) {
    const netKey = getConnectionNetKey(connection)
    connectionNetKeys.set(connection.name, netKey)
    addTokenNet(tokenNetKeys, connection.name, netKey)
    addTokenNet(tokenNetKeys, connection.rootConnectionName, netKey)
    addTokenNet(tokenNetKeys, connection.netConnectionName, netKey)
    for (const point of connection.pointsToConnect) {
      addTokenNet(tokenNetKeys, point.pointId, netKey)
      addTokenNet(tokenNetKeys, point.pcb_port_id, netKey)
    }
  }

  for (const trace of srj.traces ?? []) {
    const netKey = trace.connection_name
      ? connectionNetKeys.get(trace.connection_name)
      : undefined
    if (!netKey) continue
    addTokenNet(tokenNetKeys, trace.pcb_trace_id, netKey)
    for (const token of trace.connectsTo ?? []) {
      addTokenNet(tokenNetKeys, token, netKey)
    }
  }

  // Obstacle metadata often contains both a connection id and a lower-level
  // connectivity id. Propagate the known net across that metadata so another
  // pad that only names the connectivity id is still recognized as same-net.
  for (let pass = 0; pass < 2; pass++) {
    let changed = false
    for (const obstacle of srj.obstacles) {
      const netKeys = getKnownNetKeys(tokenNetKeys, obstacle.connectedTo)
      if (netKeys.size !== 1) continue
      const netKey = [...netKeys][0]!
      for (const token of obstacle.connectedTo) {
        changed = addTokenNet(tokenNetKeys, token, netKey) || changed
      }
    }
    if (!changed) break
  }

  const parentByNetKey = new Map<string, string>()
  const findRoot = (netKey: string): string => {
    const parent = parentByNetKey.get(netKey) ?? netKey
    parentByNetKey.set(netKey, parent)
    if (parent === netKey) return netKey
    const root = findRoot(parent)
    parentByNetKey.set(netKey, root)
    return root
  }
  const union = (first: string, second: string): void => {
    const firstRoot = findRoot(first)
    const secondRoot = findRoot(second)
    if (firstRoot !== secondRoot) parentByNetKey.set(secondRoot, firstRoot)
  }
  for (const netKeys of tokenNetKeys.values()) {
    const [firstNetKey, ...otherNetKeys] = [...netKeys]
    if (!firstNetKey) continue
    for (const otherNetKey of otherNetKeys) union(firstNetKey, otherNetKey)
  }
  for (const connectedTokens of [
    ...srj.obstacles.map((obstacle) => obstacle.connectedTo),
    ...(srj.traces ?? []).map((trace) => trace.connectsTo ?? []),
  ]) {
    const [firstNetKey, ...otherNetKeys] = [
      ...getKnownNetKeys(tokenNetKeys, connectedTokens),
    ]
    if (!firstNetKey) continue
    for (const otherNetKey of otherNetKeys) union(firstNetKey, otherNetKey)
  }
  for (const [connectionName, netKey] of connectionNetKeys) {
    connectionNetKeys.set(connectionName, findRoot(netKey))
  }
  for (const [token, netKeys] of tokenNetKeys) {
    tokenNetKeys.set(
      token,
      new Set([...netKeys].map((netKey) => findRoot(netKey))),
    )
  }

  return { connectionNetKeys, tokenNetKeys }
}

function getElectricalNetIdentity(srj: SimpleRouteJson): ElectricalNetIdentity {
  const cached = identityCache.get(srj)
  if (cached) return cached
  const identity = createElectricalNetIdentity(srj)
  identityCache.set(srj, identity)
  return identity
}

export function connectionsShareElectricalNet(
  srj: SimpleRouteJson,
  firstConnectionName: string,
  secondConnectionName: string,
): boolean {
  const identity = getElectricalNetIdentity(srj)
  const firstNet = identity.connectionNetKeys.get(firstConnectionName)
  const secondNet = identity.connectionNetKeys.get(secondConnectionName)
  return firstNet !== undefined && firstNet === secondNet
}

export function obstacleSharesElectricalNet(
  srj: SimpleRouteJson,
  obstacle: Obstacle,
  connectionName: string,
): boolean {
  const identity = getElectricalNetIdentity(srj)
  const connectionNet = identity.connectionNetKeys.get(connectionName)
  if (!connectionNet) return false
  return obstacle.connectedTo.some((token) =>
    identity.tokenNetKeys.get(token)?.has(connectionNet),
  )
}

const COPPER_LAYER_COLORS = [
  "#ef4444",
  "#2563eb",
  "#16a34a",
  "#9333ea",
  "#f59e0b",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#4f46e5",
  "#ea580c",
] as const

export function getCopperLayerColor(layerIndex: number): string {
  if (!Number.isInteger(layerIndex) || layerIndex < 0) {
    throw new Error(
      `FanoutSolver: copper layer index must be a non-negative integer, received ${layerIndex}`,
    )
  }
  return COPPER_LAYER_COLORS[layerIndex % COPPER_LAYER_COLORS.length]!
}

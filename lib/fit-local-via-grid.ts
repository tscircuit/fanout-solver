/** Fit candidate via rows to a uniform lattice when imported pad coordinates
 * differ only by rounding noise. Physical pads and fixed routes never move. */
export function fitLocalViaGrid(coordinates: number[], tolerance: number) {
  if (coordinates.length < 2) return null
  const measured =
    (coordinates.at(-1)! - coordinates[0]!) / (coordinates.length - 1)
  const pitch = Number(measured.toPrecision(3))
  if (!(pitch > 0) || Math.abs(pitch - measured) > tolerance) return null
  const measuredOrigin =
    coordinates.reduce((sum, value, i) => sum + value - i * pitch, 0) /
    coordinates.length
  // Imported coordinate noise also shifts the lattice intercept. Use the
  // same decimal precision as the fitted pitch, subject to the per-pad bound.
  const quantum = 10 ** (Math.floor(Math.log10(pitch)) - 2)
  const origin = Math.round(measuredOrigin / quantum) * quantum
  const fitted = coordinates.map((_, i) => origin + i * pitch)
  if (fitted.some((value, i) => Math.abs(value - coordinates[i]!) > tolerance))
    return null
  return { coordinates: fitted, pitch }
}

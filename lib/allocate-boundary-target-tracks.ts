/** Keep a requested band when clear, otherwise compact it into the nearest gap. */
export function allocateBoundaryTargetTracks(params: {
  requestedTracks: readonly number[]
  occupiedTracks: readonly number[]
  minimum: number
  maximum: number
  minimumPitch: number
}): readonly number[] {
  const { requestedTracks, occupiedTracks, minimum, maximum, minimumPitch } =
    params
  if (requestedTracks.length === 0) return requestedTracks
  if (
    !requestedTracks.some((track) =>
      occupiedTracks.some(
        (occupied) => Math.abs(track - occupied) < minimumPitch - 1e-9,
      ),
    )
  )
    return requestedTracks
  const center =
    requestedTracks.reduce((sum, track) => sum + track, 0) /
    requestedTracks.length
  const halfSpan = ((requestedTracks.length - 1) * minimumPitch) / 2
  let nearestCenter: number | undefined
  let left = minimum
  for (const occupied of [
    ...occupiedTracks.toSorted((a, b) => a - b),
    maximum + minimumPitch,
  ]) {
    const right = Math.min(maximum, occupied - minimumPitch)
    if (right - left >= halfSpan * 2 - 1e-9) {
      const candidate = Math.max(
        left + halfSpan,
        Math.min(right - halfSpan, center),
      )
      if (
        nearestCenter === undefined ||
        Math.abs(candidate - center) < Math.abs(nearestCenter - center)
      )
        nearestCenter = candidate
    }
    left = Math.max(left, occupied + minimumPitch)
  }
  if (nearestCenter === undefined) return requestedTracks
  return requestedTracks.map(
    (_, index) =>
      nearestCenter! +
      (index - (requestedTracks.length - 1) / 2) * minimumPitch,
  )
}

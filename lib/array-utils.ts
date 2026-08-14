export function copyAndSortArray<T>(
  values: readonly T[],
  compareValues: (first: T, second: T) => number,
): T[] {
  return [...values].sort(compareValues)
}

export function getArrayItemFromEnd<T>(
  values: ArrayLike<T>,
  positionFromEnd = 1,
): T | undefined {
  return values[values.length - positionFromEnd]
}

export function findLastArrayIndex<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index]!, index)) return index
  }
  return -1
}

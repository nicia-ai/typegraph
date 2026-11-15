/**
 * The bin each weighted item lands in, by item position.
 *
 * Longest-processing-time bin packing: items are placed heaviest first, each
 * into the currently lightest bin (ties go to the earlier item and the lower
 * bin index), so the result depends only on the weights, their order, and
 * `binCount`. Every item lands in exactly one bin, which is what lets several
 * independent processes each take one bin and together cover the whole list.
 */
export function assignBalancedBins(
  weights: readonly number[],
  binCount: number,
): readonly number[] {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError(
      `A balanced partition needs a positive integer bin count (got ${binCount}).`,
    );
  }

  const heaviestFirst = weights
    .map((weight, position) => ({ weight, position }))
    .toSorted(
      (left, right) =>
        right.weight - left.weight || left.position - right.position,
    );

  const binLoads = Array.from({ length: binCount }, () => 0);
  const bins = Array.from({ length: weights.length }, () => 0);
  for (const { weight, position } of heaviestFirst) {
    const lightestBin = binLoads.indexOf(Math.min(...binLoads));
    binLoads[lightestBin] = (binLoads[lightestBin] ?? 0) + weight;
    bins[position] = lightestBin;
  }
  return bins;
}

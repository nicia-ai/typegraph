/**
 * Shape constants for the committed smoke fixture, shared between
 * `generate-smoke-fixture.ts` (which writes the CSVs) and
 * `verify-is2-tie-break.ts` (which needs to compute an exact expected
 * answer for one specific fixture row without re-running the generator —
 * generate-smoke-fixture.ts itself regenerates the fixture as a top-level
 * side effect on import, so its constants can't be imported directly).
 */
export const PERSON_COUNT = 30;
export const KNOWS_PER_PERSON = 4;
export const FORUM_COUNT = 5;
export const POST_COUNT = 40;
export const COMMENT_COUNT = 80;

/**
 * A dedicated adversarial person who authors a same-creationDate comment
 * cluster larger than any historically-used candidate buffer (see
 * reports/snb-lane1-results.md's IS2 saga) — this makes that person's
 * exact, known-correct IS2 top-10 answer computable in advance (the
 * cluster's 10 smallest message ids, since an identical creationDate
 * leaves ascending id as the only tie-break), so `verify-is2-tie-break.ts`
 * can check every engine against that oracle, not just against each other.
 *
 * Must equal PERSON_COUNT: ids for the PERSON_COUNT randomly generated
 * persons run 0..PERSON_COUNT-1, so this is the first id after that range
 * — a plain `= PERSON_COUNT` alias reads as a knip "duplicate export" (two
 * names for one binding), so the invariant is asserted at import time
 * instead.
 */
export const TIE_CLUSTER_PERSON_ID = 30;
if (TIE_CLUSTER_PERSON_ID !== PERSON_COUNT) {
  throw new Error(
    `TIE_CLUSTER_PERSON_ID (${TIE_CLUSTER_PERSON_ID}) must equal PERSON_COUNT (${PERSON_COUNT}) — update both together.`,
  );
}
/**
 * Two disjoint id blocks of *different digit widths*, not one contiguous
 * range — a contiguous range starting at TIE_CLUSTER_LOW_BLOCK.start (all
 * 3-digit ids, e.g. 120..144) would make unpadded lexicographic order and
 * numeric order coincide by construction (same-length numeral strings
 * always compare identically both ways), so the oracle would pass whether
 * or not dataset/ldbc-csv.ts's zero-padding fix is actually in place —
 * catching nothing. With a 3-digit block (120..129) and a 4-digit block
 * (1000..1014), unpadded lexicographic order ranks every 4-digit id ahead
 * of every 3-digit one ("1000" < "120" character-by-character) — the
 * wrong answer, which only zero-padding corrects.
 */
const TIE_CLUSTER_LOW_BLOCK = {
  start: POST_COUNT + COMMENT_COUNT,
  count: 10,
};
const TIE_CLUSTER_HIGH_BLOCK = { start: 1000, count: 15 };
if (
  TIE_CLUSTER_LOW_BLOCK.start + TIE_CLUSTER_LOW_BLOCK.count >
  TIE_CLUSTER_HIGH_BLOCK.start
) {
  throw new Error(
    "TIE_CLUSTER_LOW_BLOCK and TIE_CLUSTER_HIGH_BLOCK overlap — update the block bounds.",
  );
}
export const TIE_CLUSTER_SIZE =
  TIE_CLUSTER_LOW_BLOCK.count + TIE_CLUSTER_HIGH_BLOCK.count;

function blockIds(block: Readonly<{ start: number; count: number }>): number[] {
  return Array.from(
    { length: block.count },
    (_unused, index) => block.start + index,
  );
}

/** Every tie-cluster message id, across both blocks — the input the true top-10 answer is computed from. */
export const TIE_CLUSTER_MESSAGE_IDS: readonly number[] = [
  ...blockIds(TIE_CLUSTER_LOW_BLOCK),
  ...blockIds(TIE_CLUSTER_HIGH_BLOCK),
];

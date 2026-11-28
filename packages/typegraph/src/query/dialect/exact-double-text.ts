/**
 * Exact binary text of an IEEE-754 binary64: the one form SQLite renders a
 * REAL keyset key in and the one reader of that form.
 *
 * SQLite guarantees no decimal rendering of a REAL that reads back as the
 * same double: `CAST(x AS TEXT)` and a REAL's JSON text keep 15 significant
 * digits, and `printf('%!.17g', x)` is the output of SQLite's own decimal
 * conversion, which its documentation does not promise to be correctly
 * rounded. What the engine does guarantee is IEEE-754 arithmetic on REALs
 * (a product with a power of two is exact while it stays in range), exact
 * comparison of REALs with INTEGERs, the exact conversion of an integral
 * REAL below 2^63 to INTEGER, and exact INTEGER text. The rendering uses
 * only those: it scales `|x|` by powers of two into an integer significand
 * `m` and an exponent `e` with `|x| = m * 2^e`, and writes
 * `[-]<m>p<e>`. The reader assembles the double's bits from `m` and `e`, so
 * no decimal conversion runs on either side.
 */
import { sql, type SqlFragment } from "../sql-fragment";

/** The rendering of a zero, positive or negative. */
const ZERO_TEXT = "0";

/** The renderings of the two infinities, as SQLite's `printf` spells them. */
export const POSITIVE_INFINITY_TEXT = "Inf";
export const NEGATIVE_INFINITY_TEXT = "-Inf";

/** `[-]<m>p<e>`: a significand in [2^52, 2^53) and a binary exponent. */
const EXACT_DOUBLE_TEXT = /^(-?)([1-9]\d{15})p(-?\d{1,4})$/;

const SIGNIFICAND_MINIMUM = 2n ** 52n;
const SIGNIFICAND_LIMIT = 2n ** 53n;
/** The exponent of a significand's last bit for the smallest normal double. */
const MINIMUM_NORMAL_EXPONENT = -1074;
/** The exponent of a significand's last bit for the largest finite double. */
const MAXIMUM_EXPONENT = 971;
const EXPONENT_BIAS = 1075n;
const SIGN_BIT = 1n << 63n;

/**
 * The finite double `text` denotes when it is the exact binary text
 * {@link sqliteExactDoubleText} renders for one (`0`, or `[-]<m>p<e>` with
 * `m` in [2^52, 2^53) and `m * 2^e` a double), and `undefined` for any other
 * text, an infinity's rendering included.
 */
export function parseExactDoubleText(text: string): number | undefined {
  if (text === ZERO_TEXT) return 0;
  const match = EXACT_DOUBLE_TEXT.exec(text);
  if (match === null) return undefined;
  const [, sign = "", significandText = "", exponentText = ""] = match;
  const significand = BigInt(significandText);
  const exponent = Number(exponentText);
  if (significand < SIGNIFICAND_MINIMUM || significand >= SIGNIFICAND_LIMIT)
    return undefined;
  if (exponent > MAXIMUM_EXPONENT) return undefined;
  let bits: bigint;
  if (exponent >= MINIMUM_NORMAL_EXPONENT) {
    // A normal double: the biased exponent field, then the fraction bits.
    bits =
      ((BigInt(exponent) + EXPONENT_BIAS) << 52n) |
      (significand - SIGNIFICAND_MINIMUM);
  } else {
    // A subnormal: its significand is `m` shifted down to the smallest
    // exponent, which must drop only zero bits.
    const shift = BigInt(MINIMUM_NORMAL_EXPONENT - exponent);
    if (shift > 52n || significand % (1n << shift) !== 0n) return undefined;
    bits = significand >> shift;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, sign === "-" ? bits | SIGN_BIT : bits);
  return view.getFloat64(0);
}

/** `a * a * ... * a`, `count` factors, as SQL. */
function product(factor: string, count: number): string {
  return Array.from({ length: count }, () => factor).join(" * ");
}

function range(first: number, last: number): readonly number[] {
  return Array.from({ length: last - first + 1 }, (_unused, index) => {
    return first + index;
  });
}

/**
 * The SQL text of the stages of {@link sqliteExactDoubleText}, built once.
 * Every power of two is a product of `p32` (2^32, an exact INTEGER-to-REAL
 * conversion) or `n32` (2^-32, an exact division), so no decimal literal
 * the parser might round is involved, and every product stays a power of
 * two the engine holds exactly (2^-1024 is subnormal but exact).
 */
function buildExactDoubleStages(): Readonly<{
  coarse: string;
  medium: string;
  final: string;
}> {
  const p256 = `(${product("p32", 8)})`;
  const n256 = `(${product("n32", 8)})`;
  // Coarse: |v| into [1, 2^256) by factors of 2^256. Above 1 it divides by
  // 2^256 once per threshold 2^256, 2^512, 2^768 that |v| reaches; below 1
  // it multiplies by 2^256 once per threshold 1, 2^-256, ..., 2^-1024 that
  // |v| is under. The factors apply left to right, so every partial product
  // moves toward the target range and stays exact.
  const coarseDown = range(1, 3).map((count) => {
    return `abs(v) >= ${product(p256, count)}`;
  });
  const coarseUp = range(0, 4).map((count) => {
    return count === 0 ? "abs(v) < 1.0" : `abs(v) < ${product(n256, count)}`;
  });
  const coarseScaled = [
    "abs(v)",
    ...coarseDown.map((test) => `CASE WHEN ${test} THEN ${n256} ELSE 1.0 END`),
    ...coarseUp.map((test) => `CASE WHEN ${test} THEN ${p256} ELSE 1.0 END`),
  ].join(" * ");
  const coarseExponent = `256 * (${coarseDown.map((test) => `(${test})`).join(" + ")} - ${coarseUp.map((test) => `(${test})`).join(" - ")})`;
  // Medium: y from [1, 2^256) into [1, 2^32) by factors of 2^32.
  const mediumDown = range(1, 7).map((count) => {
    return `y >= ${product("p32", count)}`;
  });
  const mediumScaled = [
    "y",
    ...mediumDown.map((test) => `CASE WHEN ${test} THEN n32 ELSE 1.0 END`),
  ].join(" * ");
  const mediumExponent = `e + 32 * (${mediumDown.map((test) => `(${test})`).join(" + ")})`;
  // Final: the bit length of y in [1, 2^32) less one, against INTEGER
  // thresholds, which compare with a REAL exactly. y times 2^(52 - that) is
  // the integral significand in [2^52, 2^53), exact as an INTEGER. A finite
  // y is under 2^32, so a y at or past it is an infinity.
  const bitLength = `(${range(1, 31)
    .map((bit) => `(y >= ${2 ** bit})`)
    .join(" + ")})`;
  const final = `CASE WHEN v = 0 THEN '${ZERO_TEXT}' WHEN y >= 4294967296 THEN CASE WHEN v < 0 THEN '${NEGATIVE_INFINITY_TEXT}' ELSE '${POSITIVE_INFINITY_TEXT}' END ELSE CASE WHEN v < 0 THEN '-' ELSE '' END || CAST(CAST(y * (1 << (52 - ${bitLength})) AS INTEGER) AS TEXT) || 'p' || CAST(e + ${bitLength} - 52 AS TEXT) END`;
  return {
    coarse: `v, p32, n32, ${coarseScaled} AS y, ${coarseExponent} AS e`,
    medium: `v, ${mediumScaled} AS y, ${mediumExponent} AS e`,
    final,
  };
}

const EXACT_DOUBLE_STAGES = buildExactDoubleStages();

/**
 * SQLite SQL rendering the REAL `expression` as its exact binary text (see
 * the module comment), `Inf` / `-Inf` for an infinity, `0` for a zero, and
 * NULL for NULL. `expression` is read once, by the innermost subquery, so a
 * computed key is evaluated once. `LIMIT -1 OFFSET 0` keeps SQLite from
 * flattening a stage into the next, which would copy each stage's
 * expression into every reference to its columns. Three stages keep the
 * nesting within the parser depth of the SQLite libSQL ships.
 */
export function sqliteExactDoubleText(expression: SqlFragment): SqlFragment {
  const { coarse, medium, final } = EXACT_DOUBLE_STAGES;
  const constants = sql.raw(
    ", CAST(4294967296 AS REAL) AS p32, 1.0 / CAST(4294967296 AS REAL) AS n32 LIMIT -1 OFFSET 0",
  );
  const source = sql`SELECT ${expression} AS v${constants}`;
  return sql`(SELECT ${sql.raw(final)} FROM (SELECT ${sql.raw(medium)} FROM (SELECT ${sql.raw(coarse)} FROM (${source}) LIMIT -1 OFFSET 0) LIMIT -1 OFFSET 0))`;
}

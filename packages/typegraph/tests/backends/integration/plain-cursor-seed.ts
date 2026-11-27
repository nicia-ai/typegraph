/**
 * The rows and sorts the plain-cursor golden fixtures were issued over
 * (`scripts/capture-plain-cursor-fixtures.ts`), shared with the suite that
 * resumes them (`plain-cursor-compatibility.ts`) so both see the same data.
 *
 * Every sortable value type a field of the shared integration graph holds:
 * booleans, numbers (zero, negative, integer, fraction, the largest safe
 * integer), strings (Latin-1, as the release before this one could only encode), dates, and NULL (an absent optional
 * field), with ties so the id tiebreak carries positions too.
 */

export type PlainCursorSort = Readonly<{
  kind: "Product" | "Document";
  field: string;
  direction: "asc" | "desc";
}>;

export type PlainCursorFixture = Readonly<{
  lane: "sqlite" | "libsql" | "pglite";
  sort: PlainCursorSort;
  cursor: string;
  /** The terminals and selections that issued this exact cursor. */
  issuedBy: readonly string[];
  /** The ids `paginate({ first: 100, after: cursor })` returned. */
  after: readonly string[];
  /** The ids `paginate({ last: 100, before: cursor })` returned. */
  before: readonly string[];
}>;

type SeedRow = Readonly<{
  kind: "Product" | "Document";
  id: string;
  props: Readonly<Record<string, unknown>>;
}>;

export const PLAIN_CURSOR_SEED: readonly SeedRow[] = [
  {
    kind: "Product",
    id: "p1",
    props: {
      name: "Ångström",
      price: 0,
      category: "c",
      inStock: true,
      rating: 4.5,
    },
  },
  {
    kind: "Product",
    id: "p2",
    props: { name: "apple", price: -3.25, category: "c", inStock: false },
  },
  {
    kind: "Product",
    id: "p3",
    props: { name: "banana", price: 12, category: "c", rating: 0.1 },
  },
  {
    kind: "Product",
    id: "p4",
    props: {
      name: "cherry",
      price: 9_007_199_254_740_991,
      category: "c",
      inStock: true,
      rating: -2,
    },
  },
  {
    kind: "Product",
    id: "p5",
    props: {
      name: "date",
      price: 0.1,
      category: "c",
      inStock: false,
      rating: 3,
    },
  },
  {
    kind: "Document",
    id: "d1",
    props: { title: "one", publishedAt: "2024-01-02T03:04:05.678Z" },
  },
  { kind: "Document", id: "d2", props: { title: "two" } },
  {
    kind: "Document",
    id: "d3",
    props: { title: "three", publishedAt: "1999-12-31T23:59:59.000Z" },
  },
  {
    kind: "Document",
    id: "d4",
    props: { title: "four", publishedAt: "2024-01-02T03:04:05.678Z" },
  },
];

export const PLAIN_CURSOR_SORTS: readonly PlainCursorSort[] = [
  ...(["inStock", "price", "rating", "name"] as const).flatMap((field) =>
    (["asc", "desc"] as const).map(
      (direction) => ({ kind: "Product", field, direction }) as const,
    ),
  ),
  ...(["publishedAt", "title"] as const).flatMap((field) =>
    (["asc", "desc"] as const).map(
      (direction) => ({ kind: "Document", field, direction }) as const,
    ),
  ),
];

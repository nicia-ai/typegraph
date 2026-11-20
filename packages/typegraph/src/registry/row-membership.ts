/**
 * Which of a population's non-deleted rows are its members: every one
 * (`"allRows"`), or only a row whose validity window is still open
 * (`"openRows"`, no `validTo`).
 *
 * A static property of a row, never of an instant: composition refuses a
 * window that ends or starts later than its write
 * (`assertCompositionWindowCurrent`,
 * `src/store/operations/composition-create.ts`), so an open-ended
 * composition row is current and an ended one is history, for good. That is
 * what lets one predicate, `membershipCountsRow`
 * (`src/store/claims/edge-claims.ts`), decide membership for a claim, the
 * audit, the cascade and the acyclicity relation alike.
 *
 * Declared at the registry layer because both the store's claims and the
 * query compiler's composition navigation read it, and the query layer does
 * not depend on the store.
 */
export type RowMembership = "allRows" | "openRows";

/**
 * Predicate for values that are materially present in database rows.
 */
export function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

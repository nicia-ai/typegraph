type RowWithId = Readonly<{ id: string }>;

export type RowFetchPolicy<Row extends RowWithId> = Readonly<{
  batch?: ((ids: readonly string[]) => Promise<readonly Row[]>) | undefined;
  one: (id: string) => Promise<Row | undefined>;
}>;

/**
 * Shared "batch if available, otherwise deduped single reads" policy for
 * store row hydration. Node and edge callers supply only the backend-specific
 * read functions, so future bind-limit/chunking changes land in one place.
 */
export async function getRowsByIds<Row extends RowWithId>(
  ids: readonly string[],
  policy: RowFetchPolicy<Row>,
): Promise<Map<string, Row>> {
  const rowsById = new Map<string, Row>();
  if (ids.length === 0) return rowsById;

  if (policy.batch !== undefined) {
    const rows = await policy.batch(ids);
    for (const row of rows) {
      rowsById.set(row.id, row);
    }
    return rowsById;
  }

  const uniqueIds = [...new Set(ids)];
  const rows = await Promise.all(uniqueIds.map((id) => policy.one(id)));
  for (const row of rows) {
    if (row !== undefined) rowsById.set(row.id, row);
  }
  return rowsById;
}

import {
  type EdgeRow,
  type FindEdgesByKindParams,
  type FindNodesByKindParams,
  type GraphReadBackend,
  type NodeRow,
} from "../backend/types";
import { requireDefined } from "../utils/presence";

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

/**
 * Every row `findNodesByKind` returns for `params`, one keyset page (ordered
 * by id) at a time. A short page is the last; no read follows it.
 */
export async function* pageNodesByKind(
  backend: Pick<GraphReadBackend, "findNodesByKind">,
  params: Omit<FindNodesByKindParams, "orderBy" | "limit" | "after" | "offset">,
  pageSize: number,
): AsyncGenerator<readonly NodeRow[]> {
  let after: string | undefined;
  for (;;) {
    const rows = await backend.findNodesByKind({
      ...params,
      orderBy: "id",
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
    });
    yield rows;
    if (rows.length < pageSize) return;
    after = requireDefined(
      rows.at(-1),
      "findNodesByKind returned a full page with no last row",
    ).id;
  }
}

/**
 * Every row `findEdgesByKind` returns for `params`, one keyset page (ordered
 * by id) at a time. A short page is the last; no read follows it.
 */
export async function* pageEdgesByKind(
  backend: Pick<GraphReadBackend, "findEdgesByKind">,
  params: Omit<FindEdgesByKindParams, "orderBy" | "limit" | "after" | "offset">,
  pageSize: number,
): AsyncGenerator<readonly EdgeRow[]> {
  let after: string | undefined;
  for (;;) {
    const rows = await backend.findEdgesByKind({
      ...params,
      orderBy: "id",
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
    });
    yield rows;
    if (rows.length < pageSize) return;
    after = requireDefined(
      rows.at(-1),
      "findEdgesByKind returned a full page with no last row",
    ).id;
  }
}

/**
 * Rebuilds the fulltext index from existing node data.
 *
 * Iterates nodes via keyset pagination (ORDER BY id ASC, WHERE id > cursor)
 * so rebuild is stable even under shared created_at timestamps and light
 * concurrent writes. Each page runs in its own transaction; batch primitives
 * are used when the backend provides them, with per-row fallback otherwise.
 *
 * Rebuild is a maintenance operation. Concurrent deletes that happen
 * between page fetches can be missed by this pass — document as such.
 */
import { type z } from "zod";

import {
  type GraphBackend,
  type NodeRow,
  rowPropsToObject,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../backend/types";
import { ConfigurationError, ValidationError } from "../errors";
import { type KindRegistry } from "../registry";
import { computeFulltextContent, getSearchableFields } from "./fulltext-sync";

/**
 * Default page size. Fits under SQLite's ~32766 placeholder limit with
 * headroom: 6 params/row × 500 rows + 500-entry DELETE IN list ≈ 3500
 * placeholders. Bumping past ~5000 risks the ceiling on SQLite.
 */
const DEFAULT_PAGE_SIZE = 500;

/**
 * Default cap on the length of `skippedIds` returned from rebuild. A
 * corrupted database could produce millions of skipped rows; surfacing
 * them all as a single in-memory array would turn a recovery tool into
 * an OOM. The total skipped *count* remains accurate; only the ID
 * listing is truncated. Operators who need the full list for recovery
 * can raise the cap via `maxSkippedIds`.
 */
const DEFAULT_MAX_SKIPPED_IDS = 10_000;

export type RebuildFulltextOptions = Readonly<{
  /** Page size. Must be a positive integer. Default: 500. */
  pageSize?: number;
  /**
   * Maximum number of skipped node IDs to include in the `skippedIds`
   * array. Default: 10,000. Set higher to collect the full list when
   * investigating systemic corruption; set lower when `processed` is
   * all you care about. The `skipped` total is always accurate.
   */
  maxSkippedIds?: number;
}>;

export type RebuildFulltextResult = Readonly<{
  /** Node kinds that were rebuilt (those with at least one searchable field). */
  kinds: readonly string[];
  /** Total nodes scanned. */
  processed: number;
  /** Fulltext upsert operations executed. */
  upserted: number;
  /** Fulltext delete operations executed (soft-deleted or all-empty nodes). */
  cleared: number;
  /**
   * Nodes skipped due to corrupt or non-object `props` (not counted in
   * upserted/cleared).
   */
  skipped: number;
  /**
   * IDs of skipped nodes, capped at 10,000 entries so pathological
   * corruption doesn't turn rebuild into an OOM. See `skippedTruncated`
   * to tell whether the cap was hit. Empty when `skipped === 0`.
   */
  skippedIds: readonly string[];
  /** True when `skipped > skippedIds.length` (the cap was reached). */
  skippedTruncated: boolean;
}>;

type RebuildContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  registry: KindRegistry;
}>;

/** Anything the rebuild can read nodes from and write fulltext rows to. */
type FulltextRebuildTarget = GraphBackend | TransactionBackend;

/**
 * How the rebuild frames its writes. The paging, content computation, and
 * accounting are identical whichever way a caller drives it; only the
 * transaction boundary differs, so that is the only thing injected.
 *
 * - The standalone `store.search.rebuildFulltext()` transacts per page, so
 *   a maintenance pass over a large graph never holds one long
 *   transaction and can resume where it stopped.
 * - The destructive `store.rebuildContribution()` runs every page inside
 *   the single transaction that also dropped, recreated, and will stamp
 *   the storage, because there the refill is not optional: publishing the
 *   marker over a half-filled table would advertise a healthy index that
 *   answers queries with nothing.
 */
type FulltextRebuildDriver = Readonly<{
  /** Backend the paged node reads go through. */
  read: FulltextRebuildTarget;
  /** Runs one page's writes under whatever framing the caller wants. */
  runPage: (
    write: (target: FulltextRebuildTarget) => Promise<void>,
  ) => Promise<void>;
}>;

function validatePageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(
      `pageSize must be a positive integer, got: ${String(value)}`,
      {
        issues: [{ path: "pageSize", message: "Must be a positive integer." }],
      },
    );
  }
  return value;
}

function validateMaxSkippedIds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SKIPPED_IDS;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `maxSkippedIds must be a non-negative integer, got: ${String(value)}`,
      {
        issues: [
          {
            path: "maxSkippedIds",
            message: "Must be a non-negative integer.",
          },
        ],
      },
    );
  }
  return value;
}

function isPropsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function rebuildFulltextIndex(
  ctx: RebuildContext,
  nodeKind: string | undefined,
  options: RebuildFulltextOptions,
): Promise<RebuildFulltextResult> {
  const { backend } = ctx;
  return runFulltextRebuild(
    {
      read: backend,
      runPage: (write) => runOptionallyInTransaction(backend, write),
    },
    ctx,
    nodeKind,
    options,
  );
}

/**
 * Reconstructs fulltext content entirely inside a transaction the caller
 * already owns, with no nested transaction of its own.
 *
 * Used by the destructive contribution rebuild, whose whole point is that
 * the drop, the recreate, this refill, and the marker stamp commit
 * together. `target` must be a transaction-scoped backend whose fulltext
 * methods are NOT gated on the durable marker: this runs while the
 * contribution is mid-rebuild, so a gate would refuse the very writes
 * that make it healthy again.
 */
export async function repopulateFulltextInTransaction(
  ctx: Readonly<{ graphId: string; registry: KindRegistry }>,
  target: TransactionBackend,
  options: RebuildFulltextOptions = {},
): Promise<RebuildFulltextResult> {
  return runFulltextRebuild(
    { read: target, runPage: (write) => write(target) },
    ctx,
    undefined,
    options,
  );
}

async function runFulltextRebuild(
  driver: FulltextRebuildDriver,
  ctx: Readonly<{ graphId: string; registry: KindRegistry }>,
  nodeKind: string | undefined,
  options: RebuildFulltextOptions,
): Promise<RebuildFulltextResult> {
  const { registry } = ctx;
  const backend = driver.read;

  // Member presence rather than `resolveBackendFulltext`: this is the type
  // guard that narrows `backend.upsertFulltext` / `backend.deleteFulltext`
  // for the calls the rebuild loop below makes.
  if (!backend.upsertFulltext || !backend.deleteFulltext) {
    throw new ConfigurationError(
      "Backend does not support fulltext; cannot rebuild index",
      { backend: backend.dialect, capability: "fulltext" },
    );
  }

  const pageSize = validatePageSize(options.pageSize);
  const maxSkippedIds = validateMaxSkippedIds(options.maxSkippedIds);

  const targetKinds =
    nodeKind === undefined ? [...registry.nodeKinds.keys()] : [nodeKind];

  const rebuiltKinds: string[] = [];
  let processed = 0;
  let upserted = 0;
  let cleared = 0;
  let skipped = 0;
  const skippedIds: string[] = [];

  for (const kind of targetKinds) {
    const nodeType = registry.getNodeType(kind);
    if (!nodeType) {
      throw new ConfigurationError(`Unknown node kind: ${kind}`, { kind });
    }
    if (getSearchableFields(nodeType.schema).length === 0) {
      continue;
    }

    rebuiltKinds.push(kind);
    let cursor: string | undefined;
    for (;;) {
      // Keyset pagination on id. Include soft-deleted nodes so their
      // stale fulltext rows get cleaned up by this rebuild.
      const rows = await backend.findNodesByKind({
        graphId: ctx.graphId,
        kind,
        limit: pageSize,
        excludeDeleted: false,
        orderBy: "id",
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      if (rows.length === 0) break;

      const pageResult = processPage(nodeType.schema, rows);
      skipped += pageResult.skipped;
      const remaining = maxSkippedIds - skippedIds.length;
      if (remaining > 0 && pageResult.skippedIds.length > 0) {
        skippedIds.push(...pageResult.skippedIds.slice(0, remaining));
      }

      const writePage = async (
        target: FulltextRebuildTarget,
      ): Promise<void> => {
        if (pageResult.toUpsert.length > 0) {
          if (target.upsertFulltextBatch) {
            await target.upsertFulltextBatch({
              graphId: ctx.graphId,
              nodeKind: kind,
              rows: pageResult.toUpsert,
            });
          } else if (target.upsertFulltext) {
            for (const item of pageResult.toUpsert) {
              await target.upsertFulltext({
                graphId: ctx.graphId,
                nodeKind: kind,
                nodeId: item.nodeId,
                content: item.content,
                language: item.language,
              });
            }
          }
        }
        if (pageResult.toDelete.length > 0) {
          if (target.deleteFulltextBatch) {
            await target.deleteFulltextBatch({
              graphId: ctx.graphId,
              nodeKind: kind,
              nodeIds: pageResult.toDelete,
            });
          } else if (target.deleteFulltext) {
            for (const nodeId of pageResult.toDelete) {
              await target.deleteFulltext({
                graphId: ctx.graphId,
                nodeKind: kind,
                nodeId,
              });
            }
          }
        }
      };

      // Framed by the driver: transacted per page for a standalone
      // maintenance pass (so a partial failure mid-page doesn't leave the
      // index half-rebuilt, and a backend without transactions still
      // rebuilds rather than staying permanently stale), or run directly
      // on the caller's transaction when the refill is one step of a
      // larger atomic operation.
      await driver.runPage(writePage);

      processed += rows.length;
      upserted += pageResult.toUpsert.length;
      cleared += pageResult.toDelete.length;

      const lastRow = rows.at(-1);
      if (!lastRow) break;
      cursor = lastRow.id;
      if (rows.length < pageSize) break;
    }
  }

  return {
    kinds: rebuiltKinds,
    processed,
    upserted,
    cleared,
    skipped,
    skippedIds,
    skippedTruncated: skipped > skippedIds.length,
  };
}

interface PageResult {
  toUpsert: { nodeId: string; content: string; language: string }[];
  toDelete: string[];
  skipped: number;
  skippedIds: string[];
}

function processPage(schema: z.ZodType, rows: readonly NodeRow[]): PageResult {
  const toUpsert: PageResult["toUpsert"] = [];
  const toDelete: string[] = [];
  const skippedIds: string[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (row.deleted_at !== undefined) {
      toDelete.push(row.id);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = rowPropsToObject(row.props);
    } catch {
      skipped += 1;
      skippedIds.push(row.id);
      continue;
    }
    if (!isPropsObject(parsed)) {
      skipped += 1;
      skippedIds.push(row.id);
      continue;
    }
    const computed = computeFulltextContent(schema, parsed);
    if (computed === undefined) {
      toDelete.push(row.id);
    } else {
      toUpsert.push({
        nodeId: row.id,
        content: computed.content,
        language: computed.language,
      });
    }
  }

  return { toUpsert, toDelete, skipped, skippedIds };
}

/** Raw, tombstone-preserving ancestor reads for an incremental merge. */
import { parseRecordedInstant, type RecordedInstant } from "../core/temporal";
import { ConfigurationError } from "../errors";
import { refuseEngineNativeRecordedIdentityRead } from "../identity/historical-sql";
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
  toTransferAssertion,
} from "../identity/row-codec";
import type { IdentityTransferAssertion } from "../identity/service-types";
import { getDialect } from "../query/dialect";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { requireDefined } from "../utils/presence";
import type { EdgeRow, NodeRow, StateDiffBaseReader } from "./state-diff";
import type { GraphDef, Store } from "./typegraph-internal";
import { storeBackend, storeRuntime } from "./typegraph-internal";

const PAGE_SIZE = 1000;
const ID_CHUNK_SIZE = 400;

type RawNodeRow = Omit<NodeRow, "deleted_at" | "valid_from" | "valid_to"> &
  Readonly<{
    deleted_at: string | undefined | null;
    valid_from: string | undefined | null;
    valid_to: string | undefined | null;
  }>;
type RawEdgeRow = Omit<EdgeRow, "deleted_at" | "valid_from" | "valid_to"> &
  Readonly<{
    deleted_at: string | undefined | null;
    valid_from: string | undefined | null;
    valid_to: string | undefined | null;
  }>;

function normalizeNode(row: RawNodeRow): NodeRow {
  return {
    ...row,
    deleted_at: row.deleted_at ?? undefined,
    valid_from: row.valid_from ?? undefined,
    valid_to: row.valid_to ?? undefined,
  };
}

function normalizeEdge(row: RawEdgeRow): EdgeRow {
  return {
    ...row,
    deleted_at: row.deleted_at ?? undefined,
    valid_from: row.valid_from ?? undefined,
    valid_to: row.valid_to ?? undefined,
  };
}

function uniqueRowsById<T extends Readonly<{ id: string }>>(
  rows: readonly T[],
  entity: "node" | "edge" | "identity assertion",
): readonly T[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) {
      throw new ConfigurationError(
        `Recorded ${entity} history contains overlapping rows for id "${row.id}".`,
        { code: "RECORDED_RELATION_INVARIANT_VIOLATION", entity, id: row.id },
      );
    }
    ids.add(row.id);
  }
  return rows;
}

async function collectPages<T extends Readonly<{ id: string }>>(
  fetchPage: (after: string | undefined) => Promise<readonly T[]>,
): Promise<readonly T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage(after);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    after = requireDefined(page.at(-1)).id;
  }
}

/**
 * Creates a read source pinned to the recorded fork cut. It reads raw row images
 * rather than StoreView entities so hard/soft deletions and valid-time windows
 * retain the exact representation the ordinary state diff compares.
 */
export function createRecordedBaseReader<G extends GraphDef>(
  target: Store<G>,
  recorded: RecordedInstant,
): StateDiffBaseReader {
  const binding = storeRuntime(target).recordedReadBinding;
  if (binding === undefined) {
    throw new ConfigurationError(
      "A recorded fork point requires a target with a recorded read source.",
      { code: "RECORDED_READ_REQUIRES_BINDING" },
    );
  }
  const readBinding = binding;
  const revision = parseRecordedInstant(recorded, "forkPoint.recorded");
  const backend = storeBackend(target);
  const idOrder = getDialect(backend.dialect).binaryText(sql`r.id`);
  const sourceFor = (table: "nodes" | "edges" | "identityAssertions") =>
    readBinding.source(table, revision);
  const recordedPredicate = readBinding.predicate(sql`r.`, revision);
  const intervalFilter =
    recordedPredicate === undefined ? sql`` : sql`AND ${recordedPredicate}`;
  const identityReads = new Map<
    "state" | "archival",
    Promise<readonly IdentityTransferAssertion[]>
  >();

  async function readRows<T extends Readonly<{ id: string }>>(
    entity: "node" | "edge",
    kind: string,
    ids?: readonly string[],
  ): Promise<readonly T[]> {
    if (ids?.length === 0) return [];
    const table = sourceFor(entity === "node" ? "nodes" : "edges");
    const collected: T[] = [];
    const uniqueIds = ids === undefined ? [] : [...new Set(ids)];
    const idGroups: readonly (readonly string[])[] =
      ids === undefined ?
        [[]]
      : Array.from(
          { length: Math.ceil(uniqueIds.length / ID_CHUNK_SIZE) },
          (_, index) =>
            uniqueIds.slice(index * ID_CHUNK_SIZE, (index + 1) * ID_CHUNK_SIZE),
        );
    for (const group of idGroups) {
      collected.push(
        ...(await collectPages<T>(async (after) => {
          const idFilter =
            ids === undefined ?
              sql``
            : sql`AND r.id IN (${sql.join(
                group.map((id) => sql`${id}`),
                sql`, `,
              )})`;
          const afterFilter =
            after === undefined ? sql`` : sql`AND ${idOrder} > ${after}`;
          return backend.execute<T>(
            asCompiledRowsSql(sql`
              SELECT r.* FROM ${table} r
              WHERE r.graph_id = ${target.graphId} AND r.kind = ${kind}
                ${intervalFilter} ${idFilter} ${afterFilter}
              ORDER BY ${idOrder} ASC LIMIT ${PAGE_SIZE}
            `),
          );
        })),
      );
    }
    return uniqueRowsById(collected, entity);
  }

  async function loadIdentity(
    mode: "state" | "archival",
  ): Promise<readonly IdentityTransferAssertion[]> {
    if (target.graph.identity === undefined) return [];
    if (readBinding.kind === "engine-native") {
      refuseEngineNativeRecordedIdentityRead("recorded incremental merge");
    }
    const table = sourceFor("identityAssertions");
    const stateFilter = mode === "state" ? sql`AND r.valid_to IS NULL` : sql``;
    const rows = await collectPages<RawIdentityAssertionRow>(async (after) => {
      const afterFilter =
        after === undefined ? sql`` : sql`AND ${idOrder} > ${after}`;
      return backend.execute<RawIdentityAssertionRow>(
        asCompiledRowsSql(sql`
          SELECT r.* FROM ${table} r
          WHERE r.graph_id = ${target.graphId}
            AND r.deleted_at IS NULL ${stateFilter}
            ${intervalFilter} ${afterFilter}
          ORDER BY ${idOrder} ASC LIMIT ${PAGE_SIZE}
        `),
      );
    });
    return uniqueRowsById(rows, "identity assertion").map((row) =>
      toTransferAssertion(normalizeIdentityAssertionRow(row)),
    );
  }

  function readIdentity(
    mode: "state" | "archival",
  ): Promise<readonly IdentityTransferAssertion[]> {
    const existing = identityReads.get(mode);
    if (existing !== undefined) return existing;
    const pending = loadIdentity(mode);
    identityReads.set(mode, pending);
    return pending;
  }

  return {
    async readNodes(kind, ids) {
      const rows = await readRows<RawNodeRow>("node", kind, ids);
      return rows.map((row) => normalizeNode(row));
    },
    async readEdges(kind, ids) {
      const rows = await readRows<RawEdgeRow>("edge", kind, ids);
      return rows.map((row) => normalizeEdge(row));
    },
    readIdentity,
  };
}

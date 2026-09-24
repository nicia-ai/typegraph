/**
 * A lossless, graph-scoped PostgreSQL fork into an independently allocated
 * database. The destination remains caller-owned and unpublished throughout
 * this operation. No interchange representation is involved.
 */
import { backendDerivationRoot } from "../backend/derive-backend";
import type { GraphBackend } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { tsvectorStrategy } from "../query/dialect/fulltext-strategy";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { createStore, type Store } from "../store/store";
import type { StoreOptions } from "../store/types";
import { sha256Hex } from "../utils/hash";
import {
  computeBaseVersion,
  readActiveSchemaVersion,
  revisionAnchorOf,
  revisionOriginOf,
  schemaActiveVersionOf,
} from "./base-version";
import { BranchError } from "./errors";
import {
  isBackendDerivedFrom,
  readRecordedClock,
  readRevisionOrigin,
  sharesSerializedTransactionResource,
  storeBackend,
} from "./typegraph-internal";
import type { BaseVersion } from "./types";

const DEFAULT_NAMES: Readonly<Record<string, string>> = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  recordedNodes: "typegraph_recorded_nodes",
  recordedEdges: "typegraph_recorded_edges",
  recordedClock: "typegraph_recorded_clock",
  revisionOrigins: "typegraph_revision_origins",
  revisionChanges: "typegraph_revision_changes",
  identityAssertions: "typegraph_identity_assertions",
  recordedIdentityAssertions: "typegraph_recorded_identity_assertions",
  identityClosure: "typegraph_identity_closure",
  identitySeparation: "typegraph_identity_separation",
  uniques: "typegraph_node_uniques",
  edgeClaims: "typegraph_edge_claims",
  fences: "typegraph_fences",
  schemaVersions: "typegraph_schema_versions",
  fulltext: "typegraph_node_fulltext",
};

/** The bundled graph-scoped relations, in copy order. Fence rows are shared. */
const GRAPH_RELATIONS = [
  ...Object.entries(DEFAULT_NAMES)
    .filter(([key]) => key !== "fences")
    .map(([, table]) => table),
  "typegraph_index_materializations",
  "typegraph_contribution_materializations",
  "typegraph_kind_removals",
  "typegraph_reconciliation_markers",
] as const;

type QuerySession = Pick<GraphBackend, "execute" | "getActiveSchema">;
type JsonRow = Readonly<Record<string, unknown>>;
type RowEnvelope = Readonly<{ row: JsonRow }>;
type ColumnRow = Readonly<{ column_name: string }>;
type ExistsRow = Readonly<{ present: boolean }>;
type IsolationRow = Readonly<{ transaction_isolation: string }>;
type IndexRow = Readonly<{ indexname: string }>;
type LockRow = Readonly<{ acquired: boolean }>;
type LedgerRow = Readonly<{
  graph_id: string;
  source_base: string;
  content_digest: string;
  copied_at: string;
}>;

/** Proof of a validated, unpublished target namespace. */
export type NamespaceForkProof = Readonly<{
  graphId: string;
  operationKey: string;
  sourceBase: BaseVersion;
  contentDigest: string;
  copiedAt: string;
}>;

/** The caller owns the target backend and decides when to publish it. */
export type NamespaceFork<G extends GraphDef> = Readonly<{
  store: Store<G>;
  proof: NamespaceForkProof;
  /** Discard an unchanged private target and its operation key atomically. */
  abort: () => Promise<void>;
}>;

function queryRows<T>(
  session: QuerySession,
  query: SqlFragment,
): Promise<readonly T[]> {
  return session.execute<T>(asCompiledRowsSql(query));
}

function assertDefaultTables(backend: GraphBackend): void {
  const fulltextStrategy = backend.fulltextStrategy;
  if (
    backend.dialect !== "postgres" ||
    backend.vectorStrategy !== undefined ||
    (fulltextStrategy !== undefined && fulltextStrategy !== tsvectorStrategy)
  ) {
    throw new BranchError(
      "Namespace fork supports bundled PostgreSQL tables without custom vector or fulltext storage.",
    );
  }
  assertDefaultNameMap(backend.tableNames);
}

function assertDefaultNameMap(names: object | undefined): void {
  if (names === undefined) return;
  for (const [key, actual] of Object.entries(names)) {
    if (actual !== DEFAULT_NAMES[key]) {
      throw new BranchError(
        `Namespace fork cannot copy custom table mapping ${key}.`,
      );
    }
  }
}

async function columns(
  session: QuerySession,
  table: string,
): Promise<readonly string[]> {
  const rows = await queryRows<ColumnRow>(
    session,
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table} AND is_generated = 'NEVER' ORDER BY ordinal_position`,
  );
  if (rows.length === 0)
    throw new BranchError(
      `Namespace fork requires relation ${table} in the bundled PostgreSQL schema.`,
    );
  return rows.map((row) => row.column_name);
}

async function graphRows(
  session: QuerySession,
  table: string,
  graphId: string,
): Promise<readonly JsonRow[]> {
  const rows = await queryRows<RowEnvelope>(
    session,
    sql`SELECT to_jsonb(row) AS row FROM ${sql.identifier(table)} AS row WHERE graph_id = ${graphId}`,
  );
  return rows.map((entry) => entry.row);
}

async function digestRows(rows: readonly JsonRow[]): Promise<string> {
  return sha256Hex(
    JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()),
    32,
  );
}

async function digestGraph(
  session: QuerySession,
  graphId: string,
): Promise<string> {
  const digests: [string, string][] = [];
  for (const table of GRAPH_RELATIONS) {
    digests.push([
      table,
      await digestRows(await graphRows(session, table, graphId)),
    ]);
  }
  return sha256Hex(JSON.stringify(digests), 32);
}

async function assertPhysicalIndexes(
  session: QuerySession,
  rows: readonly JsonRow[],
): Promise<void> {
  const names = rows.map((row) => row["index_name"]);
  if (names.some((name) => typeof name !== "string"))
    throw new BranchError(
      "Malformed index materialization row in source namespace.",
    );
  const physical = await queryRows<IndexRow>(
    session,
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  const present = new Set(physical.map((row) => row.indexname));
  for (const name of names) {
    if (typeof name === "string" && !present.has(name)) {
      throw new BranchError(
        `Target database lacks materialized graph index ${name}.`,
      );
    }
  }
}

async function assertSupportedContributions(
  session: QuerySession,
  rows: readonly JsonRow[],
): Promise<void> {
  for (const row of rows) {
    if (
      row["logical_name"] !== "fulltext" ||
      row["owner"] !== "tsvector" ||
      row["table_name"] !== "typegraph_node_fulltext"
    ) {
      throw new BranchError(
        "Namespace fork cannot copy strategy-owned contribution tables without a storage strategy copy port.",
      );
    }
  }
  if (rows.length > 0) await columns(session, "typegraph_node_fulltext");
}

async function assertEmpty(
  session: QuerySession,
  graphId: string,
): Promise<void> {
  for (const table of GRAPH_RELATIONS) {
    const rows = await queryRows<ExistsRow>(
      session,
      sql`SELECT EXISTS(SELECT 1 FROM ${sql.identifier(table)} WHERE graph_id = ${graphId}) AS present`,
    );
    if (rows[0]?.present !== false)
      throw new BranchError(
        "Namespace fork target already contains this graph; use the same operation key to retry.",
      );
  }
}

async function insertRows(
  session: QuerySession,
  table: string,
  rows: readonly JsonRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const names = await columns(session, table);
  if (!names.includes("graph_id"))
    throw new BranchError(
      `Namespace fork relation ${table} is not graph-scoped.`,
    );
  const selected = sql.join(
    names.map((name) => sql.identifier(name)),
    sql`, `,
  );
  for (let offset = 0; offset < rows.length; offset += 128) {
    const chunk = rows.slice(offset, offset + 128);
    await queryRows(
      session,
      sql`INSERT INTO ${sql.identifier(table)} (${selected}) SELECT ${selected} FROM jsonb_populate_recordset(NULL::${sql.identifier(table)}, ${JSON.stringify(chunk)}::jsonb)`,
    );
  }
}

function proofFromLedger(
  row: LedgerRow,
  operationKey: string,
): NamespaceForkProof {
  let decodedBase: unknown;
  try {
    decodedBase = JSON.parse(row.source_base);
  } catch (error) {
    throw new BranchError(
      "Namespace fork operation ledger contains an invalid base token.",
      { cause: error },
    );
  }
  if (typeof decodedBase !== "string") {
    throw new BranchError(
      "Namespace fork operation ledger contains an invalid base token.",
    );
  }
  return {
    graphId: row.graph_id,
    operationKey,
    sourceBase: decodedBase as BaseVersion,
    contentDigest: row.content_digest,
    copiedAt: row.copied_at,
  };
}

function targetStoreOptions<G extends GraphDef>(
  source: Store<G>,
): StoreOptions {
  const { recordedRead: _recordedRead, ...inherited } =
    source.workingCopyOptions;
  return { ...inherited, history: true };
}

async function assertRecordedAnchor<G extends GraphDef>(
  session: QuerySession,
  store: Store<G>,
  expectedBase: BaseVersion,
  message: string,
): Promise<void> {
  const [origin, revision, activeVersion] = await Promise.all([
    readRevisionOrigin(session, store.revisionSchema, store.graphId),
    readRecordedClock(session, store.revisionSchema, store.graphId),
    readActiveSchemaVersion(session, store.graphId),
  ]);
  if (
    origin !== revisionOriginOf(expectedBase) ||
    revision !== revisionAnchorOf(expectedBase) ||
    activeVersion !== schemaActiveVersionOf(expectedBase)
  ) {
    throw new BranchError(message);
  }
}

function namespaceForkResult<G extends GraphDef>(
  store: Store<G>,
  targetBackend: GraphBackend,
  proof: NamespaceForkProof,
): NamespaceFork<G> {
  return {
    store,
    proof,
    abort: async () => {
      await targetBackend.transaction(async (targetTx) => {
        const ledger = await queryRows<LedgerRow>(
          targetTx,
          sql`SELECT graph_id, source_base, content_digest, copied_at::text FROM typegraph_namespace_fork_operations WHERE operation_key = ${proof.operationKey} FOR UPDATE`,
        );
        if (ledger[0] === undefined) {
          await assertEmpty(targetTx, proof.graphId);
          return;
        }
        const ledgerProof = proofFromLedger(ledger[0], proof.operationKey);
        if (
          ledger[0].graph_id !== proof.graphId ||
          ledgerProof.sourceBase !== proof.sourceBase ||
          ledger[0].content_digest !== proof.contentDigest ||
          (await digestGraph(targetTx, proof.graphId)) !== proof.contentDigest
        ) {
          throw new BranchError(
            "Namespace fork abort found a changed target namespace.",
          );
        }
        const journal = "typegraph_revision_changes";
        for (const table of GRAPH_RELATIONS) {
          if (table === journal) continue;
          await queryRows(
            targetTx,
            sql`DELETE FROM ${sql.identifier(table)} WHERE graph_id = ${proof.graphId}`,
          );
        }
        await queryRows(
          targetTx,
          sql`DELETE FROM ${sql.identifier(journal)} WHERE graph_id = ${proof.graphId}`,
        );
        await queryRows(
          targetTx,
          sql`DELETE FROM typegraph_namespace_fork_operations WHERE operation_key = ${proof.operationKey}`,
        );
      });
    },
  };
}

async function assertIndependentDatabase(
  sourceTx: QuerySession,
  targetBackend: GraphBackend,
  graphId: string,
): Promise<void> {
  const aliasKey = crypto.randomUUID();
  await queryRows(
    sourceTx,
    sql`SELECT pg_advisory_xact_lock(hashtext(${graphId}), hashtext(${aliasKey}))`,
  );
  await targetBackend.transaction(async (targetTx) => {
    const aliasProbe = await queryRows<LockRow>(
      targetTx,
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${graphId}), hashtext(${aliasKey})) AS acquired`,
    );
    if (aliasProbe[0]?.acquired !== true) {
      throw new BranchError(
        "Namespace fork target connects to the source database; allocate an independent database.",
      );
    }
  });
}

/**
 * Copy one graph from a history-enabled Store to a pre-provisioned, private,
 * independent PostgreSQL backend. The backend must have the same bundled
 * TypeGraph schema and any graph indexes already provisioned. The operation
 * key is durable on the target: repeating it returns the original proof after
 * validating that the target still has exactly the copied content.
 *
 * The source may advance after the snapshot cut. The returned base token
 * identifies the copied cut, rather than imposing a write freeze on source.
 */
export async function forkGraphNamespace<G extends GraphDef>(
  source: Store<G>,
  targetBackend: GraphBackend,
  operationKey: string,
): Promise<NamespaceFork<G>> {
  if (operationKey.length === 0)
    throw new BranchError("Namespace fork operation key must be nonempty.");
  if (!source.historyEnabled || !source.revisionTrackingEnabled) {
    throw new BranchError(
      "Namespace fork requires a history-enabled source store with revision tracking.",
    );
  }
  // History captures through a derived write overlay. Its transaction scope
  // intentionally withholds raw SQL; this read-only snapshot uses the audited
  // root backend from which that overlay was derived.
  const sourceBackend = backendDerivationRoot(
    storeBackend(source),
  ) as GraphBackend;
  assertDefaultTables(sourceBackend);
  assertDefaultTables(targetBackend);
  assertDefaultNameMap(source.revisionSchema.tables);
  const targetStore = createStore(
    source.graph,
    targetBackend,
    targetStoreOptions(source),
  );
  if (sourceBackend === targetBackend)
    throw new BranchError(
      "Namespace fork target must be an independent backend.",
    );
  if (
    isBackendDerivedFrom(sourceBackend, targetBackend) ||
    isBackendDerivedFrom(targetBackend, sourceBackend) ||
    sharesSerializedTransactionResource(sourceBackend, targetBackend)
  ) {
    throw new BranchError(
      "Namespace fork source and target share one backend transaction resource.",
    );
  }
  // Run the physical alias probe before creating even the operation ledger.
  await sourceBackend.transaction(
    async (sourceTx) =>
      assertIndependentDatabase(sourceTx, targetBackend, source.graphId),
    { accessMode: "read_only" },
  );
  const executeDdl = targetBackend.executeDdl;
  if (executeDdl === undefined)
    throw new BranchError(
      "Namespace fork target must support operation-ledger provisioning.",
    );
  await executeDdl(`CREATE TABLE IF NOT EXISTS typegraph_namespace_fork_operations (
    operation_key text PRIMARY KEY, graph_id text NOT NULL, source_base text NOT NULL,
    content_digest text NOT NULL, copied_at timestamptz NOT NULL DEFAULT now())`);

  const existing = await queryRows<LedgerRow>(
    targetBackend,
    sql`SELECT graph_id, source_base, content_digest, copied_at::text FROM typegraph_namespace_fork_operations WHERE operation_key = ${operationKey}`,
  );
  if (existing[0] !== undefined) {
    const ledgerProof = await targetBackend.transaction(
      async (targetTx) => {
        const locked = await queryRows<LedgerRow>(
          targetTx,
          sql`SELECT graph_id, source_base, content_digest, copied_at::text FROM typegraph_namespace_fork_operations WHERE operation_key = ${operationKey} FOR UPDATE`,
        );
        const row = locked[0];
        if (row?.graph_id !== source.graphId)
          throw new BranchError(
            "Namespace fork operation key no longer belongs to this graph.",
          );
        const proof = proofFromLedger(row, operationKey);
        await assertRecordedAnchor(
          targetTx,
          targetStore,
          proof.sourceBase,
          "Namespace fork retry found an invalid source base token on target.",
        );
        if (
          (await digestGraph(targetTx, source.graphId)) !== proof.contentDigest
        )
          throw new BranchError(
            "Namespace fork retry found a changed target namespace.",
          );
        return proof;
      },
      { isolationLevel: "repeatable_read" },
    );
    const result = namespaceForkResult(targetStore, targetBackend, ledgerProof);
    return result;
  }

  // A pre-cut token detects a write that lands between stamping and the
  // repeatable-read snapshot. A write after the cut may proceed unhindered.
  const stampedBase = await computeBaseVersion(source);
  const proof = await sourceBackend.transaction(
    async (sourceTx) => {
      const isolation = await queryRows<IsolationRow>(
        sourceTx,
        sql`SHOW transaction_isolation`,
      );
      if (
        isolation[0]?.transaction_isolation !== "repeatable read" &&
        isolation[0]?.transaction_isolation !== "serializable"
      ) {
        throw new BranchError(
          "Namespace fork source transaction did not obtain repeatable-read isolation.",
        );
      }
      await assertRecordedAnchor(
        sourceTx,
        source,
        stampedBase,
        "Source advanced before the namespace fork snapshot; retry with the same operation key.",
      );
      await assertIndependentDatabase(sourceTx, targetBackend, source.graphId);
      return targetBackend.transaction(async (targetTx) => {
        await assertEmpty(targetTx, source.graphId);
        const sourceDigests: [string, string][] = [];
        for (const table of GRAPH_RELATIONS) {
          const rows = await graphRows(sourceTx, table, source.graphId);
          if (table === "typegraph_contribution_materializations")
            await assertSupportedContributions(sourceTx, rows);
          if (table === "typegraph_index_materializations")
            await assertPhysicalIndexes(targetTx, rows);
          sourceDigests.push([table, await digestRows(rows)]);
          if (table === "typegraph_revision_changes") {
            // Bundled node/edge INSERT triggers may journal the mechanical
            // copy. Replace only this private target graph's generated rows
            // with the source's exact recorded journal before validation.
            await queryRows(
              targetTx,
              sql`DELETE FROM ${sql.identifier(table)} WHERE graph_id = ${source.graphId}`,
            );
          }
          await insertRows(targetTx, table, rows);
        }
        const snapshotDigest = await sha256Hex(
          JSON.stringify(sourceDigests),
          32,
        );
        const targetDigest = await digestGraph(targetTx, source.graphId);
        if (targetDigest !== snapshotDigest)
          throw new BranchError(
            "Namespace fork target validation disagrees with the source snapshot.",
          );
        const copied = await queryRows<LedgerRow>(
          targetTx,
          sql`INSERT INTO typegraph_namespace_fork_operations (operation_key, graph_id, source_base, content_digest) VALUES (${operationKey}, ${source.graphId}, ${JSON.stringify(stampedBase)}, ${snapshotDigest}) RETURNING graph_id, source_base, content_digest, copied_at::text`,
        );
        const entry = copied[0];
        if (entry === undefined)
          throw new BranchError(
            "Namespace fork operation ledger did not return its proof.",
          );
        return proofFromLedger(entry, operationKey);
      });
    },
    { isolationLevel: "repeatable_read", accessMode: "read_only" },
  );

  // The in-snapshot token fence and complete row digest were checked before
  // target commit. No postcommit validation may turn a successful copy into
  // an error while leaving a populated private target behind.
  return namespaceForkResult(targetStore, targetBackend, proof);
}

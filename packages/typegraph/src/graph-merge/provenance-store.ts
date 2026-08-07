/**
 * Sidecar provenance graph — durable, queryable `{branch, sourceId}` → canonical
 * tagging for a merge (open-item #5: "on-graph provenance persistence").
 *
 * The merge's in-memory {@link import("./types").ProvenanceIndex}
 * (`report.provenance.byBranch`) evaporates after the call. This module persists the
 * same contributions as TYPED nodes in a SIDECAR graph on the SAME backend as the
 * merge target — a separate graph (its own `graphId`-namespaced tables), so the
 * user's domain schema is untouched. It is a faithful prototype of a future
 * first-class TypeGraph `annotations` primitive (see `docs/design/annotations.md`).
 *
 * Persistence is POST-COMMIT and best-effort, by design: the merge's commit path is
 * unchanged and stays on the same public store/backend contracts. Provenance is derived and
 * re-runnable, and the node ids are DETERMINISTIC (a hash of `{targetGraphId, role,
 * canonicalKind, canonicalId, branchId, sourceId}`), so re-merging the same forks UPSERTS rather
 * than duplicating. Atomic-in-the-merge-transaction is a possible upgrade later
 * (TypeGraph's cross-store `withTransaction`), deliberately deferred for v1.
 *
 * OWNERSHIP OF THE SIDECAR GRAPH ID. {@link openProvenanceStore} is the only
 * gateway, and it never writes to a graph id it has not established ownership of
 * ({@link inspectSidecarGraphId} decides BEFORE any modification):
 *
 *   - unregistered id: free ONLY when it carries no node and no edge row.
 *     A schema-less application graph (plain `createStore`, which registers no
 *     schema row) is still an application graph, so any pre-existing row refuses;
 *   - sidecar schema + live owner marker: owned, open it;
 *   - sidecar schema + NO owner marker: an INTERRUPTED CREATION/UPGRADE, resumed
 *     by writing the marker — but only when the id's durable contents are exactly
 *     what this module could have written and nothing else (see below);
 *   - pre-marker (legacy) schema: upgraded when every `Provenance` row verifies;
 *   - anything else: refused with `GRAPH_MERGE_PROVENANCE_ID_COLLISION` and a
 *     remediation naming the state that was actually found.
 *
 * WHY RESUMABILITY. Creation is two separately committed writes — the schema, then
 * the marker — so a crash (or a concurrent opener that has committed the schema but
 * not yet the marker) leaves schema-without-marker. Refusing that state forever
 * would brick the sidecar with no repair path and would report it as an application
 * graph, which it is not. The recognition predicate is therefore precise rather than
 * schema-shaped: schema-without-marker is resumed only when the graph id holds no
 * node row of any other kind, no edge row at all, and every `Provenance` row is
 * live, valid for THIS target, and stored under its recomputed deterministic id.
 * Zero rows (the crash-right-after-schema-registration state) trivially qualifies;
 * an application graph that copied the sidecar schema and holds its own data does
 * not, and is still refused. Adopting an EMPTY exact-schema application graph is
 * the accepted cost of that rule: it loses nothing, since the graph holds no rows.
 */

import { z } from "zod";

import { encodeTupleKey } from "../utils/tuple-key";
import { parseRowProps } from "./canonical-props";
import { compareStrings } from "./node-key";
import type { GraphBackend, GraphDef, Node, Store } from "./typegraph-internal";
import {
  asCompiledRowsSql,
  computeSchemaHash,
  ConfigurationError,
  createSqlSchema,
  createStoreWithSchema,
  defineInternalGraph,
  defineNode,
  serializeSchema,
  sha256Hex,
  sql,
  storeBackend,
} from "./typegraph-internal";
import { asBranchId, type BranchId, type ProvenanceRecord } from "./types";

/** The node kind holding one persisted contribution. */
const PROVENANCE_KIND = "Provenance";

/** The node kind holding the durable ownership marker. */
const PROVENANCE_OWNER_KIND = "ProvenanceOwner";

/** The Provenance node: one row per `{branch, sourceId}` → canonical contribution. */
const Provenance = defineNode(PROVENANCE_KIND, {
  schema: z.object({
    targetGraphId: z.string(),
    role: z.enum(["node", "edge"]),
    canonicalId: z.string(),
    canonicalKind: z.string(),
    branchId: z.string(),
    sourceId: z.string(),
  }),
});

const PROVENANCE_OWNER = "@nicia-ai/typegraph/merge-provenance";
const PROVENANCE_OWNER_VERSION = 1;
const PROVENANCE_OWNER_ID = "merge-provenance-owner";

/**
 * Durable ownership claim for the sidecar graph id.
 *
 * Schema equality cannot establish ownership: an application is allowed to
 * define the same `Provenance` kind at the conventional sidecar id. The marker
 * row is therefore required independently of the schema hash on every sidecar
 * created by this version.
 */
const ProvenanceOwner = defineNode(PROVENANCE_OWNER_KIND, {
  schema: z.object({
    owner: z.literal(PROVENANCE_OWNER),
    version: z.literal(PROVENANCE_OWNER_VERSION),
    targetGraphId: z.string(),
  }),
});

/**
 * Derives the sidecar graph id for a target graph. Suffixing the target's own id
 * keeps each target graph's provenance in its own `graphId`-namespaced tables on a
 * shared backend, while a single `Provenance` schema serves all of them.
 */
export function provenanceGraphId(targetGraphId: string): string {
  return `${targetGraphId}::merge-provenance`;
}

/** Builds the sidecar provenance graph definition for a target graph. */
function buildOwnedProvenanceGraph(targetGraphId: string) {
  return defineInternalGraph({
    id: provenanceGraphId(targetGraphId),
    nodes: {
      Provenance: { type: Provenance },
      ProvenanceOwner: { type: ProvenanceOwner },
    },
    edges: {},
  });
}

/** The schema written by releases before durable sidecar ownership markers. */
function buildProvenanceGraph(targetGraphId: string) {
  return defineInternalGraph({
    id: provenanceGraphId(targetGraphId),
    nodes: { Provenance: { type: Provenance } },
    edges: {},
  });
}

/**
 * Public view of the sidecar graph. The ownership kind is deliberately hidden:
 * it is framework metadata, not provenance data or an application collection.
 */
export type ProvenanceGraph = ReturnType<typeof buildProvenanceGraph>;

/** A persisted provenance node (the queryable record). */
export type ProvenanceNode = Node<typeof Provenance>;

/**
 * Opens — materializing the schema if needed — the provenance store for a target.
 * Pass the target Store in ordinary application code; inspection tools that do
 * not have its GraphDef may instead pass the backend and target graph id.
 *
 * Idempotent: safe to call before every persist/query, and shares the backend
 * with the target (so the caller must NOT close it separately — closing the
 * shared backend is the target owner's job).
 */
export function openProvenanceStore<G extends GraphDef>(
  target: Store<G>,
): Promise<Store<ProvenanceGraph>>;
/** Opens a provenance store for standalone inspection without a target GraphDef. */
export function openProvenanceStore(
  backend: GraphBackend,
  targetGraphId: string,
): Promise<Store<ProvenanceGraph>>;
export async function openProvenanceStore<G extends GraphDef>(
  ...args:
    | readonly [target: Store<G>]
    | readonly [backend: GraphBackend, targetGraphId: string]
): Promise<Store<ProvenanceGraph>> {
  const [backend, targetGraphId] =
    args.length === 1 ? [storeBackend(args[0]), args[0].graphId] : args;
  const graph = buildOwnedProvenanceGraph(targetGraphId);
  const disposition = await inspectSidecarGraphId(
    backend,
    graph,
    targetGraphId,
  );
  if (disposition.state === "refuse") {
    throw provenanceGraphIdCollision(
      graph.id,
      targetGraphId,
      disposition.reason,
    );
  }
  const [store] = await createStoreWithSchema(graph, backend);
  if (disposition.state !== "owned") {
    await store.nodes.ProvenanceOwner.upsertById(PROVENANCE_OWNER_ID, {
      owner: PROVENANCE_OWNER,
      version: PROVENANCE_OWNER_VERSION,
      targetGraphId,
    });
  }
  return store as unknown as Store<ProvenanceGraph>;
}

/**
 * The distinguishable states a refusal can name. Callers branch on the stable
 * `GRAPH_MERGE_PROVENANCE_ID_COLLISION` code; the reason (and the remediation
 * derived from it) says WHICH occupant was found, because "rename the colliding
 * application graph" is wrong advice for a sidecar this module itself wrote.
 */
type SidecarRefusalReason =
  | "application-graph"
  | "empty-legacy-sidecar"
  | "unupgradeable-legacy-sidecar"
  | "unowned-exact-schema-graph";

/** What {@link openProvenanceStore} may do with the sidecar graph id. */
type SidecarDisposition =
  | Readonly<{ state: "create" }>
  | Readonly<{ state: "owned" }>
  | Readonly<{ state: "adopt" }>
  | Readonly<{ state: "refuse"; reason: SidecarRefusalReason }>;

/** Rows this module could have written, keyed by what they mean for ownership. */
type SidecarContents =
  "empty" | "provenance" | "unrecognized-provenance" | "foreign-rows";

/**
 * Decides — WITHOUT writing anything — whether the sidecar graph id is this
 * module's to open. The module doc states the rule this implements.
 */
async function inspectSidecarGraphId(
  backend: GraphBackend,
  graph: ReturnType<typeof buildOwnedProvenanceGraph>,
  targetGraphId: string,
): Promise<SidecarDisposition> {
  const activeSchema = await backend.getActiveSchema(graph.id);
  if (activeSchema === undefined) {
    // An unregistered graph id is NOT evidence of a free namespace: a store
    // booted with plain `createStore` writes rows and registers no schema row.
    // Probe the durable rows before claiming the id.
    return (await hasRowsUnderGraphId(backend, graph.id, "any")) ?
        { state: "refuse", reason: "application-graph" }
      : { state: "create" };
  }

  const ownedHash = await computeSchemaHash(
    serializeSchema(graph, activeSchema.version),
  );
  if (activeSchema.schema_hash === ownedHash) {
    if (await hasProvenanceOwnerMarker(backend, graph.id, targetGraphId)) {
      return { state: "owned" };
    }
    // Schema committed, marker not (yet): an interrupted creation/upgrade, or a
    // concurrent opener between its two writes. Resume only if the contents are
    // ours-or-nothing.
    return OWNED_SCHEMA_DISPOSITION[
      await inspectSidecarContents(backend, graph.id, targetGraphId)
    ];
  }

  const legacyHash = await computeSchemaHash(
    serializeSchema(buildProvenanceGraph(targetGraphId), activeSchema.version),
  );
  if (activeSchema.schema_hash !== legacyHash) {
    return { state: "refuse", reason: "application-graph" };
  }
  return LEGACY_SCHEMA_DISPOSITION[
    await inspectSidecarContents(backend, graph.id, targetGraphId)
  ];
}

/**
 * Contents → disposition for a graph id carrying the CURRENT sidecar schema
 * without an ownership marker (an interrupted creation/upgrade). `empty` adopts:
 * a crash right after schema registration leaves exactly that, and adopting it
 * loses nothing because the id holds no rows.
 */
const OWNED_SCHEMA_DISPOSITION: Readonly<
  Record<SidecarContents, SidecarDisposition>
> = {
  provenance: { state: "adopt" },
  empty: { state: "adopt" },
  "unrecognized-provenance": {
    state: "refuse",
    reason: "unowned-exact-schema-graph",
  },
  "foreign-rows": { state: "refuse", reason: "application-graph" },
};

/**
 * Contents → disposition for a graph id carrying the PRE-MARKER (legacy) schema.
 * `empty` refuses here — unlike the owned-schema case, an empty legacy sidecar
 * carries no evidence at all that this module wrote it, so it cannot be told
 * apart from an application graph of the same shape.
 */
const LEGACY_SCHEMA_DISPOSITION: Readonly<
  Record<SidecarContents, SidecarDisposition>
> = {
  provenance: { state: "adopt" },
  empty: { state: "refuse", reason: "empty-legacy-sidecar" },
  "unrecognized-provenance": {
    state: "refuse",
    reason: "unupgradeable-legacy-sidecar",
  },
  "foreign-rows": { state: "refuse", reason: "application-graph" },
};

/** The refusal message and remediation for each distinguishable state. */
const SIDECAR_REFUSALS: Readonly<
  Record<
    SidecarRefusalReason,
    Readonly<{
      describe: (graphId: string, targetGraphId: string) => string;
      suggestion: (graphId: string) => string;
    }>
  >
> = {
  "application-graph": {
    describe: (graphId) =>
      `Graph id "${graphId}" is already used by an application graph and cannot host merge provenance.`,
    suggestion: () =>
      "Rename the colliding application graph before enabling persisted merge provenance for this target.",
  },
  "empty-legacy-sidecar": {
    describe: (graphId) =>
      `Graph id "${graphId}" holds an EMPTY provenance sidecar from a release that wrote no ownership marker, which cannot be told apart from an application graph of the same shape.`,
    suggestion: (graphId) =>
      `Drop graph id "${graphId}" — it holds no provenance records, so nothing is lost — and re-run the merge to create an owned sidecar.`,
  },
  "unupgradeable-legacy-sidecar": {
    describe: (graphId, targetGraphId) =>
      `Graph id "${graphId}" holds a pre-marker provenance sidecar whose rows do not verify as provenance for target "${targetGraphId}", so it cannot be upgraded to an owned sidecar.`,
    suggestion: (graphId) =>
      `Export anything you still need from graph id "${graphId}", then drop it: provenance is derived, and re-running the merge rebuilds an owned sidecar.`,
  },
  "unowned-exact-schema-graph": {
    describe: (graphId) =>
      `Graph id "${graphId}" carries the merge-provenance schema without an ownership marker and holds rows this library did not write.`,
    suggestion: (graphId) =>
      `Rename or drop the graph at id "${graphId}"; a sidecar this library owns carries a "${PROVENANCE_OWNER}" marker row, and one written by an application is never adopted.`,
  },
};

function provenanceGraphIdCollision(
  graphId: string,
  targetGraphId: string,
  reason: SidecarRefusalReason,
): ConfigurationError {
  const refusal = SIDECAR_REFUSALS[reason];
  return new ConfigurationError(
    refusal.describe(graphId, targetGraphId),
    {
      code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
      reason,
      graphId,
      targetGraphId,
    },
    { suggestion: refusal.suggestion(graphId) },
  );
}

async function hasProvenanceOwnerMarker(
  backend: GraphBackend,
  graphId: string,
  targetGraphId: string,
): Promise<boolean> {
  const row = await backend.getNode(
    graphId,
    PROVENANCE_OWNER_KIND,
    PROVENANCE_OWNER_ID,
  );
  if (row === undefined || row.deleted_at !== undefined) return false;
  const parsed = ProvenanceOwner.schema.safeParse(parseRowProps(row.props));
  return parsed.success && parsed.data.targetGraphId === targetGraphId;
}

/** One probe row: the SELECT projects a constant, so only its presence matters. */
type SidecarProbeRow = Readonly<{ present: number }>;

/**
 * Cheapest existence probe a backend offers for "does this graph id hold rows?":
 * one `LIMIT 1` lookup per row table, on the same `graph_id` prefix every read
 * path uses. Tombstoned rows COUNT — a soft-deleted application row still means
 * the id belongs to that application.
 *
 * `scope: "foreign"` narrows it to rows this module could not have written: node
 * rows of any other kind, plus any edge row at all (the sidecar graph declares no
 * edges). It cannot be expressed through `findNodesByKind`, which needs the kinds
 * of a graph whose schema — by construction, in the case that matters — was never
 * registered.
 */
async function hasRowsUnderGraphId(
  backend: GraphBackend,
  graphId: string,
  scope: "any" | "foreign",
): Promise<boolean> {
  const schema = createSqlSchema(backend.tableNames);
  const kindFilter =
    scope === "any" ?
      sql.empty()
    : sql` AND kind <> ${PROVENANCE_KIND} AND kind <> ${PROVENANCE_OWNER_KIND}`;
  const nodeRows = await backend.execute<SidecarProbeRow>(
    asCompiledRowsSql(
      sql`SELECT 1 AS present FROM ${schema.nodesTable} WHERE graph_id = ${graphId}${kindFilter} LIMIT 1`,
    ),
  );
  if (nodeRows.length > 0) return true;
  const edgeRows = await backend.execute<SidecarProbeRow>(
    asCompiledRowsSql(
      sql`SELECT 1 AS present FROM ${schema.edgesTable} WHERE graph_id = ${graphId} LIMIT 1`,
    ),
  );
  return edgeRows.length > 0;
}

/**
 * Classifies a sidecar-shaped graph id by its actual durable contents.
 *
 * `provenance` is claimed only when every row is a live, valid contribution for
 * THIS target stored under its recomputed deterministic id, and the id holds no
 * other row. That single predicate serves both admission paths — upgrading a
 * pre-marker sidecar and resuming an interrupted creation — so the two can never
 * drift into disagreeing about what "our rows" means.
 */
async function inspectSidecarContents(
  backend: GraphBackend,
  graphId: string,
  targetGraphId: string,
): Promise<SidecarContents> {
  if (await hasRowsUnderGraphId(backend, graphId, "foreign")) {
    return "foreign-rows";
  }

  const pageSize = 500;
  let after: string | undefined;
  let rowCount = 0;

  for (;;) {
    const rows = await backend.findNodesByKind({
      graphId,
      kind: PROVENANCE_KIND,
      temporalMode: "includeTombstones",
      excludeDeleted: false,
      orderBy: "id",
      ...(after === undefined ? {} : { after }),
      limit: pageSize,
    });
    for (const row of rows) {
      if (row.deleted_at !== undefined) return "unrecognized-provenance";
      const parsed = Provenance.schema.safeParse(parseRowProps(row.props));
      if (!parsed.success || parsed.data.targetGraphId !== targetGraphId) {
        return "unrecognized-provenance";
      }
      const expectedId = await provenanceNodeId(targetGraphId, {
        role: parsed.data.role,
        canonicalId: parsed.data.canonicalId,
        canonicalKind: parsed.data.canonicalKind,
        branchId: asBranchId(parsed.data.branchId),
        sourceId: parsed.data.sourceId,
      });
      if (row.id !== expectedId) return "unrecognized-provenance";
      rowCount += 1;
    }
    if (rows.length < pageSize) break;
    after = rows.at(-1)?.id;
    if (after === undefined) break;
  }

  return rowCount > 0 ? "provenance" : "empty";
}

/** Separator used by provenance ids written before tuple escaping was added. */
const ID_SEPARATOR = "\0";

/** Bytes of the SHA-256 digest kept (128 bits — collision-safe for provenance). */
const ID_DIGEST_BYTES = 16;

/**
 * The tuple that IDENTIFIES a contribution: everything {@link provenanceNodeId}
 * hashes except the target graph id, which is fixed for one merge. Two records
 * agreeing on it are one sidecar row by definition, so a caller that collapses on
 * this key collapses exactly what the row identity would have collapsed —
 * `canonicalKind` is part of it because two same-id canonicals of different kinds
 * are different entities under the `(kind, id)` identity model.
 */
export function contributionKey(record: ProvenanceRecord): string {
  return encodeProvenanceTuple([
    record.role,
    record.canonicalKind,
    record.canonicalId,
    record.branchId,
    record.sourceId,
  ]);
}

/**
 * Preserves existing provenance ids for ordinary values while making the full
 * string domain injective. JSON tuple output never contains a literal NUL, so
 * it cannot collide with the legacy form, which has one between every field.
 */
function encodeProvenanceTuple(values: readonly string[]): string {
  return values.some((value) => value.includes(ID_SEPARATOR)) ?
      encodeTupleKey(values)
    : values.join(ID_SEPARATOR);
}

/**
 * Deterministic provenance node id: a hash of the contribution tuple, so
 * re-persisting the same contribution UPSERTS the same row (idempotent re-runs).
 *
 * Uses the shared {@link sha256Hex} (Web Crypto) instead of `node:crypto` so the
 * `graph-merge` entry point stays importable on every runtime the library
 * targets (Cloudflare Workers, Deno, browsers) — `base-version.ts` already hashes
 * its content fingerprint the same way.
 */
export async function provenanceNodeId(
  targetGraphId: string,
  record: ProvenanceRecord,
): Promise<string> {
  const tuple = encodeProvenanceTuple([
    targetGraphId,
    record.role,
    record.canonicalKind,
    record.canonicalId,
    record.branchId,
    record.sourceId,
  ]);
  const digest = await sha256Hex(tuple, ID_DIGEST_BYTES);
  return `prov_${digest}`;
}

/**
 * Upserts one `Provenance` node per record into the sidecar store, keyed by the
 * deterministic id (re-running the same merge is a no-op upsert, never a
 * duplicate). Returns the row count written. The caller wraps this for best-effort
 * behavior — a failure here must not fail an already-committed merge.
 *
 * Records that hash to the SAME id are collapsed before the batch: the id is the
 * contribution's identity, so they are one row by definition — and a single
 * `bulkUpsertById` batch cannot create the same id twice. Collapsing here is what
 * makes the returned number the rows actually written for ANY caller, whatever
 * shape its record list arrived in.
 */
export async function persistProvenanceRecords(
  store: Store<ProvenanceGraph>,
  targetGraphId: string,
  records: readonly ProvenanceRecord[],
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }
  const identified = await Promise.all(
    records.map(async (record) => ({
      id: await provenanceNodeId(targetGraphId, record),
      props: {
        targetGraphId,
        role: record.role,
        canonicalId: record.canonicalId,
        canonicalKind: record.canonicalKind,
        branchId: record.branchId,
        sourceId: record.sourceId,
      },
    })),
  );
  const itemsById = new Map<string, (typeof identified)[number]>();
  for (const item of identified) {
    itemsById.set(item.id, item);
  }
  const items = [...itemsById.values()];
  await store.nodes.Provenance.bulkUpsertById(items);
  return items.length;
}

/** Filter for {@link readProvenance}. Each field, when set, narrows the result. */
export type ProvenanceQuery = Readonly<{
  branchId?: BranchId | string;
  canonicalId?: string;
  role?: "node" | "edge";
}>;

/**
 * Reads persisted provenance back, filtered and stably ordered. The sidecar is a
 * normal typed graph, so this is a thin ergonomic wrapper over
 * `store.nodes.Provenance.find()` (filtered in memory — provenance volumes are
 * modest; a query-builder `where` is the scale path). Answers "which canonical
 * entities did branch X contribute to?" and "who contributed canonical Y?".
 */
export async function readProvenance(
  store: Store<ProvenanceGraph>,
  query: ProvenanceQuery = {},
): Promise<readonly ProvenanceNode[]> {
  const all = await store.nodes.Provenance.find();
  return all
    .filter(
      (node) =>
        (query.branchId === undefined || node.branchId === query.branchId) &&
        (query.canonicalId === undefined ||
          node.canonicalId === query.canonicalId) &&
        (query.role === undefined || node.role === query.role),
    )
    .sort((left, right) => compareStrings(left.id, right.id));
}

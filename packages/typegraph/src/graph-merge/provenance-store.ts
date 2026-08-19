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
 * gateway, and the OWNERSHIP MARKER — not the schema shape — is the boundary.
 * One invariant states the whole rule: no write of any kind ever lands on a graph
 * id this module has not ALREADY marked as its own, and an open that refuses
 * writes nothing at all.
 *
 * {@link inspectSidecarGraphId} decides what may be done with an id:
 *
 *   - a VALID live owner marker for this target: OWNED — open it, registering (or
 *     migrating) the sidecar schema if that write has not landed yet;
 *   - ANY other `ProvenanceOwner`-kind row — tombstoned, schema-invalid, claiming a
 *     different target, or stored under a different id: foreign occupancy, refused
 *     with `corrupt-ownership-marker`. A marker this module cannot verify is never
 *     overwritten or resurrected;
 *   - unregistered id: FREE, and claimable, ONLY when it carries no row in ANY
 *     per-graph table — nodes and edges, but equally recorded-time history, the
 *     revision clock and origins, identity assertions and their derived
 *     closure/separation, fulltext, and unique keys. A schema-less application
 *     graph (plain `createStore`, which registers no schema row) is still an
 *     application graph, so any pre-existing row refuses;
 *   - the CURRENT sidecar schema with NO marker: refused
 *     (`unowned-exact-schema-graph`) whatever its contents — empty and
 *     provenance-shaped included (see below);
 *   - pre-marker (legacy) schema: upgraded when every `Provenance` row verifies as
 *     one this module wrote for THIS target, refused otherwise;
 *   - anything else: refused with `GRAPH_MERGE_PROVENANCE_ID_COLLISION` and a
 *     remediation naming the state that was actually found.
 *
 * MARKER-FIRST ORDERING. Claiming the id is the FIRST write of an open, and it
 * happens BEFORE the sidecar schema is registered. That is possible because the
 * marker is a plain node row in the shared nodes table, which needs no per-graph
 * schema DDL — the same way a schema-less `createStore` graph writes rows. The
 * claim ({@link claimSidecarOwnership}) re-verifies the id and inserts the marker
 * as ONE fenced unit (`backend.schemaWriteTransaction`). What that fence is worth
 * differs by engine and by state, so be precise about it:
 *
 *   - SQLite: `BEGIN IMMEDIATE` owns the single writer slot, so it serializes the
 *     claim against EVERY other writer, whatever the id's state;
 *   - PostgreSQL: a per-graph `pg_advisory_xact_lock` plus `SELECT ... FOR UPDATE`
 *     on the graph's ACTIVE SCHEMA ROW. On the marker-first free-id path there is
 *     no such row yet, so the `FOR UPDATE` locks nothing and the advisory lock is
 *     the whole fence: it serializes this claim against other claims and against
 *     schema commits (which take the same lock), which is what makes two racing
 *     openers safe. The row lock earns its keep on the schema-BEARING states — the
 *     legacy upgrade, and any schema-managed Store write, which takes that row
 *     `FOR SHARE`. Writers that take NEITHER — raw, schema-less ones — are
 *     excluded by the claim's own relation lock (see below).
 *
 * So a competing writer of those classes either commits first — and this claim
 * then SEES its row and refuses, having written nothing — or waits until the claim
 * has committed, by which time the id is visibly owned and a later application
 * write makes that application the intruder in a marked graph rather than making
 * this module the colonizer of an application's graph. Only after the marker
 * commits does `createStoreWithSchema` register the schema.
 *
 * WHY AN UNMARKED CURRENT-SCHEMA ID IS NEVER ADOPTED. Contents cannot establish
 * ownership: an application may legitimately define these exact kinds at the
 * conventional sidecar id, and one that is empty (or holds rows that happen to
 * recompute) is indistinguishable from a sidecar of ours. Adopting it used to be
 * defended by the claim's fence, but the fence only orders the claim against
 * writers that contend for it — an application Store already open on that id keeps
 * writing afterwards, and once the marker exists no later open re-litigates
 * contents. Marker-first removes the question: the current schema without a marker
 * is a state this module cannot produce except by crashing between the marker
 * commit and the schema commit, which leaves the marker, not the schema. It is
 * therefore refused unconditionally, and — because 0.46 is unreleased — no
 * legitimate fleet state carries the current sidecar schema without a marker.
 *
 * RESUMABILITY. Creation is still two separately committed writes, but in the safe
 * order: the marker, then the schema. A crash between them leaves
 * marker-without-schema, and a valid live marker for this target IS the proof of
 * ownership, so that state resumes by registering the schema. The legacy upgrade
 * has the same window: the marker is claimed inside the fence that verified every
 * pre-marker row, and the migration to the current schema runs afterwards.
 *
 * NO RESIDUE. A refused open leaves the occupant byte-identical: no schema row, no
 * marker, no provenance row. The unfenced preflight is a read-only classification —
 * it decides whether a fence must be opened at all (an already-owned sidecar needs
 * no claim), never whether a write is allowed; every decision that admits a write
 * is re-taken inside the fence.
 *
 * THE UNFENCED-WRITER WINDOW, AND HOW IT IS CLOSED. One writer class takes
 * neither the advisory lock nor the schema row: a schema-LESS raw `createStore`
 * writer, or a direct `backend.insertNode`/`insertEdge` call. At PostgreSQL's read
 * committed its insert could commit between the claim's fenced re-inspection and
 * the claim's commit, and the claim would mark a graph id it saw empty and an
 * application saw as its own. That window is CLOSED, not accepted: the claim takes
 * `LOCK TABLE <nodes>, <edges> IN SHARE ROW EXCLUSIVE MODE` inside the fence and
 * before the re-inspection, which drains in-flight row writers and holds new ones
 * off until the marker commits. {@link drainUnfencedRowWriters} states the mode
 * choice, the deadlock analysis, and the cost — every node/edge write on the
 * database waits for the duration of a claim, which happens only when a sidecar is
 * created, upgraded, or resumed. SQLite needs no such lock: `BEGIN IMMEDIATE` owns
 * the single writer slot.
 *
 * What remains is narrower and is stated as a residual rather than closed: a
 * writer that inserts ONLY into a secondary per-graph relation — identity
 * assertions, the revision clock, recorded history — under this id, with no node
 * or edge row in the same transaction and no schema of its own. No TypeGraph write
 * path does that: those relations are written either atomically with the node or
 * edge row that produced them (drained by the table lock), or by a schema-managed
 * or identity-enabled store, which must first register a schema for this id
 * through the same per-graph advisory lock this claim holds. Reaching it means an
 * application writing TypeGraph's internal tables by hand. If it were reached, the
 * failure is a visible NAMESPACE COLLISION — an application's rows and this
 * module's marker under one graph id — not corruption: no row is overwritten, no
 * row is lost, and both sides read their own rows back unchanged. It is also the
 * accepted marker-boundary semantics one instant early: an application writing
 * into the sidecar AFTER the claim commits is already documented as "the
 * application is the intruder in a marked graph".
 *
 * The claim needs a transactional schema fence. A backend that exposes none is
 * refused with `GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED` rather than claiming the id
 * with a check-then-write that a concurrent writer can slip through. Opening an
 * ALREADY-owned sidecar needs no claim, so read-only use of an existing sidecar
 * stays available on such a backend.
 */

import { z } from "zod";

import { encodeTupleKey } from "../utils/tuple-key";
import { parseRowProps } from "./canonical-props";
import { compareStrings } from "./node-key";
import type {
  GraphBackend,
  GraphDef,
  Node,
  NodeRow,
  Store,
} from "./typegraph-internal";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
  computeSchemaHash,
  ConfigurationError,
  createSqlSchema,
  createStoreWithSchema,
  defineInternalGraph,
  defineNode,
  requireWriteFence,
  resolveWriteFencePlan,
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
 * Opens the provenance store for a target — OPENING OR CREATING, never merely
 * reading. On a free graph id this claims the ownership marker and registers the
 * sidecar schema; on an occupied one it throws. There is no read-only entry
 * point: a tool that wants to inspect an existing sidecar without creating one
 * must decide for itself (e.g. by checking `backend.getActiveSchema` for
 * {@link provenanceGraphId}) before calling this.
 *
 * Pass the target Store in ordinary application code; callers that do not have
 * its GraphDef may instead pass the backend and target graph id.
 *
 * Idempotent in the sense that matters for the persist/query path: repeated calls
 * converge on one sidecar and write no second marker. It shares the backend with
 * the target, so the caller must NOT close it separately — closing the shared
 * backend is the target owner's job.
 */
export function openProvenanceStore<G extends GraphDef>(
  target: Store<G>,
): Promise<Store<ProvenanceGraph>>;
/**
 * Opens (or creates — see above) a provenance store without a target GraphDef,
 * for callers that hold only the backend and the target's graph id.
 */
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
  // Preflight, unfenced and read-only: it decides whether a CLAIM is needed at
  // all (an already-owned sidecar needs none, so read-only use stays available
  // on a backend with no schema fence) and refuses early. It authorizes no
  // write — the claim below re-takes the decision inside its fence.
  const preflight = await inspectSidecarGraphId(backend, graph, targetGraphId);
  if (preflight.state === "refuse") {
    throw provenanceGraphIdCollision(graph.id, targetGraphId, preflight.reason);
  }
  if (preflight.state !== "owned") {
    // Marker-first: the ownership row is this open's FIRST write, so a lost race
    // refuses before anything — not even a schema-version row — has been written
    // to the occupant.
    const claim = await claimSidecarOwnership(backend, graph, targetGraphId);
    if (claim.state === "refuse") {
      throw provenanceGraphIdCollision(graph.id, targetGraphId, claim.reason);
    }
  }
  // Reached only once the marker owns the id: registering the sidecar schema (or
  // migrating a pre-marker one) now writes into a graph this module has claimed.
  const [store] = await createStoreWithSchema(graph, backend);
  return store as unknown as Store<ProvenanceGraph>;
}

/**
 * Re-verifies the sidecar id and writes the ownership marker as ONE fenced unit,
 * so no writer can occupy the id between the two — and, being the open's first
 * write, so a claim that loses the race leaves the occupant untouched.
 *
 * `backend.schemaWriteTransaction` is the fence: the same per-graph lock a schema
 * commit holds (SQLite `BEGIN IMMEDIATE`; PostgreSQL `pg_advisory_xact_lock` plus
 * `SELECT ... FOR UPDATE` on the graph's active schema row, which every
 * schema-managed Store write takes `FOR SHARE`). It BLOCKS a competing writer
 * rather than aborting on a serialization failure, so no retry loop is needed.
 *
 * The marker is written with the backend's `insertNode` primitive rather than
 * `store.nodes.ProvenanceOwner.upsertById`: a Store write opens its own
 * transaction and cannot join this one. An INSERT is also the only write this
 * claim is ever allowed to make — the marker is claimed only when the id holds no
 * `ProvenanceOwner` row at all, so an unverifiable marker can never be overwritten
 * or resurrected. `ProvenanceOwner` declares no unique field, embedding, or
 * fulltext projection, so the row a Store write would produce is this row — and,
 * being a plain row in the shared nodes table, it needs no registered schema for
 * the graph id, which is what lets the claim run BEFORE the schema commit.
 */
async function claimSidecarOwnership(
  backend: GraphBackend,
  graph: ReturnType<typeof buildOwnedProvenanceGraph>,
  targetGraphId: string,
): Promise<SidecarDisposition> {
  const fence = backend.schemaWriteTransaction;
  if (fence === undefined) {
    throw provenanceClaimUnfenced(graph.id, targetGraphId);
  }
  return fence(graph.id, async (tx) => {
    // Before the re-inspection, not after it: the drain is only worth anything
    // if no row can land between the read it authorizes and this transaction's
    // commit.
    await drainUnfencedRowWriters(tx);
    const verdict = await inspectSidecarGraphId(tx, graph, targetGraphId);
    // `owned`: a concurrent opener claimed the id first. Nothing to write, and
    // its marker is the same durable claim this one would have made.
    if (verdict.state === "refuse" || verdict.state === "owned") return verdict;
    await tx.insertNode({
      graphId: graph.id,
      kind: PROVENANCE_OWNER_KIND,
      id: PROVENANCE_OWNER_ID,
      props: {
        owner: PROVENANCE_OWNER,
        version: PROVENANCE_OWNER_VERSION,
        targetGraphId,
      },
    });
    return verdict;
  });
}

/**
 * The claim's own port: the fenced transaction, plus the two members the drain
 * needs beyond the inspection reads.
 */
type SidecarClaimPort = SidecarInspectionPort &
  Readonly<{
    capabilities: GraphBackend["capabilities"];
    dialect: GraphBackend["dialect"];
    executeStatement: NonNullable<GraphBackend["executeStatement"]>;
  }>;

/**
 * Drains — and holds off — the writers the per-graph fence cannot reach, so the
 * claim's re-inspection reads a state no one can change until it commits.
 *
 * The fence excludes every writer that takes the per-graph advisory lock (other
 * claims, schema commits) or the active schema row (`FOR SHARE` on every
 * schema-managed Store write). One class takes neither: a schema-LESS raw
 * `createStore` writer, or a direct `backend.insertNode`/`insertEdge` call. At
 * PostgreSQL's read committed its INSERT can commit between the re-inspection's
 * statement snapshot and this transaction's commit, and the claim would then
 * mark a graph id it saw empty and an application saw as its own.
 *
 * A relation lock is the expressible exclusion for "no row may appear", and this
 * module takes it — the same advisory-then-relation ordering the contribution
 * teardown uses, and the same reasoning as the identity enablement snapshot's
 * `LOCK TABLE ... IN SHARE MODE`: a verdict computed from the absence of rows is
 * only sound if nothing can add one while it is acted on.
 *
 * `SHARE ROW EXCLUSIVE` is the minimal mode that works here, and the mode choice
 * is load-bearing:
 *
 *   - it conflicts with `ROW EXCLUSIVE`, so it excludes every INSERT/UPDATE/DELETE
 *     on these two tables (for EVERY graph — the tables are shared);
 *   - it is SELF-exclusive, which plain `SHARE` is not. `SHARE` would let two
 *     concurrent claims (different sidecar ids, different advisory locks) both
 *     acquire it and then both request `ROW EXCLUSIVE` for their own marker
 *     INSERT — each blocked by the other's `SHARE`. That is a textbook
 *     lock-upgrade deadlock, and PostgreSQL would resolve it by aborting one
 *     claim. Under this mode the second claim waits at the lock, holding nothing
 *     the first needs;
 *   - it still admits readers (`ACCESS SHARE`) and row-level lockers
 *     (`ROW SHARE`), which `EXCLUSIVE` would block for no benefit here.
 *
 * COST, stated plainly, because it is real: while this transaction runs, every
 * node and edge write on the whole database waits. The bound is what makes it
 * acceptable — the lock is taken ONLY inside the claim, so only when a sidecar is
 * created, upgraded from the pre-marker schema, or resumed after a crash; never
 * on the common path, where an already-owned sidecar opens without a fence at
 * all. Its duration is the re-inspection's probes plus one INSERT, with no user
 * code and no I/O of the caller's inside it.
 *
 * DEADLOCK ANALYSIS, by writer class — the wait graph stays acyclic in each:
 *
 *   - a raw, schema-less writer takes `ROW EXCLUSIVE` here and nothing else, so
 *     the wait is one-directional (this claim waits for it; it never waits for
 *     anything this claim holds);
 *   - a schema-MANAGED writer also takes the graph's active schema row
 *     `FOR SHARE`, which this fence holds `FOR UPDATE` — but it takes that row
 *     lock FIRST, as the opening statement of its write transaction
 *     (`lockSchemaVersionForStoreWrite`, run before any row write precisely so a
 *     rolled-back savepoint cannot drop the fence). It therefore can never be
 *     holding `ROW EXCLUSIVE` on these tables while waiting on the schema row,
 *     which is the only shape that would close a cycle;
 *   - a fence holder for ANOTHER graph id can hold `ROW EXCLUSIVE` here while
 *     this claim waits, but it never requests another graph's advisory lock;
 *   - another CLAIM is excluded by this mode's self-exclusivity before it holds
 *     anything (see above), which is the case a plain `SHARE` would deadlock.
 *
 * SQLITE takes no lock: `BEGIN IMMEDIATE` — which every fence transaction here is
 * opened with — already owns the engine's single writer slot, so the drain is
 * complete before the callback runs. Unlike the identity path, this fence is
 * always one TypeGraph opened itself, never one adopted from a caller's
 * `DEFERRED` transaction, so that premise holds unconditionally.
 *
 * Resolves a {@link resolveWriteFencePlan}: the `lock` arm takes the relation
 * lock below (needs `tableLocks`), and the `engine-serialized` arm is the
 * SQLite writer-slot case this doc already describes.
 */
async function drainUnfencedRowWriters(tx: SidecarClaimPort): Promise<void> {
  const plan = resolveWriteFencePlan(tx);
  const fence = requireWriteFence(
    plan,
    "graph-merge provenance fence",
    "table-lock",
  );
  switch (fence.kind) {
    case "lock": {
      const schema = createSqlSchema(tx.tableNames);
      await tx.executeStatement(
        asCompiledStatementSql(
          sql`LOCK TABLE ${schema.nodesTable}, ${schema.edgesTable} IN SHARE ROW EXCLUSIVE MODE`,
        ),
      );
      return;
    }
    case "engine-serialized": {
      return;
    }
    default: {
      fence satisfies never;
    }
  }
}

/**
 * The distinguishable states a refusal can name. Callers branch on the stable
 * `GRAPH_MERGE_PROVENANCE_ID_COLLISION` code; the reason (and the remediation
 * derived from it) says WHICH occupant was found, because "rename the colliding
 * application graph" is wrong advice for a sidecar this module itself wrote.
 */
type SidecarRefusalReason =
  | "application-graph"
  | "corrupt-ownership-marker"
  | "empty-legacy-sidecar"
  | "unupgradeable-legacy-sidecar"
  | "unowned-exact-schema-graph";

/**
 * What {@link openProvenanceStore} may do with the sidecar graph id. `create`
 * (a completely free id) and `upgrade` (a pre-marker sidecar whose every row
 * verifies) are the two states a claim may write the marker in; `owned` needs no
 * claim, and `refuse` permits no write at all.
 */
type SidecarDisposition =
  | Readonly<{ state: "create" }>
  | Readonly<{ state: "owned" }>
  | Readonly<{ state: "upgrade" }>
  | Readonly<{ state: "refuse"; reason: SidecarRefusalReason }>;

/** Rows this module could have written, keyed by what they mean for ownership. */
type SidecarContents =
  "empty" | "provenance" | "unrecognized-provenance" | "foreign-rows";

/**
 * The reads every sidecar probe needs, and nothing else. Satisfied by both a
 * top-level {@link GraphBackend} and a transaction-scoped backend, so the SAME
 * inspection runs as the unfenced preflight and again inside the claim's fence —
 * two callers of one decision rather than two decisions that can disagree.
 *
 * `tableExists` is the one member only the fenced port has, and it exists so the
 * two callers can run that one decision the same way: a secondary relation a
 * database has never materialized must be skipped, and inside a PostgreSQL
 * transaction a failed statement aborts the whole transaction, so the fenced
 * caller cannot learn that by attempting the read. See
 * {@link hasRowsInSecondaryTable}.
 */
type SidecarInspectionPort = Readonly<
  Pick<
    GraphBackend,
    "getActiveSchema" | "findNodesByKind" | "execute" | "tableNames"
  > &
    Readonly<{
      tableExists?: (tableName: string) => Promise<boolean>;
    }>
>;

/**
 * Decides — WITHOUT writing anything — whether the sidecar graph id is this
 * module's to open. The module doc states the rule this implements.
 */
async function inspectSidecarGraphId(
  port: SidecarInspectionPort,
  graph: ReturnType<typeof buildOwnedProvenanceGraph>,
  targetGraphId: string,
): Promise<SidecarDisposition> {
  const activeSchema = await port.getActiveSchema(graph.id);
  // An unregistered graph id is NOT evidence of a free namespace: a store booted
  // with plain `createStore` writes rows and registers no schema row. Only an id
  // with no schema row AND no durable row of any kind is free.
  if (
    activeSchema === undefined &&
    !(await hasRowsUnderGraphId(port, graph.id, "any"))
  ) {
    return { state: "create" };
  }

  // The id holds something. The ownership marker is the only evidence that can
  // say it is OURS, and it is consulted the same way on every schema state.
  const marker = await inspectOwnerMarker(port, graph.id, targetGraphId);
  if (marker === "foreign") {
    return { state: "refuse", reason: "corrupt-ownership-marker" };
  }
  if (marker === "ours") {
    // A verified marker is the durable claim; the contents are not re-litigated.
    // Rows an application later wrote INTO our sidecar do not revoke ownership,
    // and refusing over them would brick a working sidecar.
    return { state: "owned" };
  }

  if (activeSchema === undefined) {
    return { state: "refuse", reason: "application-graph" };
  }

  const ownedHash = await computeSchemaHash(
    serializeSchema(graph, activeSchema.version),
  );
  if (activeSchema.schema_hash === ownedHash) {
    // The current sidecar schema with no marker. This module writes the marker
    // FIRST, so it cannot have produced this state: whatever registered the
    // schema, it was not an interrupted creation of ours. Contents are not
    // consulted — empty or provenance-shaped, they are not evidence of
    // authorship, and adopting on them is exactly how an application graph gets
    // colonized.
    return { state: "refuse", reason: "unowned-exact-schema-graph" };
  }

  const legacyHash = await computeSchemaHash(
    serializeSchema(buildProvenanceGraph(targetGraphId), activeSchema.version),
  );
  if (activeSchema.schema_hash !== legacyHash) {
    return { state: "refuse", reason: "application-graph" };
  }
  return LEGACY_SCHEMA_DISPOSITION[
    await inspectSidecarContents(port, graph.id, targetGraphId)
  ];
}

/**
 * Contents → disposition for a graph id carrying the PRE-MARKER (legacy) schema —
 * the ONE state whose contents may establish ownership, because a pre-marker
 * release could not have written a marker beside them. `empty` still refuses: an
 * empty legacy sidecar carries no evidence at all that this module wrote it, so
 * it cannot be told apart from an application graph of the same shape.
 */
const LEGACY_SCHEMA_DISPOSITION: Readonly<
  Record<SidecarContents, SidecarDisposition>
> = {
  provenance: { state: "upgrade" },
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
  "corrupt-ownership-marker": {
    describe: (graphId, targetGraphId) =>
      `Graph id "${graphId}" holds a "${PROVENANCE_OWNER_KIND}" row that is not a valid ownership claim for target "${targetGraphId}" — it is soft-deleted, does not validate against the marker schema, names a different target, or sits under a different row id.`,
    suggestion: (graphId) =>
      `Do not re-run: an unverifiable marker is never overwritten or resurrected, because it may be an application's row. Inspect the "${PROVENANCE_OWNER_KIND}" rows under graph id "${graphId}" and hard-delete the invalid one, or drop that graph id entirely — persisted provenance is derived, so re-running the merge rebuilds it.`,
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
      `Graph id "${graphId}" carries the merge-provenance schema but no ownership marker, so this library did not create it.`,
    suggestion: (graphId) =>
      `Drop graph id "${graphId}" (or rename the graph that occupies it) and re-run the merge: a sidecar this library owns writes its "${PROVENANCE_OWNER}" marker row BEFORE the schema, so a marker-less one carrying this schema was written either by an application — which is never adopted — or by a crash of an unreleased build between those two writes. Persisted provenance is derived, so re-running the merge rebuilds it.`,
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

/**
 * Refused when the ownership claim cannot be made atomic. Not a collision: the
 * id may well be free — the backend simply cannot hold the contents check and
 * the marker write together, and a check-then-write a concurrent application
 * writer can slip through is not an ownership claim.
 */
function provenanceClaimUnfenced(
  graphId: string,
  targetGraphId: string,
): ConfigurationError {
  return new ConfigurationError(
    `Claiming graph id "${graphId}" for merge provenance requires a transactional schema fence, which this backend does not provide.`,
    {
      code: "GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED",
      graphId,
      targetGraphId,
    },
    {
      suggestion:
        "Use a backend that implements schemaWriteTransaction (both bundled Drizzle backends do when transactions are enabled); without it the sidecar's emptiness check and its ownership write cannot be committed as one unit. An ALREADY-owned sidecar opens without a claim.",
    },
  );
}

/**
 * THE ownership predicate: whether one `ProvenanceOwner`-kind row is the marker
 * this module wrote for THIS target. Every consumer of "is the marker ours?" calls
 * this one function, so the marker probe and the foreign-occupancy classification
 * cannot drift into disagreeing.
 *
 * Exactly one row state qualifies: live (never soft-deleted), stored under the
 * canonical marker id, and validating against {@link ProvenanceOwner} — whose
 * `owner` and `version` are `z.literal`s, so the parse itself pins them — for this
 * target graph id. Every other `ProvenanceOwner`-kind row is FOREIGN, including a
 * tombstone: resurrecting one would overwrite a row this module cannot prove it
 * wrote.
 */
function isOwnedMarkerRow(row: NodeRow, targetGraphId: string): boolean {
  if (row.id !== PROVENANCE_OWNER_ID) return false;
  if (row.deleted_at !== undefined) return false;
  const parsed = ProvenanceOwner.schema.safeParse(parseRowProps(row.props));
  return parsed.success && parsed.data.targetGraphId === targetGraphId;
}

/**
 * What the graph id's `ProvenanceOwner`-kind rows say about ownership.
 *
 * `absent` means there is NO such row at all — the only state in which the marker
 * may be claimed. `foreign` means at least one row exists that
 * {@link isOwnedMarkerRow} rejects, which is occupancy by something this module
 * did not write and must not modify.
 */
type OwnerMarkerState = "ours" | "absent" | "foreign";

async function inspectOwnerMarker(
  port: SidecarInspectionPort,
  graphId: string,
  targetGraphId: string,
): Promise<OwnerMarkerState> {
  let ours = false;
  for await (const row of readRowsOfKind(
    port,
    graphId,
    PROVENANCE_OWNER_KIND,
  )) {
    if (!isOwnedMarkerRow(row, targetGraphId)) return "foreign";
    ours = true;
  }
  return ours ? "ours" : "absent";
}

/** Rows read per page while classifying a graph id's durable contents. */
const SIDECAR_PAGE_SIZE = 500;

/**
 * Every durable row of `kind` under `graphId`, tombstones included. Soft-deleted
 * and out-of-window rows MUST be visible: a row this module cannot account for is
 * occupancy whether or not it is currently live.
 */
async function* readRowsOfKind(
  port: SidecarInspectionPort,
  graphId: string,
  kind: string,
): AsyncGenerator<NodeRow> {
  let after: string | undefined;
  for (;;) {
    const rows = await port.findNodesByKind({
      graphId,
      kind,
      temporalMode: "includeTombstones",
      excludeDeleted: false,
      orderBy: "id",
      ...(after === undefined ? {} : { after }),
      limit: SIDECAR_PAGE_SIZE,
    });
    for (const row of rows) {
      yield row;
    }
    if (rows.length < SIDECAR_PAGE_SIZE) return;
    after = rows.at(-1)?.id;
    if (after === undefined) return;
  }
}

/** One probe row: the SELECT projects a constant, so only its presence matters. */
type SidecarProbeRow = Readonly<{ present: number }>;

/**
 * Cheapest existence probe a backend offers for "does this graph id hold rows?":
 * one `LIMIT 1` lookup per per-graph row table, on the same `graph_id` prefix
 * every read path uses, short-circuiting at the first hit. Tombstoned rows COUNT
 * — a soft-deleted application row still means the id belongs to that
 * application.
 *
 * EVERY per-graph table is probed, not just nodes and edges. A graph id whose
 * only durable rows are recorded-time history, a revision clock or origin,
 * identity assertions and their derived closure/separation, fulltext, or unique
 * keys is an id an application has used — claiming it because the two entity
 * tables happen to be empty is the same colonization refusing a stray node row
 * exists to prevent.
 *
 * `scope: "foreign"` narrows only the NODE table, to rows this module could not
 * have written: node rows of any other kind. Every other table is occupancy in
 * both scopes — a sidecar declares no edges, tracks no revisions, asserts no
 * identities, and projects no fulltext or unique keys, so a row in any of them
 * is not ours whatever the schema says. `ProvenanceOwner` rows are NOT excused
 * either: the marker probe has already classified every one of them, so a row
 * this raw probe can see and `findNodesByKind` cannot is unaccounted-for
 * occupancy and must refuse. It cannot be expressed through `findNodesByKind`,
 * which needs the kinds of a graph whose schema — by construction, in the case
 * that matters — was never registered.
 *
 * The reachable set is exactly the tables the backend names through its
 * `tableNames` port. The schema-version table and the materialization-marker
 * tables are NOT addressable through it, so they are not probed; the active
 * schema row is covered by `getActiveSchema` in {@link inspectSidecarGraphId}.
 */
async function hasRowsUnderGraphId(
  port: SidecarInspectionPort,
  graphId: string,
  scope: "any" | "foreign",
): Promise<boolean> {
  const schema = createSqlSchema(port.tableNames);
  const kindFilter =
    scope === "any" ? sql.empty() : sql` AND kind <> ${PROVENANCE_KIND}`;
  // The entity tables first: every backend has them, so a failure here is a real
  // failure and propagates, and they are where an occupant is likeliest to be.
  if (await hasRowsInTable(port, schema.tables.nodes, graphId, kindFilter)) {
    return true;
  }
  if (await hasRowsInTable(port, schema.tables.edges, graphId, sql.empty())) {
    return true;
  }
  for (const tableName of secondaryRowTableNames(schema.tables)) {
    if (await hasRowsInSecondaryTable(port, tableName, graphId)) return true;
  }
  return false;
}

/**
 * The per-graph row tables beyond nodes and edges, deduplicated because a
 * backend may map two logical relations onto one physical name.
 *
 * This list is the probe's completeness claim: it is every member of the
 * backend's resolved table names that carries a `graph_id` column.
 */
function secondaryRowTableNames(
  tables: ReturnType<typeof createSqlSchema>["tables"],
): readonly string[] {
  return [
    ...new Set([
      tables.recordedNodes,
      tables.recordedEdges,
      tables.recordedClock,
      tables.revisionOrigins,
      tables.identityAssertions,
      tables.recordedIdentityAssertions,
      tables.identityClosure,
      tables.identitySeparation,
      tables.fulltext,
      tables.uniques,
      tables.edgeClaims,
    ]),
  ];
}

/** One `LIMIT 1` existence lookup for one graph id in one table. */
async function hasRowsInTable(
  port: SidecarInspectionPort,
  tableName: string,
  graphId: string,
  filter: ReturnType<typeof sql.empty>,
): Promise<boolean> {
  const rows = await port.execute<SidecarProbeRow>(
    asCompiledRowsSql(
      sql`SELECT 1 AS present FROM ${sql.identifier(tableName)} WHERE graph_id = ${graphId}${filter} LIMIT 1`,
    ),
  );
  return rows.length > 0;
}

/**
 * The same lookup for a relation the database may never have materialized —
 * identity storage, for instance, is created when identity is first enabled, so
 * a database from an earlier release can be missing it entirely.
 *
 * A missing table holds no rows for ANY graph id, so skipping it is exact rather
 * than lenient. Proving it is missing is where the two ports differ: the fenced
 * caller MUST ask the catalog first, because on PostgreSQL a failed statement
 * aborts the enclosing transaction and would take the claim's marker write down
 * with it; the unfenced preflight runs each probe as its own statement, so it can
 * simply let the failure answer the question. Only this narrow "does the relation
 * exist" question is answered that way — the entity-table probes above are strict,
 * and they run first, so a broken connection or an unreadable database fails there
 * instead of being mistaken for a free id.
 */
async function hasRowsInSecondaryTable(
  port: SidecarInspectionPort,
  tableName: string,
  graphId: string,
): Promise<boolean> {
  const tableExists = port.tableExists;
  if (tableExists !== undefined) {
    return (
      (await tableExists(tableName)) &&
      (await hasRowsInTable(port, tableName, graphId, sql.empty()))
    );
  }
  try {
    return await hasRowsInTable(port, tableName, graphId, sql.empty());
  } catch {
    return false;
  }
}

/**
 * Classifies a sidecar-shaped graph id by its actual durable contents.
 *
 * `provenance` is claimed only when every row is a live, valid contribution for
 * THIS target stored under its recomputed deterministic id, and the id holds no
 * other row. It is the sole admission path that reasons from CONTENTS rather than
 * from the marker, and it exists only for pre-marker sidecars, whose release could
 * not have written a marker beside them.
 */
async function inspectSidecarContents(
  port: SidecarInspectionPort,
  graphId: string,
  targetGraphId: string,
): Promise<SidecarContents> {
  if (await hasRowsUnderGraphId(port, graphId, "foreign")) {
    return "foreign-rows";
  }

  let rowCount = 0;
  for await (const row of readRowsOfKind(port, graphId, PROVENANCE_KIND)) {
    if (!(await isOwnedProvenanceRow(row, targetGraphId))) {
      return "unrecognized-provenance";
    }
    rowCount += 1;
  }
  return rowCount > 0 ? "provenance" : "empty";
}

/**
 * Whether one `Provenance` row is a contribution this module wrote for THIS
 * target: live, valid against the schema, and stored under the deterministic id
 * its own props hash to. The recomputed id is what makes this a proof of
 * authorship rather than a shape check — an application row with plausible props
 * under an id of its own choosing fails it.
 */
async function isOwnedProvenanceRow(
  row: NodeRow,
  targetGraphId: string,
): Promise<boolean> {
  if (row.deleted_at !== undefined) return false;
  const parsed = Provenance.schema.safeParse(parseRowProps(row.props));
  if (!parsed.success || parsed.data.targetGraphId !== targetGraphId) {
    return false;
  }
  const expectedId = await provenanceNodeId(targetGraphId, {
    role: parsed.data.role,
    canonicalId: parsed.data.canonicalId,
    canonicalKind: parsed.data.canonicalKind,
    branchId: asBranchId(parsed.data.branchId),
    sourceId: parsed.data.sourceId,
  });
  return row.id === expectedId;
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

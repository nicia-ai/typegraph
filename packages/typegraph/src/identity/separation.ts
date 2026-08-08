/**
 * The identity SEPARATION relation: the `different` half of the assertion
 * ledger lifted from node pairs to whole identity classes, one row per
 * separated pair of classes.
 *
 * WHY IT EXISTS. Two code-level layers already refuse a contradictory identity
 * write — the plan-time simulation and the applier's own validation — and both
 * decide by reading state and comparing. A bug in either decides wrongly and
 * commits a ledger where a current `different` assertion sits inside one
 * identity class. This relation removes the decision: every class-fusing
 * transaction relabels the affected separation rows, and relabelling both sides
 * of a row to the same class key produces `class_key_low = class_key_high`,
 * which the relation's CHECK constraint rejects. The transaction aborts in the
 * engine, on a rule no application code can be talked out of.
 *
 * The writers below therefore never test for the contradictory row and skip it.
 * They project the ledger, emit what the projection says, and let the database
 * answer. {@link buildSeparationProjection} does record which assertion
 * produced a collapsed pair, but only so the abort can be reported as a typed
 * error naming the real cause instead of a driver constraint message.
 *
 * SHAPE. A class key is the code-point-least member of the class, encoded by
 * {@link identityClassKey} — a singleton class is keyed by its own node, so
 * nothing has to be materialized for nodes that carry no assertions. The pair
 * is stored ordered (`low < high`) under {@link compareCodePoints}, which is
 * exactly the order SQLite's BINARY collation and PostgreSQL's `C` collation
 * apply, so the writer and the CHECK constraint agree on every input.
 *
 * READABLE STATES. Because an empty relation answers "not separated" for every
 * pair, the relation's only safe states are ABSENT (every read raises
 * `IDENTITY_STORAGE_MISSING` — loud, never a wrong answer) and PRESENT AND
 * COMPLETE. {@link separationRebuildRequired} is how every provisioning path
 * tells those apart for one graph, and it is what makes a relation left empty
 * by a refused upgrade heal on the next open instead of under-reporting
 * forever. {@link isSeparated} consults the same predicate, because healing
 * happens at an OPEN and a handle opened before the relation existed cannot
 * heal itself — it refuses loudly until it is reopened. See
 * `schema-transition.ts` for the paths that own the invariant.
 */
import {
  ConfigurationError,
  IdentitySeparationViolationError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { nowIso } from "../utils/date";
import { isMissingTableError } from "../utils/sql-errors";
import { encodeTupleKey } from "../utils/tuple-key";
import {
  identityAssertionSnapshotSource,
  identitySqlCoordinate,
} from "./historical-sql";
import { identityActiveKinds } from "./service-components";
import {
  executeIdentityStatement,
  identityChunkSize,
  type IdentityTarget,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";

const MAX_SEPARATION_INSERT_CHUNK_SIZE = 100;

/**
 * The PERSISTED encoding of an identity class key.
 *
 * Deliberately its own function rather than a reuse of the service's in-memory
 * `refKey`: this string lives in the database, so changing it is a migration,
 * while an in-memory map key is free to change with its map.
 */
export function identityClassKey(ref: PlainNodeRef): string {
  return encodeTupleKey([ref.kind, ref.id]);
}

/** One separated pair of identity classes, ordered by code point. */
export type SeparationPair = Readonly<{ low: string; high: string }>;

/**
 * A `different` assertion whose two endpoints resolved to ONE class key — the
 * contradiction the separation relation exists to reject.
 */
type CollapsedSeparation = Readonly<{
  classKey: string;
  assertionId: string;
  a: PlainNodeRef;
  b: PlainNodeRef;
}>;

export type SeparationProjection = Readonly<{
  pairs: readonly SeparationPair[];
  collapsed: readonly CollapsedSeparation[];
}>;

// NUL separator: `identityClassKey` is JSON, which escapes NUL to a `\u0000`
// sequence, so no encoded key can contain one and no two distinct pairs can
// share a joined key.
const PAIR_KEY_SEPARATOR = "\u0000";

function pairKey(pair: SeparationPair): string {
  return `${pair.low}${PAIR_KEY_SEPARATOR}${pair.high}`;
}

function orderedPair(first: string, second: string): SeparationPair {
  return compareCodePoints(first, second) <= 0 ?
      { low: first, high: second }
    : { low: second, high: first };
}

/**
 * Projects `different` assertions onto their endpoints' identity classes.
 *
 * Duplicate pairs collapse to one row: several assertions can separate the same
 * two classes, and the relation records the separation, not its witnesses.
 * A pair whose endpoints share a class key is emitted UNCHANGED — rejecting it
 * is the database's job, not this function's — and additionally reported in
 * `collapsed` so the resulting abort can name the assertion behind it.
 */
export function buildSeparationProjection(
  assertions: readonly IdentityAssertionStorageRow[],
  classKeyOf: (ref: PlainNodeRef) => string,
): SeparationProjection {
  const pairs = new Map<string, SeparationPair>();
  const collapsed: CollapsedSeparation[] = [];
  for (const assertion of assertions) {
    if (assertion.rel !== "different") continue;
    const a = { kind: assertion.a_kind, id: assertion.a_id };
    const b = { kind: assertion.b_kind, id: assertion.b_id };
    const pair = orderedPair(classKeyOf(a), classKeyOf(b));
    pairs.set(pairKey(pair), pair);
    if (pair.low === pair.high) {
      collapsed.push({
        classKey: pair.low,
        assertionId: assertion.id,
        a,
        b,
      });
    }
  }
  return { pairs: [...pairs.values()], collapsed };
}

/** Drops every separation row for the graph, ahead of a full recompute. */
export async function deleteSeparationForGraph(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<void> {
  await executeIdentityStatement(
    target,
    sql`DELETE FROM ${schema.identitySeparationTable} WHERE graph_id = ${graphId}`,
  );
}

/**
 * Drops every separation row naming one of `classKeys` on either side.
 *
 * Callers pass the keys of ALL members of the affected classes, not just the
 * classes' current keys: a fuse retires one of the two keys, and the retired
 * key's rows are only reachable by its own member key.
 */
export async function deleteSeparationForClassKeys(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  classKeys: readonly string[],
): Promise<void> {
  const unique = [...new Set(classKeys)];
  if (unique.length === 0) return;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  for (const keyChunk of chunk(unique, chunkSize)) {
    const keyList = sql.join(
      keyChunk.map((key) => sql`${key}`),
      sql`, `,
    );
    await executeIdentityStatement(
      target,
      sql`
        DELETE FROM ${schema.identitySeparationTable}
        WHERE graph_id = ${graphId}
          AND (class_key_low IN (${keyList}) OR class_key_high IN (${keyList}))
      `,
    );
  }
}

type RawSeparationRow = Readonly<{
  class_key_low: string;
  class_key_high: string;
}>;

/**
 * Whether the relation records two CURRENT classes as separated.
 *
 * One primary-key probe against `(graph_id, class_key_low, class_key_high)`,
 * standing in for resolving both classes' `different` assertions out of the
 * ledger and scanning them for one that spans the pair. Callers pass the class
 * keys in any order; putting them in the relation's `low < high` order is this
 * module's business, since it is the same ordering the writer applies.
 *
 * Valid only for a current-mode read: the relation projects CURRENT assertions
 * onto CURRENT classes, so a valid-time or recorded coordinate has to
 * reconstruct from the ledger instead.
 *
 * NEVER ANSWERS "not separated" WHEN IT COULD NOT READ. A missing relation
 * raises `IDENTITY_STORAGE_MISSING` and any other driver failure propagates
 * unchanged — and one more state answers loudly rather than falsely: the
 * relation is PRESENT but holds no row for this graph while the ledger holds a
 * live `different` assertion, which means this graph's fill never ran. A store
 * handle opened while the relation was ABSENT fails loudly on every read; if
 * another graph's upgrade then creates the shared relation mid-session, that
 * handle would otherwise transition from loud failure to a confident, wrong
 * "not separated" — {@link separationRebuildRequired} is what keeps it loud
 * until the handle is reopened (the reopen runs the fill).
 *
 * WHAT IT COSTS. The pair lookup and "does this graph have ANY row" travel in
 * ONE statement — a second seek on the same primary key, in the same round
 * trip — so a graph that uses separations pays nothing beyond that seek and the
 * ledger is not read at all. The ledger probe runs only when the graph has NO
 * separation rows AND the pair missed, which is also the only state where a
 * "false" could be an unfilled relation rather than an absent separation. Both
 * callers reach here having already resolved two identity classes through the
 * closure (a recursive CTE each), so the bounded `LIMIT 1` this adds in that
 * state is small against what the answer already cost.
 *
 * @throws {ConfigurationError} `IDENTITY_STORAGE_MISSING` when the relation the
 * probe reads does not exist, or exists without this graph's fill.
 */
export async function isSeparated(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  firstClassKey: string,
  secondClassKey: string,
  registry: KindRegistry,
): Promise<boolean> {
  // A class is never separated from itself: `low = high` is what the relation's
  // CHECK exists to reject, so the probe is a guaranteed miss and the round
  // trip buys nothing.
  if (firstClassKey === secondClassKey) return false;
  const probe = await probeSeparationPair(
    target,
    schema,
    graphId,
    orderedPair(firstClassKey, secondClassKey),
  );
  if (probe.pairSeparated) return true;
  if (probe.graphHasRows) return false;
  if (await hasLiveDifferentAssertions(target, schema, graphId, registry)) {
    throw separationUnfilledError(graphId, schema);
  }
  return false;
}

/** What one probe of the relation establishes about a pair AND its graph. */
type SeparationProbe = Readonly<{
  pairSeparated: boolean;
  graphHasRows: boolean;
}>;

async function probeSeparationPair(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  pair: SeparationPair,
): Promise<SeparationProbe> {
  try {
    const rows = await target.execute<Readonly<Record<string, unknown>>>(
      asCompiledRowsSql(sql`
        SELECT
          (
            SELECT COUNT(*) FROM ${schema.identitySeparationTable}
            WHERE graph_id = ${graphId}
              AND class_key_low = ${pair.low}
              AND class_key_high = ${pair.high}
          ) AS pair_rows,
          (
            SELECT COUNT(*) FROM (
              SELECT 1 AS present FROM ${schema.identitySeparationTable}
              WHERE graph_id = ${graphId}
              LIMIT 1
            ) graph_probe
          ) AS graph_rows
      `),
    );
    const row = rows[0];
    return {
      graphHasRows: countOf(row, "graph_rows") > 0,
      pairSeparated: countOf(row, "pair_rows") > 0,
    };
  } catch (error) {
    // Never degrade to "not separated": a caller that cannot read the relation
    // has no basis for an answer, and the wrong answer here is the one that
    // lets a contradiction through. Both branches below therefore throw.
    //
    // A missing relation is the one failure this seam can describe better than
    // the driver can, so it is translated — through the shared structural
    // classifier (SQLSTATE 42P01, SQLite `no such table`), never this module's
    // own wording match. Everything else — a deadlock, a serialization failure,
    // a lock timeout, a dropped connection — is transient or unrelated, and
    // relabelling it "storage missing" would send an operator to rebuild a
    // relation that is intact and would hide a retryable conflict from callers
    // that classify it (graph-merge's commit retry reads the driver SQLSTATE).
    if (!isMissingTableError(error)) throw error;
    throw separationUnreadableError(graphId, schema, error);
  }
}

/**
 * `COUNT(*)` as a number, whatever the driver hands back.
 *
 * PostgreSQL's `count` is `bigint`, which node-postgres returns as a string
 * rather than losing precision; SQLite returns a number. A truthiness test on
 * the raw value would read the string `"0"` as separated.
 */
function countOf(
  row: Readonly<Record<string, unknown>> | undefined,
  column: string,
): number {
  return Number(row?.[column] ?? 0);
}

function separationUnreadableError(
  graphId: string,
  schema: SqlSchema,
  cause: unknown,
): ConfigurationError {
  return new ConfigurationError(
    "Operational Identity could not read the materialized separation relation.",
    {
      code: "IDENTITY_STORAGE_MISSING",
      graphId,
      tables: [schema.tables.identitySeparation],
    },
    {
      cause,
      suggestion:
        "Recreate the identity separation relation with the standard TypeGraph DDL, open the Store, and run rebuildIdentityClosure(store) before serving traffic.",
    },
  );
}

/**
 * The relation exists but holds no row for this graph while the ledger holds a
 * live `different` assertion — this graph's fill never ran.
 *
 * Reported under the same code as an absent relation, because it is the same
 * fact for an operator (this graph's derived separation storage is not
 * readable) with the same remedy. Reopening the Store runs the fill; a handle
 * that predates the relation's creation cannot, which is exactly the window
 * this refusal exists to keep loud.
 */
function separationUnfilledError(
  graphId: string,
  schema: SqlSchema,
): ConfigurationError {
  return new ConfigurationError(
    "Operational Identity found the separation relation present but never filled for this graph.",
    {
      code: "IDENTITY_STORAGE_MISSING",
      graphId,
      reason: "unfilled",
      tables: [schema.tables.identitySeparation],
    },
    {
      suggestion:
        "Reopen the Store (createStoreWithSchema rebuilds the derived identity relations when they are missing rows), or run rebuildIdentityClosure(store) before serving traffic. A Store handle opened while the relation did not exist keeps failing until it is reopened.",
    },
  );
}

/**
 * The persisted relation holds a separated pair the assertion ledger does not
 * project — the same `rebuild != recompute(ledger)` divergence
 * {@link assertSeparationMatchesProjection} refuses, discovered by a probe
 * whose answer the ledger could not corroborate.
 */
export function unexpectedSeparationError(
  graphId: string,
  firstClassKey: string,
  secondClassKey: string,
): ConfigurationError {
  return separationMismatchError(graphId, {
    unexpected: orderedPair(firstClassKey, secondClassKey),
  });
}

/**
 * Whether THIS GRAPH's separation relation still owes rows to the ledger —
 * the per-graph fill decision every provisioning path keys on.
 *
 * The decision it replaces was "the separation TABLE is missing", and that
 * question has the wrong scope in two ways. Identity DDL is database-global
 * while the ledger is per-graph, so graph B creating the relation made graph A
 * skip its own fill; and a relation created by a schema commit that was then
 * refused stayed present-and-empty forever, because "present" is exactly what
 * suppressed the next open's rebuild. Keying on this graph's own derived state
 * fixes both, and makes a stranded empty relation SELF-HEALING: the next open
 * of the graph that owns the assertions sees assertions-without-rows and
 * rebuilds.
 *
 * `true` means: the ledger holds at least one live `different` assertion for
 * the graph while the relation holds no row for it. Those are precisely the
 * states in which the relation would under-report a separation — the answer
 * that lets `assertSame` fuse two classes a `different` assertion separates.
 * A graph with no live `different` assertion projects to zero rows, so an
 * empty relation is not merely safe there, it is CORRECT, and no rebuild is
 * owed.
 *
 * `relationExists: false` skips the row probe (the relation cannot be read
 * before it is created) and answers purely from the ledger, so a caller can
 * distinguish "create it empty" from "create it and fill it in one fence".
 *
 * EXACTNESS IS THE POINT, in both directions: "a fill is owed" has to be true
 * exactly when the fill would write a ROW, not merely when the ledger holds an
 * assertion. Three conditions get it there, and each one is a state that
 * over-answering would misdiagnose — see {@link hasLiveDifferentAssertions}:
 * the current-coordinate filter ({@link identityAssertionSnapshotSource}), the
 * registry filter ({@link identityActiveKinds}), and "the endpoints are in
 * different classes", without which a contradicted ledger — whose projection is
 * a degenerate pair the CHECK constraint refuses — reads as a relation that was
 * never filled. Over-answering does not merely waste work: it re-runs the
 * fenced CREATE+FILL under the database-scoped DDL lock at every open without
 * converging, and on the read path it reports storage-missing for a fault that
 * is neither. Under-answering leaves the relation under-reporting.
 */
export async function separationRebuildRequired(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  options: Readonly<{ relationExists: boolean; registry: KindRegistry }>,
): Promise<boolean> {
  if (
    options.relationExists &&
    (await hasSeparationRows(target, schema, graphId))
  ) {
    return false;
  }
  return hasLiveDifferentAssertions(target, schema, graphId, options.registry);
}

async function hasSeparationRows(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<boolean> {
  const rows = await target.execute<Readonly<Record<string, unknown>>>(
    asCompiledRowsSql(sql`
      SELECT 1 AS present
      FROM ${schema.identitySeparationTable}
      WHERE graph_id = ${graphId}
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/**
 * Whether the ledger holds a live `different` assertion the relation OWES A ROW
 * FOR — one the fill would turn into a row the relation can actually hold.
 *
 * Two conditions separate that from "a live `different` exists", and both are
 * load-bearing:
 *
 *  - THE REGISTRY FILTER. An assertion naming a kind this schema does not
 *    register is dropped by `loadSnapshot` before the projection, so the fill
 *    would never write it. Counting it asks for a rebuild that cannot converge.
 *  - THE CLASSES MUST DIFFER. An assertion whose two endpoints are in the SAME
 *    identity class projects to a DEGENERATE pair (`low = high`), which is
 *    exactly what the relation's CHECK constraint exists to reject — the fill
 *    would abort rather than write a row. Zero rows is then not an unfilled
 *    relation, it is the only content the relation can hold, and the real fault
 *    is a self-contradictory ledger. That fault has its own typed error, raised
 *    by the writer and the CHECK ({@link IdentitySeparationViolationError});
 *    reporting it here as storage-missing would name the wrong cause and send
 *    an operator to a rebuild that cannot succeed.
 *
 * Two steps, because both conditions are the expensive half and almost never
 * change the answer. The first probe binds no kinds, joins nothing, and settles
 * the common case — no live `different` at all — in one statement. Only when
 * one exists does the exact probe run.
 *
 * Class membership comes from the materialized closure, the same authority the
 * callers of {@link isSeparated} resolved their class keys through. The fill
 * instead recomputes classes from the ledger, so a closure that is itself stale
 * could make this answer `false` where the fill would have written a row —
 * a database whose closure is corrupt, which `validateIdentity()` reports and
 * which the CHECK still refuses at the next fusing write.
 */
async function hasLiveDifferentAssertions(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  registry: KindRegistry,
): Promise<boolean> {
  if (!(await probeAnyLiveDifferent(target, schema, graphId))) return false;
  const activeKinds = [...identityActiveKinds(registry)];
  if (activeKinds.length === 0) return false;
  // Both endpoints are filtered, so each kind is bound twice. Chunking the
  // cartesian product keeps the statement inside the backend's bind budget for
  // a registry too large to name in one; a single chunk is the normal case and
  // the loop then runs exactly one probe.
  const chunkSize = identityChunkSize(target, {
    fixedParameters: OWED_SEPARATION_PROBE_PARAMETERS,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  const kindChunks = chunk(activeKinds, chunkSize);
  for (const first of kindChunks) {
    for (const second of kindChunks) {
      if (await probeOwedSeparation(target, schema, graphId, [first, second])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * How many binds {@link identityAssertionSnapshotSource} contributes at the
 * CURRENT coordinate: `graph_id`, `rel`, and the validity instant twice
 * (`valid_from <=` and `valid_to >`). A recorded coordinate binds two more, and
 * no caller here uses one.
 */
const IDENTITY_SNAPSHOT_PARAMETERS = 4;

/**
 * Fixed binds in {@link probeOwedSeparation}'s STATEMENT — the snapshot
 * subquery's own, plus the `graph_id` each of the two closure `LEFT JOIN`s
 * binds.
 *
 * The chunk math budgets for the whole statement, so it must count every bind
 * the statement carries, not just the subquery's. Budgeting only the subquery's
 * four left the two join binds unfunded, so on a backend at its bind ceiling the
 * probe could be built one kind too wide and overrun the limit it was chunked to
 * respect. Asserted against the rendered statement in
 * `identity-separation-probe-cost.test.ts`.
 */
const OWED_SEPARATION_PROBE_PARAMETERS = IDENTITY_SNAPSHOT_PARAMETERS + 2;

/** The cheap half: does the graph hold ANY live `different` assertion. */
async function probeAnyLiveDifferent(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<boolean> {
  const rows = await target.execute<Readonly<Record<string, unknown>>>(
    asCompiledRowsSql(sql`
      SELECT 1 AS present
      FROM (${liveDifferentSource(schema, graphId)}) live_different
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/**
 * The exact half: a live `different` whose endpoints are in DIFFERENT classes
 * and whose kinds this schema registers — the assertions that become rows.
 *
 * A member absent from the closure is a singleton class keyed by itself, which
 * is what the `COALESCE` reconstructs: the closure materializes only classes
 * with more than one member.
 */
async function probeOwedSeparation(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  kinds: readonly [readonly string[], readonly string[]],
): Promise<boolean> {
  const rows = await target.execute<Readonly<Record<string, unknown>>>(
    asCompiledRowsSql(sql`
      SELECT 1 AS present
      FROM (${liveDifferentSource(schema, graphId)}) live_different
      LEFT JOIN ${schema.identityClosureTable} class_a
        ON class_a.graph_id = ${graphId}
       AND class_a.member_kind = live_different.a_kind
       AND class_a.member_id = live_different.a_id
      LEFT JOIN ${schema.identityClosureTable} class_b
        ON class_b.graph_id = ${graphId}
       AND class_b.member_kind = live_different.b_kind
       AND class_b.member_id = live_different.b_id
      WHERE live_different.a_kind IN (${kindList(kinds[0])})
        AND live_different.b_kind IN (${kindList(kinds[1])})
        AND (
          COALESCE(class_a.class_kind, live_different.a_kind)
            <> COALESCE(class_b.class_kind, live_different.b_kind)
          OR COALESCE(class_a.class_id, live_different.a_id)
            <> COALESCE(class_b.class_id, live_different.b_id)
        )
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

function liveDifferentSource(schema: SqlSchema, graphId: string): SqlFragment {
  return identityAssertionSnapshotSource(
    schema,
    graphId,
    identitySqlCoordinate(undefined, nowIso()),
    "different",
  );
}

function kindList(kinds: readonly string[]): SqlFragment {
  return sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
}

/** Every persisted separation pair for the graph. */
export async function readSeparationForGraph(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<readonly SeparationPair[]> {
  const rows = await target.execute<RawSeparationRow>(
    asCompiledRowsSql(sql`
      SELECT class_key_low, class_key_high
      FROM ${schema.identitySeparationTable}
      WHERE graph_id = ${graphId}
    `),
  );
  return rows.map((row) => ({
    low: row.class_key_low,
    high: row.class_key_high,
  }));
}

/**
 * Writes a projection's pairs.
 *
 * The insert is issued as-is, collapsed rows included; the relation's CHECK
 * constraint is what refuses them. A rejected insert is re-thrown as
 * {@link IdentitySeparationViolationError} naming the assertion behind the
 * collapse — and if the insert is instead ACCEPTED while the projection holds a
 * collapsed pair, the constraint is missing from this database, which the same
 * error reports with `enforcedBy: "writer"` rather than letting the
 * contradiction commit.
 */
export async function insertSeparationRows(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  projection: SeparationProjection,
): Promise<void> {
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 0,
    maxItems: MAX_SEPARATION_INSERT_CHUNK_SIZE,
    parametersPerItem: 3,
  });
  for (const pairChunk of chunk(projection.pairs, chunkSize)) {
    const values = pairChunk.map(
      (pair) => sql`(${graphId}, ${pair.low}, ${pair.high})`,
    );
    try {
      await executeIdentityStatement(
        target,
        sql`
          INSERT INTO ${schema.identitySeparationTable} (
            graph_id, class_key_low, class_key_high
          ) VALUES ${sql.join(values, sql`, `)}
        `,
      );
    } catch (error) {
      const collapsed = collapsedIn(projection, pairChunk);
      if (collapsed === undefined) throw error;
      throw new IdentitySeparationViolationError(
        { graphId, enforcedBy: "database", ...collapsed },
        { cause: error },
      );
    }
  }
  const accepted = projection.collapsed[0];
  if (accepted === undefined) return;
  throw new IdentitySeparationViolationError({
    graphId,
    enforcedBy: "writer",
    ...accepted,
  });
}

/** The collapsed assertion whose row is in `pairChunk`, if the chunk has one. */
function collapsedIn(
  projection: SeparationProjection,
  pairChunk: readonly SeparationPair[],
): CollapsedSeparation | undefined {
  const keys = new Set(pairChunk.map((pair) => pairKey(pair)));
  return projection.collapsed.find((collapsed) =>
    keys.has(pairKey({ low: collapsed.classKey, high: collapsed.classKey })),
  );
}

/**
 * Asserts the persisted separation relation equals the projection of the given
 * assertions — the `rebuild == recompute(ledger)` oracle, run by identity
 * validation the same way the closure is checked against its components.
 */
export function assertSeparationMatchesProjection(
  graphId: string,
  persisted: readonly SeparationPair[],
  projection: SeparationProjection,
): void {
  const expected = new Map(
    projection.pairs.map((pair) => [pairKey(pair), pair] as const),
  );
  const seen = new Set<string>();
  for (const pair of persisted) {
    const key = pairKey(pair);
    if (!expected.has(key)) {
      throw separationMismatchError(graphId, { unexpected: pair });
    }
    seen.add(key);
  }
  for (const [key, pair] of expected) {
    if (seen.has(key)) continue;
    throw separationMismatchError(graphId, { missing: pair });
  }
}

function separationMismatchError(
  graphId: string,
  detail: Readonly<Record<string, unknown>>,
): ConfigurationError {
  return new ConfigurationError(
    "Operational Identity materialized separation relation does not match the assertion ledger.",
    { code: "IDENTITY_SCHEMA_CONTRADICTION", graphId, ...detail },
    {
      suggestion:
        "Run rebuildIdentityClosure(store) to rebuild the materialized identity relations.",
    },
  );
}

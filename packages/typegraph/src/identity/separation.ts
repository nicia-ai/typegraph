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
 */
import {
  ConfigurationError,
  IdentitySeparationViolationError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { isMissingTableError } from "../utils/sql-errors";
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
  return JSON.stringify([ref.kind, ref.id]);
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
 * Never answers "not separated" when it could not read: a missing relation
 * raises `IDENTITY_STORAGE_MISSING` and any other driver failure propagates
 * unchanged.
 *
 * @throws {ConfigurationError} `IDENTITY_STORAGE_MISSING` when the relation the
 * probe reads does not exist.
 */
export async function isSeparated(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  firstClassKey: string,
  secondClassKey: string,
): Promise<boolean> {
  // A class is never separated from itself: `low = high` is what the relation's
  // CHECK exists to reject, so the probe is a guaranteed miss and the round
  // trip buys nothing.
  if (firstClassKey === secondClassKey) return false;
  const rows = await probeSeparationPair(
    target,
    schema,
    graphId,
    orderedPair(firstClassKey, secondClassKey),
  );
  return rows.length > 0;
}

async function probeSeparationPair(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  pair: SeparationPair,
): Promise<readonly RawSeparationRow[]> {
  try {
    return await target.execute<RawSeparationRow>(
      asCompiledRowsSql(sql`
        SELECT class_key_low, class_key_high
        FROM ${schema.identitySeparationTable}
        WHERE graph_id = ${graphId}
          AND class_key_low = ${pair.low}
          AND class_key_high = ${pair.high}
      `),
    );
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

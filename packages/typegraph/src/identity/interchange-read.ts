import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { getDialect } from "../query/dialect";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { IDENTITY_ASSERTION_COLUMNS } from "./historical-sql";
import { identityReferenceKey } from "./reference";
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
  toTransferAssertion,
} from "./row-codec";
import { referenceCondition } from "./service-read";
import {
  type IdentityAssertionPage,
  type IdentityAssertionPageOptions,
  type IdentityInterchangeReadOptions,
  type IdentityServiceContext,
  type IdentityTransferAssertion,
} from "./service-types";
import {
  identityChunkSize,
  type IdentityTarget,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";

/** Reads the interchange-visible assertion ledger incident to endpoint keys. */
export async function readIdentityAssertionsTouchingAtTarget<
  G extends GraphDef,
>(
  ctx: IdentityServiceContext<G>,
  target: IdentityTarget,
  references: readonly PlainNodeRef[],
  mode: "state" | "archival",
): Promise<readonly IdentityTransferAssertion[]> {
  const uniqueReferences = new Map<string, PlainNodeRef>();
  for (const reference of references) {
    uniqueReferences.set(identityReferenceKey(reference), reference);
  }
  if (uniqueReferences.size === 0) return [];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 16,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 4,
  });
  const assertionsById = new Map<string, IdentityTransferAssertion>();
  for (const referenceChunk of chunk(
    [...uniqueReferences.values()],
    chunkSize,
  )) {
    const aMatches = referenceCondition(
      sql`identity_assertions.a_kind`,
      sql`identity_assertions.a_id`,
      referenceChunk,
    );
    const bMatches = referenceCondition(
      sql`identity_assertions.b_kind`,
      sql`identity_assertions.b_id`,
      referenceChunk,
    );
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_ASSERTION_COLUMNS}
        FROM ${ctx.schema.identityAssertionsTable} identity_assertions
        WHERE identity_assertions.graph_id = ${ctx.graphId}
          ${interchangeAssertionVisibility(mode)}
          AND (${aMatches} OR ${bMatches})
      `),
    );
    for (const row of rows) {
      const assertion = toTransferAssertion(normalizeIdentityAssertionRow(row));
      assertionsById.set(assertion.id, assertion);
    }
  }
  return [...assertionsById.values()].toSorted((left, right) =>
    compareCodePoints(left.id, right.id),
  );
}

/** The shared interchange visibility rule for state and archival reads. */
function interchangeAssertionVisibility(
  mode: "state" | "archival",
): SqlFragment {
  return sql`
    AND identity_assertions.deleted_at IS NULL
    ${mode === "state" ? sql`AND identity_assertions.valid_to IS NULL` : sql``}
  `;
}

/**
 * The assertion-id expression this read scans and paginates by, pinned to
 * code-point order on every engine.
 *
 * Ordering is part of this read's contract, not an incidental detail. Two
 * consumers depend on it: the interchange export walks pages by an
 * `id > after` keyset cursor, and `computeContentComponent` hashes the
 * returned assertion list in READ order into a base-version content token.
 * The read seam is the only owner of that order — nothing downstream re-sorts.
 *
 * Left bare, `ORDER BY identity_assertions.id` sorts under the column's
 * collation, which on PostgreSQL is the database's locale (`en_US.utf8`
 * orders `a, B, c` case-insensitively) while SQLite's `BINARY` is code-point
 * order. Mixed-case ids — every nanoid, plus any caller-supplied id an
 * importer accepts — therefore paged differently on the two backends, and a
 * `base@V` token minted before this read carried an `ORDER BY` (which sorted
 * in JavaScript by code point) stopped matching its recomputation on
 * PostgreSQL.
 *
 * Both the scan order AND the keyset comparison go through the same
 * expression: a JavaScript re-sort would fix neither, and pinning only the
 * `ORDER BY` would leave the cursor comparing under a different collation
 * than the scan, which skips and duplicates rows across page boundaries.
 *
 * The `binaryText` member of the dialect adapter is the repo's existing seam
 * for this (`COLLATE "C"` on PostgreSQL, identity on SQLite), so SQLite's
 * emitted SQL is unchanged.
 */
function codePointOrderedAssertionId(target: IdentityTarget): SqlFragment {
  return getDialect(target.dialect).binaryText(sql`identity_assertions.id`);
}

export async function readIdentityAssertionPageAtTarget<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: IdentityTarget,
  mode: "state" | "archival",
  options: IdentityAssertionPageOptions,
): Promise<IdentityAssertionPage> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new ConfigurationError(
      "Identity assertion page limit must be a positive safe integer.",
      { limit: options.limit },
    );
  }
  const nodeKinds =
    options.nodeKinds === undefined ?
      undefined
    : [...new Set(options.nodeKinds)];
  const kindFilterChunkSize =
    nodeKinds === undefined || nodeKinds.length === 0 ?
      MAX_REFERENCE_CHUNK_SIZE
    : identityChunkSize(target, {
        fixedParameters: 16,
        maxItems: MAX_REFERENCE_CHUNK_SIZE,
        parametersPerItem: 2,
      });
  const filterKindsInMemory =
    nodeKinds !== undefined && nodeKinds.length > kindFilterChunkSize;
  const kindFilter =
    nodeKinds === undefined ? sql``
    : nodeKinds.length === 0 ? sql`AND 1 = 0`
    : filterKindsInMemory ? sql``
    : sql`
      AND identity_assertions.a_kind IN (${sql.join(
        nodeKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})
      AND identity_assertions.b_kind IN (${sql.join(
        nodeKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})
    `;
  const liveEndpointJoins =
    options.includeDeleted === false ?
      sql`
        JOIN ${ctx.schema.nodesTable} identity_a_node
          ON identity_a_node.graph_id = identity_assertions.graph_id
         AND identity_a_node.kind = identity_assertions.a_kind
         AND identity_a_node.id = identity_assertions.a_id
         AND identity_a_node.deleted_at IS NULL
        JOIN ${ctx.schema.nodesTable} identity_b_node
          ON identity_b_node.graph_id = identity_assertions.graph_id
         AND identity_b_node.kind = identity_assertions.b_kind
         AND identity_b_node.id = identity_assertions.b_id
         AND identity_b_node.deleted_at IS NULL
      `
    : sql``;
  const assertionIdKey = codePointOrderedAssertionId(target);
  const rows = await target.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT identity_assertions.graph_id AS graph_id,
             identity_assertions.id AS id,
             identity_assertions.rel AS rel,
             identity_assertions.a_kind AS a_kind,
             identity_assertions.a_id AS a_id,
             identity_assertions.b_kind AS b_kind,
             identity_assertions.b_id AS b_id,
             identity_assertions.valid_from AS valid_from,
             identity_assertions.valid_to AS valid_to,
             identity_assertions.created_at AS created_at,
             identity_assertions.updated_at AS updated_at,
             identity_assertions.deleted_at AS deleted_at,
             identity_assertions.ended_by_kind AS ended_by_kind,
             identity_assertions.ended_by_id AS ended_by_id
      FROM ${ctx.schema.identityAssertionsTable} identity_assertions
      ${liveEndpointJoins}
      WHERE identity_assertions.graph_id = ${ctx.graphId}
        ${interchangeAssertionVisibility(mode)}
        ${
          options.after === undefined ?
            sql``
          : sql`AND ${assertionIdKey} > ${options.after}`
        }
        ${kindFilter}
      ORDER BY ${assertionIdKey} ASC
      LIMIT ${options.limit}
    `),
  );
  const allowedKinds = filterKindsInMemory ? new Set(nodeKinds) : undefined;
  const assertions = rows
    .filter(
      (row) =>
        allowedKinds === undefined ||
        (allowedKinds.has(row.a_kind) && allowedKinds.has(row.b_kind)),
    )
    .map((row) => toTransferAssertion(normalizeIdentityAssertionRow(row)));
  const nextAfter = rows.at(-1)?.id;
  return {
    assertions,
    ...(nextAfter === undefined ? {} : { nextAfter }),
    done: rows.length < options.limit,
  };
}

export async function readIdentityAssertionsForInterchange<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  mode: "state" | "archival",
  options?: IdentityInterchangeReadOptions,
): Promise<readonly IdentityTransferAssertion[]> {
  const page = await readIdentityAssertionPageAtTarget(ctx, ctx.backend, mode, {
    ...options,
    limit: 2_147_483_647,
  });
  return page.assertions;
}

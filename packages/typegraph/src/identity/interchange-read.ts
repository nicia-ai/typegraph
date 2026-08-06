import { type GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
  toTransferAssertion,
} from "./row-codec";
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
} from "./sql-target";

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
        AND identity_assertions.deleted_at IS NULL
        ${
          options.after === undefined ?
            sql``
          : sql`AND identity_assertions.id > ${options.after}`
        }
        ${
          mode === "state" ?
            sql`AND identity_assertions.valid_to IS NULL`
          : sql``
        }
        ${kindFilter}
      ORDER BY identity_assertions.id ASC
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

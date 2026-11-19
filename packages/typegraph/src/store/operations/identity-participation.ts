/**
 * Which of a set of one kind's nodes take part in Operational Identity, read
 * set-wise for the node batch hard delete (`node-operations.ts`).
 *
 * A node takes part when an identity assertion of any state names it, or the
 * materialized closure holds a row for it. That is exactly the condition under
 * which a hard delete's identity detach (`detachIdentityForNode`) does more
 * than its early return: a node with neither has no assertion to delete and no
 * class to repair. The batch sends every participant through the single-node
 * hard-delete path, which runs that detach as the authority; this probe only
 * decides who may skip it. Answering "participates" for a node that does not
 * costs that node the single path, never correctness.
 */
import {
  identityChunkSize,
  type IdentityTarget,
  MAX_REFERENCE_CHUNK_SIZE,
} from "../../identity/sql-target";
import { type SqlSchema } from "../../query/compiler/schema";
import { sql } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { chunk } from "../../utils/array";

/**
 * The binds the assertion probe spends besides its id list: the graph id and
 * the node kind once per assertion endpoint. It binds the id list twice; the
 * closure probe binds fewer, so both fit one chunk.
 */
const ASSERTION_PROBE_FIXED_PARAMETERS = 3;

/**
 * The ids, among `ids` of `kind`, that an identity assertion names or the
 * closure holds a row for. Two statements per chunk of ids, whatever the
 * chunk's size.
 */
export async function readIdentityParticipants(
  ctx: Readonly<{ graphId: string; schema: SqlSchema }>,
  target: IdentityTarget,
  kind: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const participants = new Set<string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return participants;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: ASSERTION_PROBE_FIXED_PARAMETERS,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  for (const idChunk of chunk(unique, chunkSize)) {
    const idList = sql.join(
      idChunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const asserted = await target.execute<
      Readonly<{ a_kind: string; a_id: string; b_kind: string; b_id: string }>
    >(
      asCompiledRowsSql(sql`
        SELECT a_kind, a_id, b_kind, b_id
        FROM ${ctx.schema.identityAssertionsTable}
        WHERE graph_id = ${ctx.graphId}
          AND (
            (a_kind = ${kind} AND a_id IN (${idList}))
            OR (b_kind = ${kind} AND b_id IN (${idList}))
          )
      `),
    );
    for (const row of asserted) {
      if (row.a_kind === kind) participants.add(row.a_id);
      if (row.b_kind === kind) participants.add(row.b_id);
    }
    const materialized = await target.execute<Readonly<{ member_id: string }>>(
      asCompiledRowsSql(sql`
        SELECT member_id
        FROM ${ctx.schema.identityClosureTable}
        WHERE graph_id = ${ctx.graphId}
          AND member_kind = ${kind}
          AND member_id IN (${idList})
      `),
    );
    for (const row of materialized) participants.add(row.member_id);
  }
  return new Set(unique.filter((id) => participants.has(id)));
}

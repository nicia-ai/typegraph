/**
 * The recorded evidence that ties a node reference to the identity classes it
 * has ever belonged to, read from the recorded relations rather than from the
 * current closure.
 *
 * The current closure can only name the class a reference belongs to NOW. A
 * member that left its class (a delete, a retraction, a closed window) is a
 * singleton there, and no transition note names a non-canonical member, so the
 * closure alone cannot lead a lineage walk back to the class it left. What
 * still names it is the evidence that put it in the class: every `same`
 * assertion version that ever had it as an endpoint, and every node version
 * that ever shared its id under a folding graph. A class canonical is always a
 * member of the class, and class members are always connected through that
 * evidence, so the references reachable through it are a superset of every
 * canonical the reference's classes ever carried.
 */
import { type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { referenceCondition } from "./service-read";
import {
  identityChunkSize,
  type IdentityTarget,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityRelation } from "./types";

const SAME_RELATION = "same" satisfies IdentityRelation;

type RawAssertionEndpointsRow = Readonly<{
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
}>;

type RawNodeReferenceRow = Readonly<{ kind: string; id: string }>;

/**
 * Both endpoints of every `same` assertion version — current, ended, retracted
 * or deleted — that ever named one of `references`.
 */
async function readEverAssertedSameEndpoints(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<readonly PlainNodeRef[]> {
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 2,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 4,
  });
  const endpoints: PlainNodeRef[] = [];
  for (const referenceChunk of chunk(references, chunkSize)) {
    const rows = await target.execute<RawAssertionEndpointsRow>(
      asCompiledRowsSql(sql`
        SELECT DISTINCT a_kind, a_id, b_kind, b_id
        FROM ${schema.recordedIdentityAssertionsTable}
        WHERE graph_id = ${graphId}
          AND rel = ${SAME_RELATION}
          AND (
            ${referenceCondition(sql`a_kind`, sql`a_id`, referenceChunk)}
            OR ${referenceCondition(sql`b_kind`, sql`b_id`, referenceChunk)}
          )
      `),
    );
    for (const row of rows) {
      endpoints.push(
        { kind: row.a_kind, id: row.a_id },
        { kind: row.b_kind, id: row.b_id },
      );
    }
  }
  return endpoints;
}

/** Every node version that ever shared an id with one of `references`, whatever its kind. */
async function readEverRecordedSameIdReferences(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<readonly PlainNodeRef[]> {
  const ids = [...new Set(references.map((ref) => ref.id))];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 1,
  });
  const sameId: PlainNodeRef[] = [];
  for (const idChunk of chunk(ids, chunkSize)) {
    const idList = sql.join(
      idChunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await target.execute<RawNodeReferenceRow>(
      asCompiledRowsSql(sql`
        SELECT DISTINCT kind, id
        FROM ${schema.recordedNodesTable}
        WHERE graph_id = ${graphId} AND id IN (${idList})
      `),
    );
    for (const row of rows) sameId.push({ kind: row.kind, id: row.id });
  }
  return sameId;
}

/**
 * The references one evidence hop away from `references`: the other endpoint of
 * every `same` assertion that ever named one, and — under a folding graph —
 * every node that ever shared an id with one. The caller iterates this to a
 * fixed point.
 */
export async function readIdentityEvidenceNeighbours(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
  sameIdAcrossKinds: "fold" | "ignore",
): Promise<readonly PlainNodeRef[]> {
  if (references.length === 0) return [];
  const asserted = await readEverAssertedSameEndpoints(
    target,
    schema,
    graphId,
    references,
  );
  if (sameIdAcrossKinds === "ignore") return asserted;
  const folded = await readEverRecordedSameIdReferences(
    target,
    schema,
    graphId,
    references,
  );
  return [...asserted, ...folded];
}

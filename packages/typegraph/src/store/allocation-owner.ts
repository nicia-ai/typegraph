import { runRetriedUnit } from "../backend/capabilities/retried-unit";
import { type GraphBackend } from "../backend/types";
import {
  assertGraphAllocationOwner,
  type GraphAllocationOwner,
} from "../core/allocation-owner";
import { recordedAnchorsTable, type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { generateId } from "../utils/id";
import { lockSchemaVersionForStoreWrite } from "./operations/write-transaction";
import { recordedAnchorOwner } from "./recorded-anchor-origin";
import {
  lockRecordedGraphWrite,
  readRevisionOrigin,
  withRecordedRelationsPrecondition,
} from "./recorded-capture";
import { executeStatement } from "./recorded-capture/guards";

export async function readGraphAllocationOwner(
  target: Pick<GraphBackend, "execute">,
  schema: SqlSchema,
  graphId: string,
): Promise<GraphAllocationOwner | undefined> {
  const origin = await readRevisionOrigin(target, schema, graphId);
  return origin === undefined ? undefined : recordedAnchorOwner(schema, origin);
}

/** Explicit fork lifecycle operation. It preserves data, clock, and captured history. */
export async function rotateGraphAllocationOwner(
  backend: GraphBackend,
  schema: SqlSchema,
  graphId: string,
  schemaVersion: number | undefined,
  expectedOwner: GraphAllocationOwner,
): Promise<GraphAllocationOwner> {
  return withRecordedRelationsPrecondition(
    runRetriedUnit(
      { target: backend, operation: "rotateGraphAllocationOwner", attempts: 3 },
      () =>
        backend.transaction(async (target) => {
          await lockSchemaVersionForStoreWrite(
            { graphId, schemaVersion },
            target,
          );
          await lockRecordedGraphWrite(target, graphId);
          const previous = await readGraphAllocationOwner(
            target,
            schema,
            graphId,
          );
          assertGraphAllocationOwner(expectedOwner, previous, { graphId });
          const origin = generateId();
          await executeStatement(
            target,
            sql`UPDATE ${schema.revisionOriginsTable} SET origin=${origin} WHERE graph_id=${graphId} AND origin=${expectedOwner.origin}`,
          );
          const owner = await recordedAnchorOwner(schema, origin);
          assertGraphAllocationOwner(
            owner,
            await readGraphAllocationOwner(target, schema, graphId),
            { graphId },
          );
          if (backend.capabilities.recordedAnchorLookup === true)
            await executeStatement(
              target,
              sql`UPDATE ${recordedAnchorsTable(schema)} SET origin=${origin} WHERE graph_id=${graphId} AND origin=${expectedOwner.origin}`,
            );
          // Durable operation evidence is deliberately not rebound: a fork cannot replay its parent's caller keys.
          return owner;
        }),
    ),
    { dialect: backend.dialect, surface: "rotate-allocation-owner" },
  );
}

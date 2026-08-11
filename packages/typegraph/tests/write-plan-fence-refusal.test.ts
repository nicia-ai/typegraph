/**
 * A FENCE THE STATEMENT CANNOT CARRY IS REFUSED, NOT DROPPED — invariant I6(b).
 *
 * `reviseNodeSet` is the one write shape whose statement has no field for the
 * fence its record declares: `UpdateNodeSetParams` has no `expectedValidFrom`,
 * while `ValidityLowerBoundFence` legitimately carries one. So the call below
 * is TYPE-LEGAL and CAST-FREE — the key is required and the value is a legal
 * fence — and it is exactly the shape a future windowed set update would
 * write. Its two possible fates are "applied" and "refused"; "accepted, then
 * quietly not asserted" is the one this file exists to make unreachable,
 * because a write that silently drops the bound its verdict read lands on a
 * row it was never computed for and reports success.
 *
 * The statement counter is what separates a refusal from a rollback: the
 * throw aborts the transaction either way, so "the row still says Alice" is
 * true even if the UPDATE ran. `updateNodeSet` never being CALLED is the
 * property under test.
 *
 * Named mutation: replace the `throw` in `NODE_SET_UPDATE_FENCE_APPLIERS`
 * (`write-fences.ts`) with a `return` → the refusal case fails twice over,
 * once because nothing is thrown and once because the set UPDATE is emitted.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
  rowPropsToObject,
  type TransactionBackend,
} from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledSelectSql } from "../src/query/sql-intent";
import { buildKindRegistry } from "../src/registry";
import {
  runWritePlan,
  type WritePlanContext,
} from "../src/store/operations/write-executor";
import { UnsupportedWriteFenceError } from "../src/store/operations/write-fences";
import { nodeWritePlan } from "../src/store/operations/write-plan";
import { type WriteSession } from "../src/store/operations/write-session";
import { requireDefined } from "../src/utils/presence";

const GRAPH_ID = "write_plan_fence_refusal";
const NODE_ID = "person-a";
const STATED_BOUND = "2024-01-01T00:00:00.000Z";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
});

const registry = buildKindRegistry(graph);

function writeContext(): WritePlanContext {
  return {
    graphId: GRAPH_ID,
    registry,
    schemaVersion: undefined,
    historyEnabled: false,
    revisionTrackingEnabled: false,
    revisionSchema: createSqlSchema(),
  };
}

interface SetUpdateCounts {
  updateNodeSet: number;
}

/**
 * Counts `updateNodeSet` on the backend AND on the transaction target it hands
 * out — the session runs inside the write transaction, so counting only the
 * outer object would see nothing.
 */
function withSetUpdateCount(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  counts: SetUpdateCounts;
}> {
  const counts: SetUpdateCounts = { updateNodeSet: 0 };

  function wrap<T extends GraphBackend | TransactionBackend>(target: T): T {
    // Called unbound: the drizzle backends build their members as closures
    // over the factory's state, so none of them reads `this`.
    const original = requireDefined(target.updateNodeSet);
    // Derived, never spread: a fixture built by copying a backend is the #435
    // defect written into the double the store under test then runs against, and
    // the derivation seam is what carries the source's serialized-resource
    // verdict onto the wrapper.
    return deriveBackend(target, {
      updateNodeSet: (params) => {
        counts.updateNodeSet += 1;
        return original(params);
      },
    } as ExactBackendOverlay<T, Partial<T>>);
  }

  return {
    backend: deriveBackend(wrap(backend), {
      transaction: (fn, options) =>
        backend.transaction((target) => fn(wrap(target)), options),
    }),
    counts,
  };
}

/**
 * Every live `Person` of this graph — the work record the collection API's
 * `updateWhere` compiles, spelled through the session's own parameter type so
 * the fixture cannot drift from the method under test.
 */
function setUpdateWork(
  backend: GraphBackend,
): Parameters<WriteSession["reviseNodeSet"]>[0] {
  return {
    kind: "Person",
    schema: Person.schema,
    uniqueConstraints: [],
    patch: { name: "Renamed" },
    unsetProperties: [],
    candidateIds: asCompiledSelectSql(sql`
      SELECT id AS n_id
      FROM ${createSqlSchema(backend.tableNames).nodesTable}
      WHERE graph_id = ${GRAPH_ID} AND kind = 'Person'
    `),
    candidateIdColumn: "n_id",
  };
}

async function seed(backend: GraphBackend): Promise<void> {
  await createStoreWithSchema(graph, backend);
  await backend.insertNode({
    graphId: GRAPH_ID,
    kind: "Person",
    id: NODE_ID,
    props: { name: "Alice" },
  });
}

async function propsOf(
  backend: GraphBackend,
): Promise<Record<string, unknown>> {
  const row = requireDefined(
    await backend.getNode(GRAPH_ID, "Person", NODE_ID),
  );
  return rowPropsToObject(row.props);
}

describe("a fence the row work's statement cannot carry", () => {
  it("is refused, naming the fence and the kind, with no set UPDATE emitted", async () => {
    const { backend: raw } = createLocalSqliteBackend();
    try {
      await seed(raw);
      const work = setUpdateWork(raw);
      const { backend, counts } = withSetUpdateCount(raw);

      const failure: unknown = await runWritePlan(
        writeContext(),
        nodeWritePlan(undefined, undefined),
        backend,
        (session) =>
          session.reviseNodeSet(work, {
            validityLowerBound: { expectedValidFrom: STATED_BOUND },
          }),
      ).catch((error: unknown) => error);

      if (!(failure instanceof UnsupportedWriteFenceError)) {
        throw new Error(`Expected a refusal, got: ${String(failure)}`);
      }
      expect(failure.fence).toBe("validityLowerBound");
      expect(failure.kind).toBe("nodeSetUpdate");
      // Refused BEFORE the row work, not rolled back after it.
      expect(counts.updateNodeSet).toBe(0);
      expect(await propsOf(raw)).toEqual({ name: "Alice" });
    } finally {
      await raw.close();
    }
  });

  it("runs the same write normally when it asserts nothing", async () => {
    const { backend: raw } = createLocalSqliteBackend();
    try {
      await seed(raw);
      const work = setUpdateWork(raw);
      const { backend, counts } = withSetUpdateCount(raw);

      const result = await runWritePlan(
        writeContext(),
        nodeWritePlan(undefined, undefined),
        backend,
        (session) => session.reviseNodeSet(work, { validityLowerBound: {} }),
      );

      expect(result).toEqual({ affectedCount: 1 });
      expect(counts.updateNodeSet).toBe(1);
      expect(await propsOf(raw)).toEqual({ name: "Renamed" });
    } finally {
      await raw.close();
    }
  });
});

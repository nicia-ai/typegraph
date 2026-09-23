/**
 * A standalone schema commit (`migrateSchema` with no Store driving it) takes
 * its recorded-capture decision from the database: a graph whose writes
 * TypeGraph captures gets its ledger pre-images and identity transition notes
 * recorded, and a graph it does not capture — including one whose revision
 * clock advances under `revisionTracking` alone — gets nothing recorded.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../src";
import { RECORDED_MAX_REVISION } from "../src/core/temporal";
import { readIdentityTransitions } from "../src/identity/transition-log";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { migrateSchema } from "../src/schema";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Tag = defineNode("Tag", {
  schema: z.object({ label: z.string() }),
});

const GRAPH_ID = "identity_standalone_migrate_capture";

const withTag = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person }, Tag: { type: Tag } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const withoutTag = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const withoutTagOrIdentity = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
});

type RecordedAssertionRow = Readonly<{ recorded_to: unknown }>;

async function recordedAssertionWindows(
  backend: GraphBackend,
  assertionId: string,
): Promise<readonly number[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<RecordedAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_to
      FROM ${schema.recordedIdentityAssertionsTable}
      WHERE graph_id = ${GRAPH_ID} AND id = ${assertionId}
    `),
  );
  return rows.map((row) => Number(row.recorded_to));
}

async function dropTagKind(
  backend: GraphBackend,
  target: typeof withoutTag | typeof withoutTagOrIdentity = withoutTag,
): Promise<void> {
  const active = requireDefined(await backend.getActiveSchema(GRAPH_ID));
  await migrateSchema(backend, target, active.version, {
    discardDroppedKindRows: true,
  });
}

async function kindDropHops(backend: GraphBackend): Promise<readonly string[]> {
  const rows = await readIdentityTransitions(
    backend,
    createSqlSchema(backend.tableNames),
    GRAPH_ID,
    {
      classRefs: [
        { kind: "Person", id: "p" },
        { kind: "Tag", id: "t" },
      ],
      limit: 50,
    },
  );
  return rows
    .filter((row) => row.cause === "kind-drop")
    .map((row) => `${row.class_kind}:${row.class_id} <- ${row.prior_class_id}`);
}

async function seedSameClass(
  backend: GraphBackend,
  options: Readonly<{ history: boolean; revisionTracking?: boolean }>,
): Promise<string> {
  const [store] = await createStoreWithSchema(withTag, backend, {
    history: options.history,
    ...(options.revisionTracking === true ? { revisionTracking: true } : {}),
  });
  const person = await store.nodes.Person.create({ name: "P" }, { id: "p" });
  const tag = await store.nodes.Tag.create({ label: "T" }, { id: "t" });
  const asserted = await store.identity.assertSame(person, tag);
  return asserted.assertion.id;
}

describe("standalone migrateSchema recorded capture", () => {
  // Load-bearing: the kind-drop cascade and closure rebuild run in a raw
  // schema-commit transaction no Store binds. Revert check: make the
  // `"database"` capture source never bind (skip `bindSchemaCommitCapture`'s
  // probe and return) and the assertion's recorded row stays open while the
  // kind-drop note is dropped.
  it("records ledger pre-images and kind-drop notes for a graph TypeGraph captures", async () => {
    const backend = createTestBackend();
    const assertionId = await seedSameClass(backend, { history: true });
    expect(await recordedAssertionWindows(backend, assertionId)).toEqual([
      RECORDED_MAX_REVISION,
    ]);

    await dropTagKind(backend);

    const windows = await recordedAssertionWindows(backend, assertionId);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toBeLessThan(RECORDED_MAX_REVISION);
    expect(await kindDropHops(backend)).toEqual(["Person:p <- p"]);
  });

  // The identity-disabled cascade (a commit that drops the kind while
  // switching identity off) takes the same capture decision: the ledger rows
  // it deletes still close their recorded rows.
  it("records the ledger pre-images of a kind drop that also disables identity", async () => {
    const backend = createTestBackend();
    const assertionId = await seedSameClass(backend, { history: true });

    await dropTagKind(backend, withoutTagOrIdentity);

    const windows = await recordedAssertionWindows(backend, assertionId);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toBeLessThan(RECORDED_MAX_REVISION);
  });

  // Load-bearing: the recorded clock is not capture evidence, since revision
  // tracking alone advances it. Revert check: make
  // `graphCapturesRecordedHistory` answer `true` and this commit writes a
  // recorded identity row and a kind-drop note into a graph that never
  // captured history.
  it("records nothing for a graph TypeGraph does not capture, even with revision tracking", async () => {
    const backend = createTestBackend();
    const assertionId = await seedSameClass(backend, {
      history: false,
      revisionTracking: true,
    });

    await dropTagKind(backend);

    expect(await recordedAssertionWindows(backend, assertionId)).toEqual([]);
    expect(await kindDropHops(backend)).toEqual([]);
  });
});

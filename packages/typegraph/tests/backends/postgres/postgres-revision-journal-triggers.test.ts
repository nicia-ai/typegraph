import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { createPostgresTables } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { createStoreWithSchema } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "mixed_case_revision_journal",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("PostgreSQL revision journal triggers", () => {
  it("provisions case-sensitive relation names with one shared trigger function", async () => {
    const tables = createPostgresTables({
      nodes: "MixedCaseNodes",
      edges: "MixedCaseEdges",
      identityAssertions: "MixedCaseIdentityAssertions",
      recordedClock: "MixedCaseRecordedClock",
      revisionChanges: "MixedCaseRevisionChanges",
    });
    const { backend, client } = await createLocalPgliteBackend({
      tables,
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      await requireDefined(backend.ensureRevisionChangesJournal)();
      expect(await requireDefined(backend.revisionChangesJournalReady)()).toBe(
        true,
      );

      const triggers = await client.query<{
        function_name: string;
        table_name: string;
      }>(`SELECT relation.relname AS table_name, function.proname AS function_name
          FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
          JOIN pg_proc AS function ON function.oid = trigger.tgfoid
          WHERE relation.relname IN ('MixedCaseNodes', 'MixedCaseEdges', 'MixedCaseIdentityAssertions')
            AND NOT trigger.tgisinternal`);
      expect(triggers.rows).toHaveLength(3);
      expect(triggers.rows.map((row) => row.table_name).toSorted()).toEqual([
        "MixedCaseEdges",
        "MixedCaseIdentityAssertions",
        "MixedCaseNodes",
      ]);
      expect(new Set(triggers.rows.map((row) => row.function_name))).toEqual(
        new Set(["typegraph_record_revision_change"]),
      );

      await store.nodes.Person.create({ name: "Ada" });
      const journal = await client.query<{ entity: string; kind: string }>(
        'SELECT entity, kind FROM "MixedCaseRevisionChanges"',
      );
      expect(journal.rows).toEqual([{ entity: "node", kind: "Person" }]);

      await client.exec(
        'ALTER TABLE "MixedCaseNodes" DISABLE TRIGGER "tg_rc_node_MixedCaseNodes"',
      );
      expect(await requireDefined(backend.revisionChangesJournalReady)()).toBe(
        false,
      );
    } finally {
      await backend.close();
    }
  });
});

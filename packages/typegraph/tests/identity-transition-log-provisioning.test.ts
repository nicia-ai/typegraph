/**
 * G1R2-01: the identity transition log's two relations have no provisioning
 * path for a database that predates them.
 *
 * `IDENTITY_TABLE_LOGICAL_NAMES` (identity-members.ts) and `IdentityTableNames`
 * (backend/types.ts) now name `identityTransitions` /
 * `identityTransitionRetention` alongside the four original identity
 * relations, and base-schema release 3 (`base-schema.ts`) provisions both
 * relations deployment-wide — regardless of whether any graph in the
 * database has Operational Identity enabled — the same way release 2 did
 * for the `fences` relation. Together they cover both places a pre-existing
 * database can be missing the transition log:
 *
 *  - an already identity-ENABLED graph reopened against a database whose
 *    physical schema predates this release (base-schema self-heals it
 *    before the identity preflight ever runs), and
 *  - identity's own FIRST enablement on an existing populated database
 *    (the enablement preflight's `ensureIdentityTables` now provisions all
 *    six identity relations together).
 *
 * Before the fix, both paths died with a raw `SqliteError: no such table:
 * typegraph_identity_transitions`, surfaced as `history: true requires the
 * recorded-time relations to exist` from `flushIdentityTransitions`.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";
import { readIdentityTransitions } from "../src/identity/transition-log";
import { storeRuntime } from "../src/store/runtime-port";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

const GRAPH_ID = "identity_transition_log_provisioning";

/** Identity already enabled — the shape a graph has BEFORE this release. */
const enabledGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/** Identity-disabled — the "already deployed" shape for the enablement case. */
const disabledGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
});

// Alphabetical order, matching `ORDER BY name` in `transitionLogTableNames`
// below (`_retention` sorts before the bare `s` of `transitions`).
const TRANSITION_LOG_TABLES = [
  "typegraph_identity_transition_retention",
  "typegraph_identity_transitions",
] as const;

/** Every ORIGINAL (pre-transition-log) identity relation, plus the two new ones. */
const ALL_IDENTITY_TABLES = [
  "typegraph_identity_assertions",
  "typegraph_recorded_identity_assertions",
  "typegraph_identity_closure",
  ...TRANSITION_LOG_TABLES,
] as const;

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  return (result.db as unknown as { $client: Database.Database }).$client;
}

function dropTables(
  result: LocalSqliteBackendResult,
  tables: readonly string[],
): void {
  for (const table of tables) {
    rawClient(result).exec(`DROP TABLE IF EXISTS "${table}"`);
  }
}

function transitionLogTableNames(
  result: LocalSqliteBackendResult,
): readonly string[] {
  const rows = rawClient(result)
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name`,
    )
    .all(...TRANSITION_LOG_TABLES) as { name: string }[];
  return rows.map((row) => row.name);
}

describe("identity transition log provisioning", () => {
  it("self-heals the transition log on an already-enabled graph whose database predates it", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        {
          history: true,
        },
      );
      // Fold a same-id pair so the write path actually exercises
      // `flushIdentityTransitions`, not just schema provisioning.
      await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
      await store.nodes.Author.create({ penName: "A." }, { id: "alice" });

      // Simulate a deployment created by a release before the transition log
      // shipped: its physical schema never had these two relations, even
      // though identity itself is already committed and populated. The
      // base-schema marker must be rolled back too — a real pre-existing
      // installation would never have been stamped at the current version
      // in the first place, and base-schema adoption is a NO-OP once the
      // marker already reads "current".
      dropTables(result, TRANSITION_LOG_TABLES);
      rawClient(result).exec(
        `UPDATE typegraph_base_schema_versions SET version = 2 WHERE installation = 1`,
      );
      expect(transitionLogTableNames(result)).toEqual([]);

      // Reopening the SAME (already-enabled) graph must self-heal the
      // missing relations via base-schema adoption before the identity
      // preflight runs, rather than surfacing a raw "no such table" error
      // out of `flushIdentityTransitions` the next time a fold happens.
      const [reopened] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        { history: true },
      );
      expect(transitionLogTableNames(result)).toEqual([
        ...TRANSITION_LOG_TABLES,
      ]);

      await reopened.nodes.Person.create({ name: "Bob" }, { id: "bob" });
      await expect(
        reopened.nodes.Author.create({ penName: "B." }, { id: "bob" }),
      ).resolves.toBeDefined();

      const ctx = storeRuntime(reopened).identityContext();
      const rows = await readIdentityTransitions(
        ctx.backend,
        ctx.schema,
        GRAPH_ID,
        {
          classRefs: [
            { kind: "Person", id: "bob" },
            { kind: "Author", id: "bob" },
          ],
          limit: 10,
        },
      );
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await result.backend.close();
    }
  });

  it("provisions the transition log on first enablement of an existing populated database", async () => {
    const result = createLocalSqliteBackend();
    try {
      // 1. Deploy the identity-disabled schema and populate a same-id pair
      //    across kinds (alice as both Person and Author) — the fold target
      //    for enablement.
      const [disabledStore] = await createStoreWithSchema(
        disabledGraph,
        result.backend,
      );
      await disabledStore.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      await disabledStore.nodes.Author.create(
        { penName: "A." },
        { id: "alice" },
      );

      // 2. Simulate a deployment whose identity relations — original AND
      //    transition-log — were never created (bring-your-own-connection:
      //    no DDL re-run) by dropping every one of them.
      dropTables(result, ALL_IDENTITY_TABLES);

      // 3. Reopen with the identity-enabled graph under history:true.
      //    Enablement must provision all SIX identity relations together —
      //    including the transition log — not just the original four.
      const [enabledStore, migration] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        { history: true },
      );
      expect(migration.status).toBe("migrated");
      expect(transitionLogTableNames(result)).toEqual([
        ...TRANSITION_LOG_TABLES,
      ]);

      const members = await enabledStore.identity.membersOf({
        kind: "Person",
        id: "alice",
      });
      expect(members).toHaveLength(2);

      // Whether enablement itself notes a `schema-transition` transition is
      // G1R2-02's separate concern (tests/identity-transition-log.test.ts);
      // this test only pins that the relations exist and the write path
      // (exercised here by an ordinary post-enablement fold) does not throw.
      await enabledStore.nodes.Person.create(
        { name: "Carol" },
        { id: "carol" },
      );
      await expect(
        enabledStore.nodes.Author.create({ penName: "C." }, { id: "carol" }),
      ).resolves.toBeDefined();
    } finally {
      await result.backend.close();
    }
  });
});

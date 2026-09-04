/**
 * `assertFulltextMember` — the write-path invariant that fires once
 * `resolveBackendFulltext` has already confirmed a backend declares
 * fulltext support.
 *
 * A backend that declares `capabilities.fulltext` but omits one of the
 * CRUD members is not making an availability statement — it is violating
 * the fulltext contract, and `syncFulltext` (the create/update path) must
 * surface that as a `ConfigurationError` naming the missing member, never
 * as the "unsupported capability" refusal a fulltext-off backend gets.
 *
 * The fixture below uses `executionProfile: { transactionMode: "none" }`
 * so `runOptionallyInTransaction` runs the write directly against the
 * exact backend object this test builds (the "sequential" fallback in
 * `src/backend/types.ts`) rather than against a transaction-scoped backend
 * freshly synthesized from the underlying engine profile — a real
 * interactive-transaction write always re-derives its transaction backend
 * from the closed-over fulltext strategy, which would silently heal the
 * `projectBackendWithout` omission below before `syncFulltext` ever saw it.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../src";
import { projectBackendWithout } from "../src/backend/derive-backend";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend, tables } from "../src/backend/drizzle/sqlite";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../src/errors";
import { createStore } from "../src/store";

const Document = defineNode("Document", {
  schema: z.object({ title: searchable() }),
});
const SearchableGraph = defineGraph({
  id: "fulltext-member-contract",
  nodes: { Document: { type: Document } },
  edges: {},
});

describe("assertFulltextMember on the write path", () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("throws ConfigurationError naming the missing member when capabilities.fulltext is declared but upsertFulltext is absent, not UnsupportedBackendCapabilityError", async () => {
    sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL(tables)) {
      sqlite.exec(statement);
    }
    const base = createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true, transactionMode: "none" },
      tables,
    });
    expect(base.capabilities.fulltext).toBeDefined();
    expect(base.capabilities.execution.interactiveTransactions).toBe(false);

    const missingUpsert = projectBackendWithout(base, ["upsertFulltext"]);
    expect(missingUpsert.capabilities.fulltext).toBeDefined();
    expect(Reflect.get(missingUpsert, "upsertFulltext")).toBeUndefined();

    const store = createStore(SearchableGraph, missingUpsert);

    const attempt = store.nodes.Document.create({ title: "hello world" });

    await expect(attempt).rejects.toBeInstanceOf(ConfigurationError);
    await expect(attempt).rejects.not.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: {
        capability: "fulltext",
        missingMember: "upsertFulltext",
      },
    });
  });
});

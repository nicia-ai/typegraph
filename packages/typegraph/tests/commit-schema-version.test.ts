/**
 * Tests for the `commitSchemaVersion` and `setActiveVersion` backend
 * primitives — the atomic insert-and-activate path that replaces the
 * unwrapped `insertSchema` + `setActiveSchema` pair.
 *
 * Covered scenarios:
 *   - Orphan-row reactivation (the original bug fix): an inactive row
 *     left from a crashed earlier commit gets activated cleanly on retry.
 *   - Same-hash idempotency (already active): re-running the same
 *     commit returns the existing row without error.
 *   - CAS guard: stale `expected.version` produces `StaleVersionError`
 *     with the correct `actual` value populated.
 *   - Initial-commit race: two callers both passing `{ kind: "initial" }`
 *     resolve to the same active row (idempotent) when the schemas match,
 *     and to `StaleVersionError` when they don't.
 *   - Content conflict: same version, different hash → `SchemaContentConflictError`.
 *   - Partial unique index: enforced at the storage layer.
 *   - `setActiveVersion`: CAS guard + missing-target error path + rollback
 *     happy path.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  type GraphBackend,
  MigrationError,
  SchemaContentConflictError,
  StaleVersionError,
} from "../src";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import { createTestBackend, createTestDatabase } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Place = defineNode("Place", {
  schema: z.object({ city: z.string() }),
});

function makeGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

function makeDivergentGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person }, Place: { type: Place } },
    edges: {},
  });
}

async function buildCommitArguments(
  graphId: string,
  version: number,
  graph = makeGraph(graphId),
) {
  const schema = serializeSchema(graph, version);
  return {
    schemaDoc: schema,
    schemaHash: await computeSchemaHash(schema),
  };
}

describe("commitSchemaVersion: initial commit", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("inserts version 1 active when expected is initial", async () => {
    const { schemaDoc, schemaHash } = await buildCommitArguments("g", 1);
    const row = await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash,
      schemaDoc,
    });

    expect(row.version).toBe(1);
    expect(row.is_active).toBe(true);
    expect(row.schema_hash).toBe(schemaHash);
  });

  it("is idempotent on re-run with the same hash", async () => {
    const { schemaDoc, schemaHash } = await buildCommitArguments("g", 1);
    const first = await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash,
      schemaDoc,
    });
    const second = await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash,
      schemaDoc,
    });

    // Same row, no errors. Idempotency lets two boot processes race
    // through initial setup with the same compile-time graph.
    expect(second.version).toBe(first.version);
    expect(second.schema_hash).toBe(first.schema_hash);
    expect(second.is_active).toBe(true);
  });

  it("throws StaleVersionError when expected initial but the target version is fresh and another version is active", async () => {
    // First writer initializes at v=1.
    const v1 = await buildCommitArguments("g", 1);
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash: v1.schemaHash,
      schemaDoc: v1.schemaDoc,
    });

    // A second writer with stale code tries to initialize at v=2
    // (claiming "initial" — i.e. it believes nothing is active yet).
    // No row exists at v=2 so the same-version-conflict path doesn't
    // fire; the CAS branch correctly surfaces it as stale.
    const v2 = await buildCommitArguments("g", 2, makeDivergentGraph("g"));
    let captured: unknown;
    try {
      await backend.commitSchemaVersion({
        graphId: "g",
        expected: { kind: "initial" },
        version: 2,
        schemaHash: v2.schemaHash,
        schemaDoc: v2.schemaDoc,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(StaleVersionError);
    expect((captured as StaleVersionError).details.expected).toBe(0);
    expect((captured as StaleVersionError).details.actual).toBe(1);
  });

  it("returns SchemaContentConflictError when two writers race initial with different schemas", async () => {
    // The other half of the initial-commit race: same target version,
    // different hashes. This is a content disagreement, not a stale
    // read — different recovery action, different error type.
    const a = await buildCommitArguments("g", 1);
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash: a.schemaHash,
      schemaDoc: a.schemaDoc,
    });

    const b = await buildCommitArguments("g", 1, makeDivergentGraph("g"));
    await expect(
      backend.commitSchemaVersion({
        graphId: "g",
        expected: { kind: "initial" },
        version: 1,
        schemaHash: b.schemaHash,
        schemaDoc: b.schemaDoc,
      }),
    ).rejects.toThrow(SchemaContentConflictError);
  });
});

describe("commitSchemaVersion: successor commit (CAS guard)", () => {
  let backend: GraphBackend;

  beforeEach(async () => {
    backend = createTestBackend();
    const init = await buildCommitArguments("g", 1);
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash: init.schemaHash,
      schemaDoc: init.schemaDoc,
    });
  });

  it("commits v2 atomically and deactivates v1", async () => {
    const next = await buildCommitArguments("g", 2, makeDivergentGraph("g"));
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: next.schemaHash,
      schemaDoc: next.schemaDoc,
    });

    const v1 = await backend.getSchemaVersion("g", 1);
    const v2 = await backend.getSchemaVersion("g", 2);
    expect(v1!.is_active).toBe(false);
    expect(v2!.is_active).toBe(true);

    const active = await backend.getActiveSchema("g");
    expect(active!.version).toBe(2);
  });

  it("throws StaleVersionError with correct actual when expected is stale", async () => {
    // Simulate another writer having already advanced to v2.
    const next = await buildCommitArguments("g", 2, makeDivergentGraph("g"));
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: next.schemaHash,
      schemaDoc: next.schemaDoc,
    });

    // Now a stale caller tries to commit v3 against expected=v1.
    // No row exists at v3, so the conflict-check short-circuit doesn't
    // fire and the CAS branch surfaces the stale read with the actual
    // version (2) populated.
    const stale = await buildCommitArguments("g", 3);
    let captured: unknown;
    try {
      await backend.commitSchemaVersion({
        graphId: "g",
        expected: { kind: "active", version: 1 },
        version: 3,
        schemaHash: stale.schemaHash,
        schemaDoc: stale.schemaDoc,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(StaleVersionError);
    const error = captured as StaleVersionError;
    expect(error.details.expected).toBe(1);
    expect(error.details.actual).toBe(2);
    expect(error.details.graphId).toBe("g");
  });

  it("reactivates an orphan inactive row left by a crashed prior commit", async () => {
    // Reach into the underlying SQLite instance to simulate the crash:
    // we already have v1 active, but the *previous* migration to v2
    // crashed after the insert and before the activate, leaving v2 as
    // an inactive orphan. The retry path should reactivate it cleanly.
    const db = createTestDatabase();
    // Create a fresh backend on top of the shared db so the test can
    // both seed the orphan and exercise the primitive against the same
    // storage. createTestDatabase already creates the DDL.
    const orphanBackend = createSqliteBackend(db);

    const init = await buildCommitArguments("orphan_g", 1);
    await orphanBackend.commitSchemaVersion({
      graphId: "orphan_g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash: init.schemaHash,
      schemaDoc: init.schemaDoc,
    });

    // Inject an orphan inactive v2 row. Mirrors the post-crash state:
    // insertSchema(v=2, isActive=false) succeeded, setActiveSchema never ran.
    const orphan = await buildCommitArguments(
      "orphan_g",
      2,
      makeDivergentGraph("orphan_g"),
    );
    db.run(sql`
      INSERT INTO typegraph_schema_versions
        (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      VALUES (
        'orphan_g', 2, ${orphan.schemaHash},
        ${JSON.stringify(orphan.schemaDoc)},
        '2026-01-01T00:00:00.000Z', 0
      )
    `);

    // Retry the same commit. The new primitive detects the orphan
    // (same hash, inactive) and activates it without trying to insert
    // again — the bug that this issue fixes.
    const reactivated = await orphanBackend.commitSchemaVersion({
      graphId: "orphan_g",
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: orphan.schemaHash,
      schemaDoc: orphan.schemaDoc,
    });
    expect(reactivated.version).toBe(2);
    expect(reactivated.is_active).toBe(true);

    const active = await orphanBackend.getActiveSchema("orphan_g");
    expect(active!.version).toBe(2);
    const v1 = await orphanBackend.getSchemaVersion("orphan_g", 1);
    expect(v1!.is_active).toBe(false);
  });

  it("throws SchemaContentConflictError when target version exists with a different hash", async () => {
    // Commit v2 with one schema...
    const a = await buildCommitArguments("g", 2, makeDivergentGraph("g"));
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: a.schemaHash,
      schemaDoc: a.schemaDoc,
    });

    // ...then re-attempt v2 with a *different* hash. Same-version
    // conflict is not a stale-read race — it's a content disagreement
    // that needs operator intervention, so it gets its own error type.
    const conflicting = await buildCommitArguments("g", 2);
    let captured: unknown;
    try {
      await backend.commitSchemaVersion({
        graphId: "g",
        expected: { kind: "active", version: 2 },
        version: 2,
        schemaHash: conflicting.schemaHash,
        schemaDoc: conflicting.schemaDoc,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(SchemaContentConflictError);
    const error = captured as SchemaContentConflictError;
    expect(error.details.version).toBe(2);
    expect(error.details.existingHash).toBe(a.schemaHash);
    expect(error.details.incomingHash).toBe(conflicting.schemaHash);
  });
});

describe("partial unique index: at most one active version per graph", () => {
  it("the storage layer rejects a second is_active=TRUE row on the same graph", () => {
    const db = createTestDatabase();
    // Seed two rows by raw DDL, both is_active=true. The partial unique
    // index should refuse the second insert.
    db.run(sql`
      INSERT INTO typegraph_schema_versions
        (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      VALUES ('dup_g', 1, 'h1', '{}', 't', 1)
    `);

    let captured: unknown;
    try {
      db.run(sql`
        INSERT INTO typegraph_schema_versions
          (graph_id, version, schema_hash, schema_doc, created_at, is_active)
        VALUES ('dup_g', 2, 'h2', '{}', 't', 1)
      `);
    } catch (error) {
      captured = error;
    }
    // Drizzle wraps the SQLITE_CONSTRAINT_UNIQUE error; assert via the
    // cause chain rather than the wrapper's message.
    expect(captured).toBeInstanceOf(Error);
    const fullMessage = [
      (captured as Error).message,
      (captured as { cause?: { message?: string } }).cause?.message ?? "",
    ].join("\n");
    expect(fullMessage).toMatch(/UNIQUE/i);
  });

  it("allows multiple inactive rows alongside a single active row", () => {
    const db = createTestDatabase();
    db.run(sql`
      INSERT INTO typegraph_schema_versions
        (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      VALUES ('multi_g', 1, 'h1', '{}', 't', 0)
    `);
    db.run(sql`
      INSERT INTO typegraph_schema_versions
        (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      VALUES ('multi_g', 2, 'h2', '{}', 't', 0)
    `);
    db.run(sql`
      INSERT INTO typegraph_schema_versions
        (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      VALUES ('multi_g', 3, 'h3', '{}', 't', 1)
    `);
    // No throw — three rows, only one with is_active=1.
  });
});

describe("setActiveVersion", () => {
  let backend: GraphBackend;

  beforeEach(async () => {
    backend = createTestBackend();
    const v1 = await buildCommitArguments("g", 1);
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "initial" },
      version: 1,
      schemaHash: v1.schemaHash,
      schemaDoc: v1.schemaDoc,
    });
    const v2 = await buildCommitArguments("g", 2, makeDivergentGraph("g"));
    await backend.commitSchemaVersion({
      graphId: "g",
      expected: { kind: "active", version: 1 },
      version: 2,
      schemaHash: v2.schemaHash,
      schemaDoc: v2.schemaDoc,
    });
  });

  it("flips the active pointer to a prior version with matching CAS", async () => {
    await backend.setActiveVersion({
      graphId: "g",
      expected: { kind: "active", version: 2 },
      version: 1,
    });

    const active = await backend.getActiveSchema("g");
    expect(active!.version).toBe(1);

    const v2 = await backend.getSchemaVersion("g", 2);
    expect(v2!.is_active).toBe(false);
  });

  it("throws StaleVersionError when expected does not match", async () => {
    let captured: unknown;
    try {
      await backend.setActiveVersion({
        graphId: "g",
        expected: { kind: "active", version: 99 },
        version: 1,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(StaleVersionError);
    expect((captured as StaleVersionError).details.actual).toBe(2);
  });

  it("throws MigrationError when target version does not exist", async () => {
    await expect(
      backend.setActiveVersion({
        graphId: "g",
        expected: { kind: "active", version: 2 },
        version: 99,
      }),
    ).rejects.toThrow(MigrationError);
  });
});

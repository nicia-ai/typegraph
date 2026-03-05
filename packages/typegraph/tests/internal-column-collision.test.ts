/**
 * Tests for issue #29: Duplicate column alias when node schema has a property
 * named the same as an internal typegraph_nodes column (e.g., "version").
 *
 * Verifies that user-defined schema properties with names matching internal
 * columns (version, created_at, etc.) are correctly distinguished from
 * system metadata in both the full-fetch and selective (optimized) query paths.
 *
 * @see https://github.com/nicia-ai/typegraph/issues/29
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { compileQuery } from "../src/query/compiler/index";
import {
  buildSelectiveFields,
  FieldAccessTracker,
} from "../src/query/execution/field-tracker";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Graph: node schema with "version" property (collides with internal column)
// ============================================================

const Skill = defineNode("Skill", {
  schema: z.object({
    name: z.string().min(1),
    version: z.number().int().positive(),
    lifecycle: z.enum(["draft", "active", "deprecated"]),
  }),
});

const requires = defineEdge("requires");

const testGraph = defineGraph({
  id: "collision_test",
  nodes: {
    Skill: { type: Skill },
  },
  edges: {
    requires: {
      type: requires,
      from: [Skill],
      to: [Skill],
      cardinality: "many",
    },
  },
});

describe("internal column name collision (issue #29)", () => {
  let backend: GraphBackend;
  let store: Store<typeof testGraph>;

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);
  });

  it("creates a node with a 'version' property", async () => {
    const skill = await store.nodes.Skill.create({
      name: "TypeScript",
      version: 3,
      lifecycle: "active",
    });

    expect(skill.id).toBeDefined();
    expect(skill.version).toBe(3);
    expect(skill.name).toBe("TypeScript");
  });

  it("queries node with 'version' property via select", async () => {
    await store.nodes.Skill.create({
      name: "TypeScript",
      version: 3,
      lifecycle: "active",
    });
    await store.nodes.Skill.create({
      name: "Rust",
      version: 1,
      lifecycle: "draft",
    });

    const results = await store
      .query()
      .from("Skill", "s")
      .select((c) => ({
        id: c.s.id,
        name: c.s.name,
        version: c.s.version,
        lifecycle: c.s.lifecycle,
        createdAt: c.s.meta.createdAt,
      }))
      .execute();

    expect(results).toHaveLength(2);

    const ts = results.find((r) => r.name === "TypeScript");
    expect(ts).toBeDefined();
    expect(ts!.version).toBe(3);
    expect(ts!.lifecycle).toBe("active");
    expect(ts!.createdAt).toBeDefined();

    const rust = results.find((r) => r.name === "Rust");
    expect(rust).toBeDefined();
    expect(rust!.version).toBe(1);
    expect(rust!.lifecycle).toBe("draft");
  });

  it("applies predicates to user 'version' property", async () => {
    await store.nodes.Skill.create({
      name: "TypeScript",
      version: 3,
      lifecycle: "active",
    });
    await store.nodes.Skill.create({
      name: "Rust",
      version: 1,
      lifecycle: "draft",
    });
    await store.nodes.Skill.create({
      name: "COBOL",
      version: 5,
      lifecycle: "deprecated",
    });

    const results = await store
      .query()
      .from("Skill", "s")
      .whereNode("s", (s) => s.lifecycle.neq("deprecated"))
      .select((c) => ({
        id: c.s.id,
        name: c.s.name,
        version: c.s.version,
        lifecycle: c.s.lifecycle,
      }))
      .execute();

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.lifecycle !== "deprecated")).toBe(true);
  });

  it("returns correct meta.version separate from user version prop", async () => {
    await store.nodes.Skill.create({
      name: "TypeScript",
      version: 42,
      lifecycle: "active",
    });

    const results = await store
      .query()
      .from("Skill", "s")
      .whereNode("s", (s) => s.name.eq("TypeScript"))
      .select((c) => ({
        userVersion: c.s.version,
        metaVersion: c.s.meta.version,
      }))
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0]!.userVersion).toBe(42);
    expect(results[0]!.metaVersion).toBe(1);
  });

  it("preserves distinction after update (meta.version increments)", async () => {
    const skill = await store.nodes.Skill.create({
      name: "TypeScript",
      version: 1,
      lifecycle: "draft",
    });

    await store.nodes.Skill.update(skill.id, {
      version: 2,
      lifecycle: "active",
    });

    const results = await store
      .query()
      .from("Skill", "s")
      .whereNode("s", (s) => s.name.eq("TypeScript"))
      .select((c) => ({
        userVersion: c.s.version,
        metaVersion: c.s.meta.version,
        lifecycle: c.s.lifecycle,
      }))
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0]!.userVersion).toBe(2);
    expect(results[0]!.lifecycle).toBe("active");
    expect(results[0]!.metaVersion).toBe(2);
  });

  it("generates unique outputNames for user props vs system fields", () => {
    const tracker = new FieldAccessTracker();
    tracker.record("s", "version", false);
    tracker.record("s", "meta.version", true);

    const fields = buildSelectiveFields(tracker.getAccessedFields());
    const outputNames = fields.map((f) => f.outputName);

    const uniqueNames = new Set(outputNames);
    expect(uniqueNames.size).toBe(outputNames.length);
  });

  it("generates no duplicate SQL aliases in full-fetch query", () => {
    const query = store
      .query()
      .from("Skill", "s")
      .whereNode("s", (s) => s.name.eq("TypeScript"))
      .select((c) => ({
        id: c.s.id,
        name: c.s.name,
        version: c.s.version,
        lifecycle: c.s.lifecycle,
        metaVersion: c.s.meta.version,
        createdAt: c.s.meta.createdAt,
      }));

    const { sql: sqlText } = query.toSQL();

    const aliasPattern = /AS\s+"([^"]+)"/g;
    const aliases: string[] = [];
    let match;
    while ((match = aliasPattern.exec(sqlText)) !== null) {
      aliases.push(match[1]!);
    }

    const duplicates = aliases.filter(
      (alias, index) => aliases.indexOf(alias) !== index,
    );
    expect(duplicates).toEqual([]);
  });

  it("generates no duplicate SQL aliases in selective query (both dialects)", () => {
    const query = store
      .query()
      .from("Skill", "s")
      .select((c) => ({
        id: c.s.id,
        name: c.s.name,
        version: c.s.version,
        lifecycle: c.s.lifecycle,
        metaVersion: c.s.meta.version,
        createdAt: c.s.meta.createdAt,
      }));

    const tracker = new FieldAccessTracker();
    tracker.record("s", "id", true);
    tracker.record("s", "kind", true);
    tracker.record("s", "name", false);
    tracker.record("s", "version", false);
    tracker.record("s", "lifecycle", false);
    tracker.record("s", "meta.version", true);
    tracker.record("s", "meta.createdAt", true);
    tracker.record("s", "meta.updatedAt", true);
    tracker.record("s", "meta.deletedAt", true);
    tracker.record("s", "meta.validFrom", true);
    tracker.record("s", "meta.validTo", true);

    const selectiveFields = buildSelectiveFields(tracker.getAccessedFields());
    const ast = { ...query.toAst(), selectiveFields };

    for (const dialect of ["sqlite", "postgres"] as const) {
      const compiled = compileQuery(ast, "collision_test", { dialect });
      const sqlText = backend.compileSql!(compiled).sql;

      const aliasPattern = /AS\s+"([^"]+)"/g;
      const aliases: string[] = [];
      let match;
      while ((match = aliasPattern.exec(sqlText)) !== null) {
        aliases.push(match[1]!);
      }

      const duplicates = aliases.filter(
        (alias, index) => aliases.indexOf(alias) !== index,
      );
      expect(duplicates, `duplicate aliases in ${dialect} SQL`).toEqual([]);
    }
  });

  it("orders by user version property correctly", async () => {
    await store.nodes.Skill.create({
      name: "A",
      version: 3,
      lifecycle: "active",
    });
    await store.nodes.Skill.create({
      name: "B",
      version: 1,
      lifecycle: "active",
    });
    await store.nodes.Skill.create({
      name: "C",
      version: 2,
      lifecycle: "active",
    });

    const results = await store
      .query()
      .from("Skill", "s")
      .select((c) => ({
        name: c.s.name,
        version: c.s.version,
      }))
      .orderBy("s", "version", "asc")
      .execute();

    expect(results).toHaveLength(3);
    expect(results[0]!.version).toBe(1);
    expect(results[1]!.version).toBe(2);
    expect(results[2]!.version).toBe(3);
  });
});

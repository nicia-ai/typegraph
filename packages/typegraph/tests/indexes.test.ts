import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineNode, type JsonPointer } from "../src";
import {
  generatePostgresDDL,
  generateSqliteDDL,
} from "../src/backend/drizzle/ddl";
import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import {
  andWhere,
  defineEdgeIndex,
  defineNodeIndex,
  generateIndexDDL,
  notWhere,
  orWhere,
} from "../src/indexes";

const Person = defineNode("Person", {
  schema: z.object({
    email: z.email(),
    name: z.string(),
    age: z.number().optional(),
    isActive: z.boolean().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

describe("indexes", () => {
  it("generates dialect-specific DDL for node indexes", () => {
    const emailIndex = defineNodeIndex(Person, { fields: ["email"] });

    const pg = generateIndexDDL(emailIndex, "postgres");
    expect(pg).toContain('ON "typegraph_nodes"');
    expect(pg).toContain('"graph_id"');
    expect(pg).toContain('"kind"');
    expect(pg).toContain(`ARRAY['email']`);

    const sqlite = generateIndexDDL(emailIndex, "sqlite");
    expect(sqlite).toContain('ON "typegraph_nodes"');
    expect(sqlite).toContain('"graph_id"');
    expect(sqlite).toContain('"kind"');
    expect(sqlite).toContain("json_extract");
    expect(sqlite).toContain("email");
  });

  it("supports partial WHERE clauses for props and system columns", () => {
    const activeEmail = defineNodeIndex(Person, {
      fields: ["email"],
      where: (w) => andWhere(w.deletedAt.isNull(), w.isActive.eq(true)),
    });

    const pg = generateIndexDDL(activeEmail, "postgres");
    expect(pg).toContain('"deleted_at" IS NULL');
    expect(pg).toContain("::boolean");

    const sqlite = generateIndexDDL(activeEmail, "sqlite");
    expect(sqlite).toContain('"deleted_at" IS NULL');
    expect(sqlite).toContain("json_extract");
  });

  it("integrates into Drizzle schema factories (postgres + sqlite)", () => {
    const emailIndex = defineNodeIndex(Person, { fields: ["email"] });
    const roleIndex = defineEdgeIndex(worksAt, {
      fields: ["role"],
      direction: "out",
    });

    const pgTables = createPostgresTables(
      {},
      { indexes: [emailIndex, roleIndex] },
    );
    const pgSql = generatePostgresDDL(pgTables).join("\n");
    expect(pgSql).toContain(`"${emailIndex.name}"`);
    expect(pgSql).toContain(`"${roleIndex.name}"`);

    const sqliteTables = createSqliteTables(
      {},
      { indexes: [emailIndex, roleIndex] },
    );
    const sqliteSql = generateSqliteDDL(sqliteTables).join("\n");
    expect(sqliteSql).toContain(`"${emailIndex.name}"`);
    expect(sqliteSql).toContain(`"${roleIndex.name}"`);
  });

  it("prefixes edge indexes with the traversal join key when direction is set", () => {
    const out = defineEdgeIndex(worksAt, {
      fields: ["role"],
      direction: "out",
    });
    const outSql = generateIndexDDL(out, "postgres");
    expect(outSql).toContain('"from_id"');
    expect(outSql).not.toContain('"to_id"');

    const in_ = defineEdgeIndex(worksAt, { fields: ["role"], direction: "in" });
    const inSql = generateIndexDDL(in_, "postgres");
    expect(inSql).toContain('"to_id"');
    expect(inSql).not.toContain('"from_id"');
  });

  it("supports nested JSON pointer index keys for scalar fields", () => {
    const Task = defineNode("Task", {
      schema: z.object({
        metadata: z.object({
          priority: z.number(),
        }),
      }),
    });

    const priorityIndex = defineNodeIndex(Task, {
      fields: [["metadata", "priority"] as const],
    });

    const pg = generateIndexDDL(priorityIndex, "postgres");
    expect(pg).toContain(`ARRAY['metadata', 'priority']`);

    const sqlite = generateIndexDDL(priorityIndex, "sqlite");
    expect(sqlite).toContain(`$."metadata"."priority"`);
  });

  it("compiles OR/NOT index predicates via the WHERE DSL", () => {
    const index = defineNodeIndex(Person, {
      fields: ["email"],
      where: (w) =>
        orWhere(w.deletedAt.isNull(), notWhere(w.isActive.isNotNull())),
    });

    const pg = generateIndexDDL(index, "postgres");
    expect(pg).toContain(" OR ");
    expect(pg).toContain("NOT");
  });

  it("supports covering fields in node indexes", () => {
    const emailIndex = defineNodeIndex(Person, {
      fields: ["email"],
      coveringFields: ["name"],
    });

    const pg = generateIndexDDL(emailIndex, "postgres");
    // Both email and name should be in the index keys
    expect(pg).toContain(`ARRAY['email']`);
    expect(pg).toContain(`ARRAY['name']`);

    const sqlite = generateIndexDDL(emailIndex, "sqlite");
    expect(sqlite).toContain(`$."email"`);
    expect(sqlite).toContain(`$."name"`);
  });

  it("supports covering fields in edge indexes", () => {
    const EdgeWithMeta = defineEdge("edgeWithMeta", {
      schema: z.object({
        role: z.string(),
        startDate: z.string(),
      }),
    });

    const roleIndex = defineEdgeIndex(EdgeWithMeta, {
      fields: ["role"],
      coveringFields: ["startDate"],
    });

    const pg = generateIndexDDL(roleIndex, "postgres");
    expect(pg).toContain(`ARRAY['role']`);
    expect(pg).toContain(`ARRAY['startDate']`);
  });

  it("throws when covering fields overlap with index fields", () => {
    expect(() => {
      defineNodeIndex(Person, {
        fields: ["email"],
        coveringFields: ["email"], // Same as index field - should error
      });
    }).toThrow(/must not overlap/);
  });

  it("throws when fields array is empty", () => {
    expect(() => {
      defineNodeIndex(Person, {
        fields: [],
      });
    }).toThrow(/must not be empty/);
  });

  it("throws for unknown fields in index definition", () => {
    expect(() => {
      defineNodeIndex(Person, {
        // @ts-expect-error Testing invalid field
        fields: ["nonexistent"],
      });
    }).toThrow(/Unknown field/);
  });

  it("throws for invalid JSON pointer strings in index fields", () => {
    expect(() => {
      defineNodeIndex(Person, {
        fields: ["/email~2" as unknown as JsonPointer],
      });
    }).toThrow(/Invalid JSON Pointer escape sequence/);
  });

  it("throws for non-indexable field types (embeddings)", () => {
    const NodeWithEmbedding = defineNode("NodeWithEmbedding", {
      schema: z.object({
        name: z.string(),
        embedding: z.array(z.number()),
      }),
    });

    expect(() => {
      defineNodeIndex(NodeWithEmbedding, {
        // This is valid at type level but throws at runtime for array fields
        fields: ["embedding"],
      });
    }).toThrow(/Cannot create btree props index/);
  });

  it("generates dialect-specific boolean literals in WHERE clauses", () => {
    const activeIndex = defineNodeIndex(Person, {
      fields: ["email"],
      where: (w) => w.isActive.eq(true),
    });

    const pg = generateIndexDDL(activeIndex, "postgres");
    expect(pg).toContain("TRUE");

    const sqlite = generateIndexDDL(activeIndex, "sqlite");
    expect(sqlite).toContain("1");
  });

  it("supports scope variations for node indexes", () => {
    const graphOnly = defineNodeIndex(Person, {
      fields: ["email"],
      scope: "graph",
    });
    const graphOnlyDDL = generateIndexDDL(graphOnly, "postgres");
    expect(graphOnlyDDL).toContain('"graph_id"');
    expect(graphOnlyDDL).not.toContain('"kind"');

    const noScope = defineNodeIndex(Person, {
      fields: ["email"],
      scope: "none",
    });
    const noScopeDDL = generateIndexDDL(noScope, "postgres");
    expect(noScopeDDL).not.toContain('"graph_id"');
    expect(noScopeDDL).not.toContain('"kind"');
  });

  it("generates unique index when configured", () => {
    const uniqueEmail = defineNodeIndex(Person, {
      fields: ["email"],
      unique: true,
    });

    const pg = generateIndexDDL(uniqueEmail, "postgres");
    expect(pg).toContain("CREATE UNIQUE INDEX");

    const sqlite = generateIndexDDL(uniqueEmail, "sqlite");
    expect(sqlite).toContain("CREATE UNIQUE INDEX");
  });

  it("respects ifNotExists option in DDL generation", () => {
    const emailIndex = defineNodeIndex(Person, { fields: ["email"] });

    const withIfNotExists = generateIndexDDL(emailIndex, "postgres", {
      ifNotExists: true,
    });
    expect(withIfNotExists).toContain("IF NOT EXISTS");

    const withoutIfNotExists = generateIndexDDL(emailIndex, "postgres", {
      ifNotExists: false,
    });
    expect(withoutIfNotExists).not.toContain("IF NOT EXISTS");
  });

  it("escapes special characters in identifiers", () => {
    // Test that identifiers with special characters are properly quoted
    const index = defineNodeIndex(Person, {
      fields: ["email"],
      name: 'idx_with"quote',
    });

    const pg = generateIndexDDL(index, "postgres");
    // Double quotes should be escaped by doubling
    expect(pg).toContain('"idx_with""quote"');
  });
});

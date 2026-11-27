/**
 * The `dateIndexExpressions` gate on the paths that do not go through a
 * store (#927): the bundled PostgreSQL Drizzle schema factory, whose index
 * extras drizzle-kit turns into DDL, and a custom backend's capability
 * declaration. The store path (`materializeIndexes()`) is covered on every
 * backend by `tests/backends/integration/date-index-expressions.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { assertDateIndexExpressionsSupported } from "../src/backend/capabilities/date-index-expressions";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import {
  POSTGRES_CAPABILITIES,
  SQLITE_CAPABILITIES,
} from "../src/backend/types";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../src/errors";
import {
  defineEdgeIndex,
  defineNodeIndex,
  generateEdgeIndexDDL,
  generateIndexDDL,
  generateNodeIndexDDL,
} from "../src/indexes";
import { compileIndexDDL } from "../src/indexes/ddl";
import {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
} from "../src/indexes/drizzle";
import { parseSerializedSchema, serializeSchema } from "../src/schema";

const Event = defineNode("Event", {
  schema: z.object({ at: z.date(), label: z.string() }),
});

const scheduled = defineEdge("scheduled", {
  schema: z.object({ at: z.date() }),
});

function refusal(run: () => unknown): UnsupportedBackendCapabilityError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsupportedBackendCapabilityError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("dateIndexExpressions outside the store", () => {
  it("createPostgresTables refuses a date-typed node index before building the schema", () => {
    const atIndex = defineNodeIndex(Event, {
      name: "event_at",
      fields: ["at"],
    });
    const error = refusal(() =>
      createPostgresTables({}, { indexes: [atIndex] }),
    );
    expect(error.message).toBe(
      `createPostgresTables() requires backend capability 'dateIndexExpressions'. Index "event_at" on node kind "Event" reads date-typed field "/at" in its key; this backend cannot build an index over a date property (on PostgreSQL, the text-to-timestamptz cast it needs is not immutable).`,
    );
    expect(error.details).toEqual({
      operation: "createPostgresTables()",
      capability: "dateIndexExpressions",
      entity: "node",
      kind: "Event",
      indexName: "event_at",
      field: "/at",
      position: "key",
    });
  });

  it("createPostgresTables refuses a date-typed edge index", () => {
    const atIndex = defineEdgeIndex(scheduled, {
      name: "scheduled_at",
      fields: ["at"],
    });
    expect(
      refusal(() => createPostgresTables({}, { indexes: [atIndex] })).details,
    ).toMatchObject({ entity: "edge", kind: "scheduled", field: "/at" });
  });

  it("createSqliteTables builds the same declaration", () => {
    const atIndex = defineNodeIndex(Event, {
      name: "event_at",
      fields: ["at"],
    });
    const ddl = generateSqliteDDL(
      createSqliteTables({}, { indexes: [atIndex] }),
    ).join("\n");
    expect(ddl).toContain(`"event_at"`);
  });

  it("accepts a non-date declaration on PostgreSQL", () => {
    const labelIndex = defineNodeIndex(Event, {
      name: "event_label",
      fields: ["label"],
    });
    expect(() =>
      createPostgresTables({}, { indexes: [labelIndex] }),
    ).not.toThrow();
  });

  it("the bundled declarations: PostgreSQL refuses, SQLite builds, absent builds", () => {
    expect(POSTGRES_CAPABILITIES.dateIndexExpressions).toBe(false);
    expect(SQLITE_CAPABILITIES.dateIndexExpressions).toBe(true);
    const atIndex = defineNodeIndex(Event, {
      name: "event_at",
      fields: ["at"],
    });
    const { dateIndexExpressions: _omitted, ...undeclared } =
      POSTGRES_CAPABILITIES;
    expect(() => {
      assertDateIndexExpressionsSupported(undeclared, [atIndex], "custom()");
    }).not.toThrow();
  });
  it("generateIndexDDL refuses a date-typed index for PostgreSQL and builds it for SQLite", () => {
    const atIndex = defineNodeIndex(Event, {
      name: "event_at",
      fields: ["at"],
    });
    const error = refusal(() => generateIndexDDL(atIndex, "postgres"));
    expect(error.message).toBe(
      `generateIndexDDL() requires backend capability 'dateIndexExpressions'. Index "event_at" on node kind "Event" reads date-typed field "/at" in its key; this backend cannot build an index over a date property (on PostgreSQL, the text-to-timestamptz cast it needs is not immutable).`,
    );
    expect(generateIndexDDL(atIndex, "sqlite")).toContain(`"event_at"`);
  });

  it("generateNodeIndexDDL and generateEdgeIndexDDL refuse for PostgreSQL", () => {
    const nodeIndex = defineNodeIndex(Event, {
      name: "event_at",
      fields: ["at"],
    });
    const edgeIndex = defineEdgeIndex(scheduled, {
      name: "scheduled_at",
      fields: ["at"],
    });
    expect(
      refusal(() => generateNodeIndexDDL(nodeIndex, "postgres")).details,
    ).toMatchObject({ operation: "generateNodeIndexDDL()", kind: "Event" });
    expect(
      refusal(() => generateEdgeIndexDDL(edgeIndex, "postgres")).details,
    ).toMatchObject({ operation: "generateEdgeIndexDDL()", kind: "scheduled" });
  });

  it("the PostgreSQL Drizzle index builders refuse a date-typed index", () => {
    const tables = createPostgresTables();
    const nodeIndex = defineNodeIndex(Event, {
      name: "event_at",
      fields: ["at"],
    });
    const edgeIndex = defineEdgeIndex(scheduled, {
      name: "scheduled_at",
      fields: ["at"],
    });
    expect(
      refusal(() => buildPostgresNodeIndexBuilders(tables.nodes, [nodeIndex]))
        .details,
    ).toMatchObject({
      operation: "buildPostgresNodeIndexBuilders()",
      indexName: "event_at",
    });
    expect(
      refusal(() => buildPostgresEdgeIndexBuilders(tables.edges, [edgeIndex]))
        .details,
    ).toMatchObject({
      operation: "buildPostgresEdgeIndexBuilders()",
      indexName: "scheduled_at",
    });
  });
});

// Shifts a covering field into the lookup fields while leaving each value
// type in its own array: `fields` then has two pointers and one type,
// `coveringFields` none and one type.
function shiftedDeclaration() {
  const declared = defineNodeIndex(Event, {
    name: "event_label_at",
    fields: ["label"],
    coveringFields: ["at"],
  });
  return {
    ...declared,
    fields: [...declared.fields, ...declared.coveringFields],
    coveringFields: [],
  };
}

describe("pairing index fields with their value types", () => {
  it("refuses a declaration whose field and value-type arrays differ in length", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      expect(() => compileIndexDDL(shiftedDeclaration(), dialect)).toThrow(
        'Index "event_label_at" has 2 fields but 1 field value types, and 0 covering fields but 1 covering field value types; each field needs exactly one value type.',
      );
    }
    expect(() => {
      assertDateIndexExpressionsSupported(
        POSTGRES_CAPABILITIES,
        [shiftedDeclaration()],
        "custom()",
      );
    }).toThrow(ConfigurationError);
  });

  it("refuses such a declaration in a stored schema document", () => {
    const graph = defineGraph({
      id: "paired_value_types",
      nodes: { Event: { type: Event } },
      edges: {},
      indexes: [
        defineNodeIndex(Event, {
          name: "event_label_at",
          fields: ["label"],
          coveringFields: ["at"],
        }),
      ],
    });
    const stored = serializeSchema(graph, 1);
    const tampered = {
      ...stored,
      indexes: (stored.indexes ?? []).map((index) =>
        index.entity === "vector" ?
          index
        : {
            ...index,
            fields: [...index.fields, ...index.coveringFields],
            coveringFields: [],
          },
      ),
    };
    expect(() => parseSerializedSchema(JSON.stringify(stored))).not.toThrow();
    expect(() => parseSerializedSchema(JSON.stringify(tampered))).toThrow(
      /each field needs exactly one value type/,
    );
  });
});

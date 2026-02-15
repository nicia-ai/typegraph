/**
 * Tests for query result mapping utilities.
 *
 * Covers transformation of raw database rows into typed SelectContext
 * and result objects.
 */
/* eslint-disable unicorn/no-null -- Testing database row behavior which uses null */
import { describe, expect, it } from "vitest";

import type { Traversal } from "../src/query/ast";
import type { QueryBuilderState } from "../src/query/builder/types";
import {
  buildSelectableNode,
  buildSelectContext,
  mapResults,
  transformPathColumns,
} from "../src/query/execution/result-mapper";

describe("transformPathColumns", () => {
  const baseState: QueryBuilderState = {
    startKinds: ["Person"],
    startAlias: "p",
    currentAlias: "p",
    includeSubClasses: false,
    traversals: [],
    predicates: [],
    projection: [],
    orderBy: [],
    limit: undefined,
    offset: undefined,
    temporalMode: "current",
    asOf: undefined,
    groupBy: undefined,
    having: undefined,
  };

  describe("dialect handling", () => {
    it("returns rows unchanged for PostgreSQL dialect", () => {
      const rows = [{ p_path: "a|b|c" }];
      const state: QueryBuilderState = {
        ...baseState,
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "p",
            joinEdgeField: "to_id",
            optional: false,
            variableLength: {
              minDepth: 1,
              maxDepth: 3,
              cyclePolicy: "prevent",
              pathAlias: "friend_path",
            },
          },
        ],
      };

      const result = transformPathColumns(rows, state, "postgres");

      expect(result).toBe(rows);
      expect(result[0]!.p_path).toBe("a|b|c");
    });

    it("transforms pipe-delimited paths for SQLite dialect", () => {
      // SQLite paths are stored as "|id1|id2|id3|" with leading/trailing pipes
      const rows = [{ friend_path: "|id1|id2|id3|" }];
      const state: QueryBuilderState = {
        ...baseState,
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "p",
            joinEdgeField: "to_id",
            optional: false,
            variableLength: {
              minDepth: 1,
              maxDepth: 3,
              cyclePolicy: "prevent",
              pathAlias: "friend_path",
            },
          },
        ],
      };

      const result = transformPathColumns(rows, state, "sqlite");

      expect(result[0]!.friend_path).toEqual(["id1", "id2", "id3"]);
    });
  });

  describe("path column detection", () => {
    it("returns rows unchanged when no variable-length traversals exist", () => {
      const rows = [{ some_data: "value" }];

      const result = transformPathColumns(rows, baseState, "sqlite");

      expect(result).toBe(rows);
    });

    it("returns rows unchanged when no pathAlias is configured", () => {
      const rows = [{ friend_path: "a|b|c" }];
      const state: QueryBuilderState = {
        ...baseState,
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "p",
            joinEdgeField: "to_id",
            optional: false,
            variableLength: {
              minDepth: 1,
              maxDepth: 3,
              cyclePolicy: "prevent",
            },
          },
        ],
      };

      const result = transformPathColumns(rows, state, "sqlite");

      expect(result).toBe(rows);
    });

    it("uses custom pathAlias when specified", () => {
      // SQLite paths are stored as "|id1|id2|" with leading/trailing pipes
      const rows = [{ custom_path: "|id1|id2|" }];
      const state: QueryBuilderState = {
        ...baseState,
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "p",
            joinEdgeField: "to_id",
            optional: false,
            variableLength: {
              minDepth: 1,
              maxDepth: 3,
              cyclePolicy: "prevent",
              pathAlias: "custom_path",
            },
          },
        ],
      };

      const result = transformPathColumns(rows, state, "sqlite");

      expect(result[0]!.custom_path).toEqual(["id1", "id2"]);
    });
  });

  describe("edge cases", () => {
    it("preserves non-path columns unchanged", () => {
      const rows = [
        {
          friend_path: "|id1|id2|",
          other_column: "unchanged",
          numeric: 42,
        },
      ];
      const state: QueryBuilderState = {
        ...baseState,
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "p",
            joinEdgeField: "to_id",
            optional: false,
            variableLength: {
              minDepth: 1,
              maxDepth: 3,
              cyclePolicy: "prevent",
              pathAlias: "friend_path",
            },
          },
        ],
      };

      const result = transformPathColumns(rows, state, "sqlite");

      expect(result[0]!.other_column).toBe("unchanged");
      expect(result[0]!.numeric).toBe(42);
    });

    it("handles non-string path values (already arrays)", () => {
      const rows = [{ friend_path: ["already", "array"] }];
      const state: QueryBuilderState = {
        ...baseState,
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "p",
            joinEdgeField: "to_id",
            optional: false,
            variableLength: {
              minDepth: 1,
              maxDepth: 3,
              cyclePolicy: "prevent",
              pathAlias: "friend_path",
            },
          },
        ],
      };

      const result = transformPathColumns(rows, state, "sqlite");

      // Should return original row when path is not a string
      expect(result[0]!.friend_path).toEqual(["already", "array"]);
    });
  });
});

describe("buildSelectableNode", () => {
  const baseRow = {
    p_id: "node-123",
    p_kind: "Person",
    p_props: JSON.stringify({ name: "Alice", age: 30 }),
    p_version: 1,
    p_valid_from: null,
    p_valid_to: null,
    p_created_at: "2024-01-01T00:00:00Z",
    p_updated_at: "2024-01-02T00:00:00Z",
    p_deleted_at: null,
  };

  describe("basic field mapping", () => {
    it("extracts id and kind from prefixed columns", () => {
      const node = buildSelectableNode(baseRow, "p");

      expect(node.id).toBe("node-123");
      expect(node.kind).toBe("Person");
    });

    it("parses JSON props and spreads them at top level", () => {
      const node = buildSelectableNode(baseRow, "p");

      expect(node.name).toBe("Alice");
      expect(node.age).toBe(30);
    });

    it("builds meta object from metadata columns", () => {
      const node = buildSelectableNode(baseRow, "p");

      expect(node.meta).toEqual({
        version: 1,
        validFrom: undefined,
        validTo: undefined,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        deletedAt: undefined,
      });
    });
  });

  describe("null to undefined normalization", () => {
    it("converts null validFrom to undefined", () => {
      const node = buildSelectableNode(baseRow, "p");

      expect(node.meta.validFrom).toBeUndefined();
    });

    it("converts null deletedAt to undefined", () => {
      const node = buildSelectableNode(baseRow, "p");

      expect(node.meta.deletedAt).toBeUndefined();
    });

    it("preserves non-null temporal values", () => {
      const row = {
        ...baseRow,
        p_valid_from: "2024-01-01T00:00:00Z",
        p_deleted_at: "2024-06-01T00:00:00Z",
      };

      const node = buildSelectableNode(row, "p");

      expect(node.meta.validFrom).toBe("2024-01-01T00:00:00Z");
      expect(node.meta.deletedAt).toBe("2024-06-01T00:00:00Z");
    });
  });

  describe("reserved key filtering", () => {
    it("filters out 'id' from props to prevent collision", () => {
      const row = {
        ...baseRow,
        p_props: JSON.stringify({ id: "fake-id", name: "Alice" }),
      };

      const node = buildSelectableNode(row, "p");

      expect(node.id).toBe("node-123"); // System field, not from props
      expect(node.name).toBe("Alice");
    });

    it("filters out 'kind' from props to prevent collision", () => {
      const row = {
        ...baseRow,
        p_props: JSON.stringify({ kind: "FakeKind", name: "Alice" }),
      };

      const node = buildSelectableNode(row, "p");

      expect(node.kind).toBe("Person"); // System field, not from props
    });

    it("filters out 'meta' from props to prevent collision", () => {
      const row = {
        ...baseRow,
        p_props: JSON.stringify({ meta: { fake: true }, name: "Alice" }),
      };

      const node = buildSelectableNode(row, "p");

      expect(node.meta.version).toBe(1); // System meta, not from props
      expect((node.meta as Record<string, unknown>).fake).toBeUndefined();
    });
  });

  describe("props handling edge cases", () => {
    it("handles already-parsed object props (PostgreSQL JSONB)", () => {
      const row = {
        ...baseRow,
        p_props: { name: "Alice", age: 30 }, // Already an object
      };

      const node = buildSelectableNode(row, "p");

      expect(node.name).toBe("Alice");
      expect(node.age).toBe(30);
    });

    it("handles undefined props", () => {
      const row = {
        ...baseRow,
        p_props: undefined,
      };

      const node = buildSelectableNode(row, "p");

      expect(node.id).toBe("node-123");
      expect(node.kind).toBe("Person");
    });

    it("handles empty props object", () => {
      const row = {
        ...baseRow,
        p_props: JSON.stringify({}),
      };

      const node = buildSelectableNode(row, "p");

      expect(node.id).toBe("node-123");
    });
  });
});

describe("buildSelectContext", () => {
  const startRow = {
    p_id: "person-1",
    p_kind: "Person",
    p_props: JSON.stringify({ name: "Alice" }),
    p_version: 1,
    p_valid_from: null,
    p_valid_to: null,
    p_created_at: "2024-01-01T00:00:00Z",
    p_updated_at: "2024-01-01T00:00:00Z",
    p_deleted_at: null,
  };

  describe("start node only (no traversals)", () => {
    it("builds context with just the start node", () => {
      const context = buildSelectContext(startRow, "p", []);

      expect(context.p).toBeDefined();
      expect(context.p!.id).toBe("person-1");
      expect(context.p!.name).toBe("Alice");
    });
  });

  describe("with traversals", () => {
    const traversalRow = {
      ...startRow,
      // Friend node
      friend_id: "person-2",
      friend_kind: "Person",
      friend_props: JSON.stringify({ name: "Bob" }),
      friend_version: 1,
      friend_valid_from: null,
      friend_valid_to: null,
      friend_created_at: "2024-01-01T00:00:00Z",
      friend_updated_at: "2024-01-01T00:00:00Z",
      friend_deleted_at: null,
      // Edge
      e_id: "edge-1",
      e_kind: "knows",
      e_from_id: "person-1",
      e_to_id: "person-2",
      e_props: JSON.stringify({ since: 2020 }),
      e_valid_from: null,
      e_valid_to: null,
      e_created_at: "2024-01-01T00:00:00Z",
      e_updated_at: "2024-01-01T00:00:00Z",
      e_deleted_at: null,
    };

    const traversals: Traversal[] = [
      {
        edgeKinds: ["knows"],
        edgeAlias: "e",
        nodeKinds: ["Person"],
        nodeAlias: "friend",
        direction: "out",
        joinFromAlias: "p",
        joinEdgeField: "to_id",
        optional: false,
      },
    ];

    it("includes traversed nodes in context", () => {
      const context = buildSelectContext(traversalRow, "p", traversals);

      expect(context.friend).toBeDefined();
      expect(context.friend!.id).toBe("person-2");
      expect(context.friend!.name).toBe("Bob");
    });

    it("includes edges in context", () => {
      const context = buildSelectContext(traversalRow, "p", traversals);

      expect(context.e).toBeDefined();
      expect(context.e!.id).toBe("edge-1");
      expect(context.e!.fromId).toBe("person-1");
      expect(context.e!.toId).toBe("person-2");
      expect(context.e!.since).toBe(2020);
    });
  });

  describe("optional traversals (LEFT JOIN)", () => {
    const nullTraversalRow = {
      ...startRow,
      // Friend is null (no match)
      friend_id: null,
      friend_kind: null,
      friend_props: null,
      friend_version: null,
      friend_valid_from: null,
      friend_valid_to: null,
      friend_created_at: null,
      friend_updated_at: null,
      friend_deleted_at: null,
      // Edge is also null
      e_id: null,
      e_kind: null,
      e_from_id: null,
      e_to_id: null,
      e_props: null,
      e_valid_from: null,
      e_valid_to: null,
      e_created_at: null,
      e_updated_at: null,
      e_deleted_at: null,
    };

    const optionalTraversals: Traversal[] = [
      {
        edgeKinds: ["knows"],
        edgeAlias: "e",
        nodeKinds: ["Person"],
        nodeAlias: "friend",
        direction: "out",
        joinFromAlias: "p",
        joinEdgeField: "to_id",
        optional: true,
      },
    ];

    it("returns undefined for optional node when not present", () => {
      const context = buildSelectContext(
        nullTraversalRow,
        "p",
        optionalTraversals,
      );

      expect(context.friend).toBeUndefined();
    });

    it("returns undefined for edge when not present", () => {
      const context = buildSelectContext(
        nullTraversalRow,
        "p",
        optionalTraversals,
      );

      expect(context.e).toBeUndefined();
    });
  });
});

describe("mapResults", () => {
  const rows = [
    {
      p_id: "person-1",
      p_kind: "Person",
      p_props: JSON.stringify({ name: "Alice" }),
      p_version: 1,
      p_valid_from: null,
      p_valid_to: null,
      p_created_at: "2024-01-01T00:00:00Z",
      p_updated_at: "2024-01-01T00:00:00Z",
      p_deleted_at: null,
    },
    {
      p_id: "person-2",
      p_kind: "Person",
      p_props: JSON.stringify({ name: "Bob" }),
      p_version: 1,
      p_valid_from: null,
      p_valid_to: null,
      p_created_at: "2024-01-01T00:00:00Z",
      p_updated_at: "2024-01-01T00:00:00Z",
      p_deleted_at: null,
    },
  ];

  it("applies select function to each row", () => {
    const results = mapResults(rows, "p", [], (ctx) => ({
      id: ctx.p!.id,
      name: ctx.p!.name,
    }));

    expect(results).toEqual([
      { id: "person-1", name: "Alice" },
      { id: "person-2", name: "Bob" },
    ]);
  });

  it("handles empty result set", () => {
    const results = mapResults([], "p", [], (ctx) => ctx.p!.id);

    expect(results).toEqual([]);
  });

  it("preserves result order", () => {
    const results = mapResults(rows, "p", [], (ctx) => ctx.p!.name);

    expect(results).toEqual(["Alice", "Bob"]);
  });
});

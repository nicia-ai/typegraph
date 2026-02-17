/**
 * Compiler Utilities Unit Tests
 *
 * Tests quoteIdentifier, shouldProjectColumn, addRequiredColumn,
 * markFieldRefAsRequired, markSelectiveFieldAsRequired,
 * isIdFieldRef, isAggregateExpr, and mapSelectiveSystemFieldToColumn.
 */
import { describe, expect, it } from "vitest";

import type { AggregateExpr, FieldRef, SelectiveField } from "../src/query/ast";
import {
  addRequiredColumn,
  EDGE_COLUMNS,
  EMPTY_REQUIRED_COLUMNS,
  isAggregateExpr,
  isIdFieldRef,
  mapSelectiveSystemFieldToColumn,
  markFieldRefAsRequired,
  markSelectiveFieldAsRequired,
  NODE_COLUMNS,
  quoteIdentifier,
  shouldProjectColumn,
} from "../src/query/compiler/utils";
import { jsonPointer } from "../src/query/json-pointer";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Constants
// ============================================================

describe("column constants", () => {
  it("NODE_COLUMNS contains expected system columns", () => {
    expect(NODE_COLUMNS).toContain("id");
    expect(NODE_COLUMNS).toContain("kind");
    expect(NODE_COLUMNS).toContain("props");
    expect(NODE_COLUMNS).toContain("version");
    expect(NODE_COLUMNS).toContain("valid_from");
    expect(NODE_COLUMNS).toContain("valid_to");
    expect(NODE_COLUMNS).toContain("created_at");
    expect(NODE_COLUMNS).toContain("updated_at");
    expect(NODE_COLUMNS).toContain("deleted_at");
  });

  it("EDGE_COLUMNS contains expected system columns", () => {
    expect(EDGE_COLUMNS).toContain("id");
    expect(EDGE_COLUMNS).toContain("kind");
    expect(EDGE_COLUMNS).toContain("from_id");
    expect(EDGE_COLUMNS).toContain("to_id");
    expect(EDGE_COLUMNS).toContain("props");
  });

  it("EMPTY_REQUIRED_COLUMNS is empty", () => {
    expect(EMPTY_REQUIRED_COLUMNS.size).toBe(0);
  });
});

// ============================================================
// quoteIdentifier
// ============================================================

describe("quoteIdentifier", () => {
  it("wraps simple identifier in double quotes", () => {
    expect(toSqlString(quoteIdentifier("name"))).toBe('"name"');
  });

  it("escapes double quotes inside identifier", () => {
    expect(toSqlString(quoteIdentifier('foo"bar'))).toBe('"foo""bar"');
  });

  it("handles empty string", () => {
    expect(toSqlString(quoteIdentifier(""))).toBe('""');
  });

  it("handles identifier with multiple double quotes", () => {
    expect(toSqlString(quoteIdentifier('a"b"c'))).toBe('"a""b""c"');
  });
});

// ============================================================
// shouldProjectColumn
// ============================================================

describe("shouldProjectColumn", () => {
  it("returns true when requiredColumns is undefined (project all)", () => {
    expect(shouldProjectColumn(undefined, "props")).toBe(true);
  });

  it("returns true when column is in required set", () => {
    const required = new Set(["id", "props"]);
    expect(shouldProjectColumn(required, "id")).toBe(true);
    expect(shouldProjectColumn(required, "props")).toBe(true);
  });

  it("returns false when column is not in required set", () => {
    const required = new Set(["id"]);
    expect(shouldProjectColumn(required, "props")).toBe(false);
    expect(shouldProjectColumn(required, "kind")).toBe(false);
  });

  it("returns true for always-required columns even if not in required set", () => {
    const required = new Set(["id"]);
    const alwaysRequired = new Set(["id", "from_id"]);
    expect(shouldProjectColumn(required, "from_id", alwaysRequired)).toBe(true);
  });

  it("alwaysRequired takes precedence over empty required set", () => {
    const required = new Set<string>();
    const alwaysRequired = new Set(["id"]);
    expect(shouldProjectColumn(required, "id", alwaysRequired)).toBe(true);
  });
});

// ============================================================
// addRequiredColumn / markFieldRefAsRequired
// ============================================================

describe("addRequiredColumn", () => {
  it("creates a new set for a new alias", () => {
    const map = new Map<string, Set<string>>();
    addRequiredColumn(map, "p", "id");
    expect(map.get("p")?.has("id")).toBe(true);
  });

  it("adds to existing set for known alias", () => {
    const map = new Map<string, Set<string>>();
    addRequiredColumn(map, "p", "id");
    addRequiredColumn(map, "p", "props");
    expect(map.get("p")?.size).toBe(2);
    expect(map.get("p")?.has("id")).toBe(true);
    expect(map.get("p")?.has("props")).toBe(true);
  });

  it("deduplicates when same column added twice", () => {
    const map = new Map<string, Set<string>>();
    addRequiredColumn(map, "p", "id");
    addRequiredColumn(map, "p", "id");
    expect(map.get("p")?.size).toBe(1);
  });
});

describe("markFieldRefAsRequired", () => {
  it("adds the first path segment as required column", () => {
    const map = new Map<string, Set<string>>();
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["props", "name"],
    };
    markFieldRefAsRequired(map, field);
    expect(map.get("p")?.has("props")).toBe(true);
  });

  it("handles single-segment path", () => {
    const map = new Map<string, Set<string>>();
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["id"],
    };
    markFieldRefAsRequired(map, field);
    expect(map.get("p")?.has("id")).toBe(true);
  });

  it("does nothing for empty path", () => {
    const map = new Map<string, Set<string>>();
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: [],
    };
    markFieldRefAsRequired(map, field);
    expect(map.has("p")).toBe(false);
  });
});

// ============================================================
// markSelectiveFieldAsRequired
// ============================================================

describe("markSelectiveFieldAsRequired", () => {
  it("maps system field to correct column name", () => {
    const map = new Map<string, Set<string>>();
    const field: SelectiveField = {
      alias: "p",
      field: "id",
      outputName: "p_id",
      isSystemField: true,
    };
    markSelectiveFieldAsRequired(map, field);
    expect(map.get("p")?.has("id")).toBe(true);
  });

  it("maps fromId system field to from_id column", () => {
    const map = new Map<string, Set<string>>();
    const field: SelectiveField = {
      alias: "e",
      field: "fromId",
      outputName: "e_fromId",
      isSystemField: true,
    };
    markSelectiveFieldAsRequired(map, field);
    expect(map.get("e")?.has("from_id")).toBe(true);
  });

  it("maps toId system field to to_id column", () => {
    const map = new Map<string, Set<string>>();
    const field: SelectiveField = {
      alias: "e",
      field: "toId",
      outputName: "e_toId",
      isSystemField: true,
    };
    markSelectiveFieldAsRequired(map, field);
    expect(map.get("e")?.has("to_id")).toBe(true);
  });

  it("maps meta.createdAt to created_at", () => {
    const map = new Map<string, Set<string>>();
    const field: SelectiveField = {
      alias: "p",
      field: "meta.createdAt",
      outputName: "p_meta_createdAt",
      isSystemField: true,
    };
    markSelectiveFieldAsRequired(map, field);
    expect(map.get("p")?.has("created_at")).toBe(true);
  });

  it("adds props column for non-system fields", () => {
    const map = new Map<string, Set<string>>();
    const field: SelectiveField = {
      alias: "p",
      field: "name",
      outputName: "p_name",
      isSystemField: false,
    };
    markSelectiveFieldAsRequired(map, field);
    expect(map.get("p")?.has("props")).toBe(true);
  });
});

// ============================================================
// mapSelectiveSystemFieldToColumn
// ============================================================

describe("mapSelectiveSystemFieldToColumn", () => {
  it("maps fromId to from_id", () => {
    expect(mapSelectiveSystemFieldToColumn("fromId")).toBe("from_id");
  });

  it("maps toId to to_id", () => {
    expect(mapSelectiveSystemFieldToColumn("toId")).toBe("to_id");
  });

  it("maps meta.createdAt to created_at", () => {
    expect(mapSelectiveSystemFieldToColumn("meta.createdAt")).toBe(
      "created_at",
    );
  });

  it("maps meta.updatedAt to updated_at", () => {
    expect(mapSelectiveSystemFieldToColumn("meta.updatedAt")).toBe(
      "updated_at",
    );
  });

  it("maps meta.deletedAt to deleted_at", () => {
    expect(mapSelectiveSystemFieldToColumn("meta.deletedAt")).toBe(
      "deleted_at",
    );
  });

  it("maps meta.validFrom to valid_from", () => {
    expect(mapSelectiveSystemFieldToColumn("meta.validFrom")).toBe(
      "valid_from",
    );
  });

  it("passes through simple field names unchanged", () => {
    expect(mapSelectiveSystemFieldToColumn("id")).toBe("id");
    expect(mapSelectiveSystemFieldToColumn("kind")).toBe("kind");
    expect(mapSelectiveSystemFieldToColumn("version")).toBe("version");
  });
});

// ============================================================
// isIdFieldRef
// ============================================================

describe("isIdFieldRef", () => {
  it("returns true for path ['id'] with no jsonPointer", () => {
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["id"],
    };
    expect(isIdFieldRef(field)).toBe(true);
  });

  it("returns false for path ['props', 'id']", () => {
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["props", "id"],
    };
    expect(isIdFieldRef(field)).toBe(false);
  });

  it("returns false for path ['id'] with jsonPointer", () => {
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["id"],
      jsonPointer: jsonPointer(["sub"]),
    };
    expect(isIdFieldRef(field)).toBe(false);
  });

  it("returns false for empty path", () => {
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: [],
    };
    expect(isIdFieldRef(field)).toBe(false);
  });

  it("returns false for path ['kind']", () => {
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["kind"],
    };
    expect(isIdFieldRef(field)).toBe(false);
  });
});

// ============================================================
// isAggregateExpr
// ============================================================

describe("isAggregateExpr", () => {
  it("returns true for aggregate expressions", () => {
    const aggregate: AggregateExpr = {
      __type: "aggregate",
      function: "count",
      field: { __type: "field_ref", alias: "p", path: ["id"] },
    };
    expect(isAggregateExpr(aggregate)).toBe(true);
  });

  it("returns false for field references", () => {
    const field: FieldRef = {
      __type: "field_ref",
      alias: "p",
      path: ["id"],
    };
    expect(isAggregateExpr(field)).toBe(false);
  });
});

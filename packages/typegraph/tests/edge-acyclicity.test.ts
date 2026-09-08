/**
 * In-process unit and refusal tests for item D.2 (`acyclic: true`).
 *
 * Cross-backend query-and-constraint semantics live in
 * `tests/backends/integration/edge-acyclicity.ts`, run on every backend.
 * This file covers the pieces that need no live database at all: the
 * compiled-SQL shape, the fence-reason predicate, and refusals that are
 * decided before any statement runs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { resolveRecursiveTraversal } from "../src/backend/capabilities/recursive-traversal";
import { deriveBackend } from "../src/backend/derive-backend";
import { type GraphBackend } from "../src/backend/types";
import {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
} from "../src/query/compiler/schema";
import { getDialect, sqliteDialect } from "../src/query/dialect";
import { renderSqlite } from "../src/query/sql-fragment";
import {
  acyclicEdgeRelations,
  acyclicRelationForEdgeKind,
  assertEdgeRelationsAcyclic,
  readEdgeAcyclicityViolations,
} from "../src/store/acyclicity";
import { edgeWriteNeedsConstraintFence } from "../src/store/constraints";
import { uncapturedGraphWriteLock } from "../src/store/recorded-capture/clock";
import { buildEdgeAcyclicityProbe } from "../src/store/recursive-cte";
import { createTestBackend, matchingObject } from "./test-utils";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });
const blockedBy = defineEdge("blockedBy", { schema: z.object({}) });
const plainMany = defineEdge("plainMany", { schema: z.object({}) });

const graph = defineGraph({
  id: "unit_acyclicity",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      cardinality: "many",
      acyclic: true,
    },
    blockedBy: { type: blockedBy, from: [Task], to: [Task], acyclic: true },
    plainMany: { type: plainMany, from: [Task], to: [Task] },
  },
});

describe("acyclicEdgeRelations / acyclicRelationForEdgeKind", () => {
  it("collects every acyclic edge kind as its own singleton, forward relation", () => {
    expect(acyclicEdgeRelations(graph)).toEqual([
      {
        name: "blockedBy",
        members: [{ edgeKind: "blockedBy", reversed: false }],
      },
      {
        name: "dependsOn",
        members: [{ edgeKind: "dependsOn", reversed: false }],
      },
    ]);
  });

  it("answers undefined for a non-acyclic edge kind", () => {
    expect(acyclicRelationForEdgeKind(graph, "plainMany")).toBeUndefined();
  });
});

describe("edgeWriteNeedsConstraintFence: fence-reason precedence", () => {
  it("reports edgeCardinality first when both apply", () => {
    expect(
      edgeWriteNeedsConstraintFence({ cardinality: "one", acyclic: true }),
    ).toBe("edgeCardinality");
  });

  it("reports edgeAcyclicity for the common case: many cardinality, acyclic", () => {
    expect(
      edgeWriteNeedsConstraintFence({ cardinality: "many", acyclic: true }),
    ).toBe("edgeAcyclicity");
  });

  it("reports undefined for an unconstrained edge", () => {
    expect(
      edgeWriteNeedsConstraintFence({ cardinality: "many" }),
    ).toBeUndefined();
    expect(edgeWriteNeedsConstraintFence({})).toBeUndefined();
  });
});

describe("buildEdgeAcyclicityProbe: compiled-SQL pin", () => {
  const relation = {
    name: "dependsOn",
    members: [{ edgeKind: "dependsOn", reversed: false }],
  };
  const recursiveTraversal = resolveRecursiveTraversal(
    createTestBackend().capabilities,
  );

  it("uses UNION (never UNION ALL) between the anchor and the recursive term", () => {
    const fragment = buildEdgeAcyclicityProbe({
      graphId: "g",
      members: relation.members,
      seed: {
        kind: "proposed",
        edges: [
          {
            edgeId: "e1",
            edgeKind: "dependsOn",
            fromKind: "Task",
            fromId: "a",
            toKind: "Task",
            toId: "b",
          },
        ],
      },
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      recursiveTraversal,
      operation: "test",
    });
    const rendered = renderSqlite(fragment).sql;

    expect(rendered).not.toContain("UNION ALL");
    expect(rendered).toMatch(/\bUNION\b/);
    // No depth column and no depth predicate: MAX_EXPLICIT_RECURSIVE_DEPTH
    // does not apply to this probe.
    expect(rendered).not.toMatch(/\bdepth\b/i);
    // The recursive term joins on both from_kind and from_id.
    expect(rendered).toContain("from_kind");
    expect(rendered).toContain("from_id");
  });

  it("compiles a VALUES row list for the proposed seed, not one SELECT per row", () => {
    const manyOrigins = Array.from({ length: 5 }, (_unused, index) => ({
      edgeId: `e${String(index)}`,
      edgeKind: "dependsOn",
      fromKind: "Task",
      fromId: `a${String(index)}`,
      toKind: "Task",
      toId: `b${String(index)}`,
    }));
    const fragment = buildEdgeAcyclicityProbe({
      graphId: "g",
      members: relation.members,
      seed: { kind: "proposed", edges: manyOrigins },
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      recursiveTraversal,
      operation: "test",
    });
    const rendered = renderSqlite(fragment).sql;
    expect(rendered).toContain("VALUES");
    expect(rendered).not.toContain("SELECT CAST");
  });
});

describe("recursiveTraversal: { supported: false } refuses both the write and the audit", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    const base = createTestBackend();
    backend = deriveBackend(base, {
      capabilities: {
        ...base.capabilities,
        recursiveTraversal: {
          supported: false,
          reason: "test: recursive traversal disabled",
        },
      },
    });
  });

  it("refuses the write-path probe with RECURSIVE_TRAVERSAL_UNSUPPORTED", async () => {
    await expect(
      assertEdgeRelationsAcyclic(
        {
          graphId: graph.id,
          graph,
          schema: createSqlSchema(backend.tableNames),
          dialect: getDialect(backend.dialect),
          target: backend,
          lock: uncapturedGraphWriteLock(),
          operation: "test",
        },
        [
          {
            edgeId: "e1",
            edgeKind: "dependsOn",
            fromKind: "Task",
            fromId: "a",
            toKind: "Task",
            toId: "b",
          },
        ],
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        details: matchingObject({ code: "RECURSIVE_TRAVERSAL_UNSUPPORTED" }),
      }),
    );
  });

  it("refuses the audit reader too, rather than reporting an empty (falsely clean) result", async () => {
    await expect(
      readEdgeAcyclicityViolations(
        {
          graphId: graph.id,
          graph,
          schema: createSqlSchema(backend.tableNames),
          dialect: getDialect(backend.dialect),
          target: backend,
          operation: "test",
        },
        acyclicEdgeRelations(graph),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        details: matchingObject({ code: "RECURSIVE_TRAVERSAL_UNSUPPORTED" }),
      }),
    );
  });
});

/**
 * In-process unit and refusal tests for item D.2 (`acyclic: true`).
 *
 * Cross-backend query-and-constraint semantics live in
 * `tests/backends/integration/edge-acyclicity.ts`, run on every backend.
 * This file covers the pieces that need no live database at all: the
 * compiled-SQL shape, the fence-reason predicate, and refusals that are
 * decided before any statement runs.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityIndeterminateError,
} from "../src";
import { resolveRecursiveTraversal } from "../src/backend/capabilities/recursive-traversal";
import { deriveBackend } from "../src/backend/derive-backend";
import { generateVectorlessPostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type GraphBackend } from "../src/backend/types";
import {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
} from "../src/query/compiler/schema";
import { getDialect, sqliteDialect } from "../src/query/dialect";
import { renderSqlite } from "../src/query/sql-fragment";
import * as acyclicityModule from "../src/store/acyclicity";
import {
  type AcyclicEdgeRelation,
  acyclicEdgeRelations,
  acyclicRelationForEdgeKind,
  assertEdgeRelationsAcyclic,
  readEdgeAcyclicityViolations,
} from "../src/store/acyclicity";
import { edgeWriteNeedsConstraintFence } from "../src/store/constraints";
import { uncapturedGraphWriteLock } from "../src/store/recorded-capture/clock";
import {
  type AcyclicityProbeSeed,
  buildEdgeAcyclicityProbe,
} from "../src/store/recursive-cte";
import { createTestBackend, matchingObject } from "./test-utils";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });
// A second node kind exists solely so the mixed-orientation relation test
// below can put a real Task/Milestone split on `blockedBy`'s endpoints — see
// D2-07 / D2R2-03: with a single node kind, the reversed member's from_kind
// and to_kind columns are both the literal "Task", so a CASE-arm swap on the
// projected kind columns is invisible.
const Milestone = defineNode("Milestone", {
  schema: z.object({ name: z.string() }),
});
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });
const blockedBy = defineEdge("blockedBy", { schema: z.object({}) });
const plainMany = defineEdge("plainMany", { schema: z.object({}) });

const graph = defineGraph({
  id: "unit_acyclicity",
  nodes: { Task: { type: Task }, Milestone: { type: Milestone } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      cardinality: "many",
      acyclic: true,
    },
    blockedBy: {
      type: blockedBy,
      from: [Task],
      to: [Task, Milestone],
      acyclic: true,
    },
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

// D2R2-01: the single-create acyclicity gate must route through
// `edgeKindIsInAcyclicRelation` (the one owner, per `edgeAcyclic` in
// edge-operations.ts), not re-read `registration.acyclic === true` directly.
// Item E's composed relations will make a member kind participate in an
// acyclic relation while its OWN registration carries no `acyclic` key
// (D-10); until item E ships there is no way to produce that shape through
// `defineGraph`, so this test simulates it exactly as the review that caught
// this did: by making the shared predicate answer `true` for a plain edge
// kind, the same thing a composed relation will do for real. It spies on
// `assertEdgeRelationsAcyclic` itself (rather than letting it run for real)
// because that function's own relation lookup is an intra-module call that
// a spy on the module's exports cannot intercept — the point here is
// narrower and precise: does the single-create path even REACH the probe.
describe("single-create acyclicity gate: routes through the one-owner predicate (D2R2-01)", () => {
  it("calls assertEdgeRelationsAcyclic for a kind whose own registration has no acyclic flag, once the shared predicate says it is in a relation", async () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });

    // `plainMany` declares no `acyclic` key at all (see the graph fixture
    // above) — exactly the composed-member shape D-10 describes.
    expect(acyclicRelationForEdgeKind(graph, "plainMany")).toBeUndefined();

    const isInAcyclicRelationSpy = vi
      .spyOn(acyclicityModule, "edgeKindIsInAcyclicRelation")
      .mockImplementation((_graph, edgeKind) => edgeKind === "plainMany");
    const assertAcyclicSpy = vi
      .spyOn(acyclicityModule, "assertEdgeRelationsAcyclic")
      .mockResolvedValue(undefined);

    try {
      await store.edges.plainMany.create(a, b);
      expect(assertAcyclicSpy).toHaveBeenCalledTimes(1);
      const proposed = assertAcyclicSpy.mock.calls[0]?.[1];
      expect(proposed).toEqual([
        expect.objectContaining({ edgeKind: "plainMany" }),
      ]);
    } finally {
      isInAcyclicRelationSpy.mockRestore();
      assertAcyclicSpy.mockRestore();
    }
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

// ============================================================
// §8 typed terminals (D2-02): the engine-cut-short indeterminate error and
// the fresh-snapshot isolation refusal. Both existed with zero coverage.
// ============================================================

/** A backend whose `execute` always throws an error carrying `code`. */
function backendWhoseExecuteThrows(code: unknown): GraphBackend {
  const base = createTestBackend();
  return deriveBackend(base, {
    execute: () => {
      throw Object.assign(
        new Error(`simulated statement failure: ${String(code)}`),
        { code },
      );
    },
  });
}

/**
 * A backend whose `execute` throws the shape a real Drizzle-wrapped driver
 * failure has (D2R2-04): the top-level error's `.message` is the query text
 * and carries no `code`, and the real driver error — carrying `code` — sits
 * one `.cause` link down, exactly how `DrizzleQueryError` wraps node-postgres
 * / postgres-js (see `src/utils/sql-errors.ts`'s `errorChain` doc comment).
 * `backendWhoseExecuteThrows` puts `code` on the top-level error instead,
 * which never exercises the chain walk `isStatementCutShortError` exists
 * for.
 */
function backendWhoseExecuteThrowsNestedCause(code: unknown): GraphBackend {
  const base = createTestBackend();
  return deriveBackend(base, {
    execute: () => {
      const driverError = Object.assign(
        new Error(`driver error: ${String(code)}`),
        {
          code,
        },
      );
      throw new Error("Failed query: simulated statement failure", {
        cause: driverError,
      });
    },
  });
}

function acyclicityContext(backend: GraphBackend) {
  return {
    graphId: graph.id,
    graph,
    schema: createSqlSchema(backend.tableNames),
    dialect: getDialect(backend.dialect),
    target: backend,
    lock: uncapturedGraphWriteLock(),
    operation: "test",
  };
}

describe("engine cut-short mid-probe: EdgeAcyclicityIndeterminateError vs a propagated error", () => {
  const PROPOSED_EDGE = {
    edgeId: "e1",
    edgeKind: "dependsOn",
    fromKind: "Task",
    fromId: "a",
    toKind: "Task",
    toId: "b",
  };

  // PostgreSQL query_canceled / program_limit_exceeded, and SQLite's
  // SQLITE_INTERRUPT / SQLITE_TOOBIG — the exact code set
  // `isStatementCutShortError` recognizes (`src/utils/sql-errors.ts`).
  const CUT_SHORT_CODES = [
    "57014",
    "54000",
    "SQLITE_INTERRUPT",
    "SQLITE_TOOBIG",
  ] as const;

  for (const code of CUT_SHORT_CODES) {
    it(`reports EdgeAcyclicityIndeterminateError when the probe is cut short with ${code}`, async () => {
      const backend = backendWhoseExecuteThrows(code);
      await expect(
        assertEdgeRelationsAcyclic(acyclicityContext(backend), [PROPOSED_EDGE]),
      ).rejects.toThrow(EdgeAcyclicityIndeterminateError);
    });
  }

  it("reports EdgeAcyclicityIndeterminateError when the cut-short code sits one `.cause` link down (Drizzle-wrapped shape, D2R2-04)", async () => {
    const backend = backendWhoseExecuteThrowsNestedCause("57014");
    await expect(
      assertEdgeRelationsAcyclic(acyclicityContext(backend), [PROPOSED_EDGE]),
    ).rejects.toThrow(EdgeAcyclicityIndeterminateError);
  });

  it("propagates an unrecognized error code unchanged rather than reporting 'no cycle'", async () => {
    const backend = backendWhoseExecuteThrows("42P01");
    let caught: unknown;
    try {
      await assertEdgeRelationsAcyclic(acyclicityContext(backend), [
        PROPOSED_EDGE,
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(EdgeAcyclicityIndeterminateError);
    expect((caught as Error).message).toContain("42P01");
  });
});

describe("EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT: the isolation guard's refusal branch", () => {
  it("refuses an acyclic edge create under a repeatable-read server default (PGlite, real PostgreSQL dialect)", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generateVectorlessPostgresMigrationSQL());
      await client.exec(
        "SET default_transaction_isolation = 'repeatable read'",
      );
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
      });
      const store = createStore(graph, backend);
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });

      const attempt = store.edges.dependsOn.create(a, b);
      await expect(attempt).rejects.toBeInstanceOf(ConfigurationError);
      await expect(attempt).rejects.toMatchObject({
        details: {
          code: "EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT",
          isolation: "repeatable_read",
        },
      });
    } finally {
      await client.close();
    }
  });
});

// ============================================================
// D-10 / D2-07: the oriented (`reversed: true`) member. D.2 itself never
// constructs one — every real graph declares standalone, forward-only
// relations — but item E's composition contract will, and the ~45 lines of
// generated SQL that walk a reversed member had zero execution before this.
// ============================================================

describe("buildEdgeAcyclicityProbe / readEdgeAcyclicityViolations: a mixed-orientation relation", () => {
  const relation: AcyclicEdgeRelation = {
    name: "mixed-orientation",
    members: [
      { edgeKind: "dependsOn", reversed: false },
      { edgeKind: "blockedBy", reversed: true },
    ],
  };
  const recursiveTraversal = resolveRecursiveTraversal(
    createTestBackend().capabilities,
  );

  function seedFragment(seed: AcyclicityProbeSeed) {
    return buildEdgeAcyclicityProbe({
      graphId: "g",
      members: relation.members,
      seed,
      dialect: sqliteDialect,
      schema: DEFAULT_SQL_SCHEMA,
      recursiveTraversal,
      operation: "test",
    });
  }

  it("compiles the reversed branch of a proposed seed row without throwing (pin)", () => {
    const rendered = renderSqlite(
      seedFragment({
        kind: "proposed",
        edges: [
          {
            edgeId: "e1",
            edgeKind: "blockedBy",
            fromKind: "Task",
            fromId: "x",
            toKind: "Task",
            toId: "y",
          },
        ],
      }),
    ).sql;
    expect(rendered).toContain("VALUES");
  });

  it("compiles the CASE-oriented seed and OR-joined recursive term for the relation-wide (audit) seed (pin)", () => {
    const rendered = renderSqlite(seedFragment({ kind: "relation" })).sql;
    expect(rendered).toMatch(/CASE WHEN/i);
    expect(rendered).toMatch(/\bOR\b/);
  });

  it("walks the reversed member in its TRUE relation direction, not its stored (from, to) direction", async () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    // `c` is deliberately the OTHER node kind: with every node the same kind,
    // a from_kind/to_kind CASE-arm swap on the reversed member is invisible
    // (both columns read "Task" either way) — see D2-07 / D2R2-03.
    const c = await store.nodes.Milestone.create({ name: "c" });

    // Given `blockedBy` is the RELATION's reversed member, these two stored
    // rows compose the relation-direction graph  c -> a -> b  (not a cycle):
    //   dependsOn(a -> b)  [forward]           => relation edge a -> b
    //   blockedBy(a -> c)  [reversed: swapped]  => relation edge c -> a
    await backend.insertEdge({
      graphId: graph.id,
      id: "e-forward",
      kind: "dependsOn",
      fromKind: "Task",
      fromId: a.id,
      toKind: "Task",
      toId: b.id,
      props: {},
    });
    await backend.insertEdge({
      graphId: graph.id,
      id: "e-reversed",
      kind: "blockedBy",
      fromKind: "Task",
      fromId: a.id,
      toKind: "Milestone",
      toId: c.id,
      props: {},
    });

    const ctx = {
      graphId: graph.id,
      schema: createSqlSchema(backend.tableNames),
      dialect: getDialect(backend.dialect),
      target: backend,
      operation: "test",
    };
    expect(await readEdgeAcyclicityViolations(ctx, [relation])).toEqual([]);

    // Closing edge, in RELATION-direction terms: b -> c completes the cycle
    // c -> a -> b -> c. If the reversed member were walked in its STORED
    // direction instead (the defect this test is built to catch — flip
    // either `proposedSeedRow`'s or `buildAcyclicitySeed`'s CASE polarity to
    // reproduce it), the composed graph would instead be a->b, a->c, b->c —
    // no cycle — and this would silently report no violation.
    await backend.insertEdge({
      graphId: graph.id,
      id: "e-closing",
      kind: "dependsOn",
      fromKind: "Task",
      fromId: b.id,
      toKind: "Milestone",
      toId: c.id,
      props: {},
    });

    const violations = await readEdgeAcyclicityViolations(ctx, [relation]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.relation).toBe("mixed-orientation");
    expect(violations[0]?.edgeIds).toContain("e-reversed");
  });
});

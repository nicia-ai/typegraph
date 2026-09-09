/**
 * Proves the `RecordedReadSource` seam (`source`/`predicate`) is what
 * actually drives a recorded read's compiled SQL, not an inline spelling of
 * the relation swap and the `recorded_from`/`recorded_to` interval.
 *
 * A binding whose `source` returns a distinctively marked relation and whose
 * `predicate` returns `undefined` (the shape an engine-native binding will
 * use once one exists — its own temporal table expression already scopes
 * rows to the pinned revision) must compile to SQL that names the marker and
 * carries no recorded interval clause. If `compileTemporalFilter` reverted to
 * spelling `recorded_from`/`recorded_to` inline instead of consulting
 * `binding.predicate`, this test would still pass for TypeGraph's own
 * bindings (they always return the interval) but must FAIL for this
 * scripted one, since the inline spelling ignores `predicate` entirely and
 * always emits the interval.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createQueryBuilder, defineGraph, defineNode } from "../src";
import { type RecordedInstantParts } from "../src/core/temporal";
import { compileQuery } from "../src/query/compiler";
import {
  createRecordedReadBinding,
  createSqlSchema,
  type RecordedReadBinding,
  type RecordedSourceTable,
} from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { buildKindRegistry } from "../src/registry";
import { toSqlString } from "./sql-test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "recorded-read-source-seam-test",
  nodes: { Person: { type: Person } },
  edges: {},
});

const registry = buildKindRegistry(graph);

const MARKED_NODES_RELATION = "__engine_native_marked_nodes__";

/**
 * A binding structurally identical to TypeGraph's own capture binding
 * (same brand, so it passes `requireRecordedReadBinding`) except its
 * `source`/`predicate` are overridden: `source("nodes", ...)` returns a
 * marked relation reference instead of the real recorded-nodes table, and
 * `predicate` always returns `undefined`. Building it by spreading a real
 * `createRecordedReadBinding(schema)` result copies the private brand
 * symbol along with `kind`/`schema`, so the override reaches
 * `requireRecordedReadBinding`'s validation exactly like a genuine binding —
 * only `source`/`predicate` diverge from it.
 */
function scriptedEngineLikeBinding(
  schema: ReturnType<typeof createSqlSchema>,
): RecordedReadBinding {
  const base = createRecordedReadBinding(schema);
  return Object.freeze({
    ...base,
    source(table: RecordedSourceTable, revision: RecordedInstantParts) {
      if (table === "nodes") return sql.raw(MARKED_NODES_RELATION);
      return base.source(table, revision);
    },
    predicate(): undefined {
      return;
    },
  });
}

describe("recorded read source seam", () => {
  it.each(["sqlite", "postgres"] as const)(
    "routes the schema swap and the recorded predicate through binding.source/predicate on %s",
    (dialect) => {
      const schema = createSqlSchema();
      const binding = scriptedEngineLikeBinding(schema);
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "person")
        .select((context) => context.person.id);
      const ast = {
        ...query.toAst(),
        recordedAsOf: "r1:0000000000000001:2026-01-01T00:00:00.000Z",
      };

      const compiled = compileQuery(ast, graph.id, {
        dialect,
        schema,
        recordedReadBinding: binding,
      });
      const text = toSqlString(compiled, dialect);

      expect(text).toContain(MARKED_NODES_RELATION);
      expect(text).not.toContain(schema.tables.recordedNodes);
      expect(text).not.toContain("recorded_from");
      expect(text).not.toContain("recorded_to");
    },
  );

  it("still emits the interval for TypeGraph's own recorded relation binding", () => {
    const schema = createSqlSchema();
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "person")
      .select((context) => context.person.id);
    const ast = {
      ...query.toAst(),
      recordedAsOf: "r1:0000000000000001:2026-01-01T00:00:00.000Z",
    };

    const compiled = compileQuery(ast, graph.id, {
      dialect: "sqlite",
      schema,
      recordedReadBinding: createRecordedReadBinding(schema),
    });
    const text = toSqlString(compiled, "sqlite");

    expect(text).toContain(schema.tables.recordedNodes);
    expect(text).toContain("recorded_from");
    expect(text).toContain("recorded_to");
  });
});

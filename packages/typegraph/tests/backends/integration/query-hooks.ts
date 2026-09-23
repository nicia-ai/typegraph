import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type QueryHookContext,
} from "../../../src";
import { getDialect } from "../../../src/query/dialect";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const HookWhole = defineNode("HookWhole", {
  schema: z.object({ name: z.string() }),
});
const HookPart = defineNode("HookPart", {
  schema: z.object({ name: z.string() }),
});
const hookPartOf = defineEdge("hookPartOf", { schema: z.object({}) });

const hookCompositionGraph = defineGraph({
  id: "query_hooks_composition",
  nodes: {
    HookWhole: { type: HookWhole },
    HookPart: { type: HookPart },
  },
  edges: {
    hookPartOf: {
      type: hookPartOf,
      from: [HookPart],
      to: [HookWhole],
      cardinality: "one",
    },
  },
  ontology: [partOf(HookPart, HookWhole, { via: hookPartOf })],
});

/**
 * Statements a direct `store.subgraph()` submits: nodes and edges each embed
 * the traversal on an inline-CTE engine; a materialized-ids engine fetches the
 * closure ids once first.
 */
function directSubgraphStatementCount(context: IntegrationTestContext): number {
  const strategy = getDialect(context.getBackend().dialect).capabilities
    .subgraphMembershipStrategy;
  return strategy === "materialized-ids" ? 3 : 2;
}

/**
 * A composition subgraph resolves the root's kind, reads the `edges`
 * closure ids, reads the composition closure ids, then hydrates nodes and
 * edges: five statements on every engine.
 */
const COMPOSITION_SUBGRAPH_STATEMENT_COUNT = 5;

/**
 * A subgraph's node and edge fetches run concurrently on some backends, so
 * statements finish in no fixed order; pairing ends with starts compares the
 * two as multisets keyed by the statement's own operation id.
 */
function inOperationIdOrder(
  contexts: readonly QueryHookContext[],
): readonly QueryHookContext[] {
  return contexts.toSorted((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );
}

export function registerQueryHookIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("query hooks", () => {
    it("fires once per statement a direct subgraph submits, current and recorded", async () => {
      const starts: QueryHookContext[] = [];
      const ends: QueryHookContext[] = [];
      const hooks = {
        onQueryStart: (ctx: QueryHookContext) => {
          starts.push(ctx);
        },
        onQueryEnd: (ctx: QueryHookContext) => {
          ends.push(ctx);
        },
      };
      const store = await context.createHistoryStore(integrationTestGraph, {
        hooks,
      });
      const root = await store.nodes.Person.create({ name: "Hook root" });
      const peer = await store.nodes.Person.create({ name: "Hook peer" });
      await store.edges.knows.create(root, peer, {});
      const pin = await store.recordedNow();
      if (pin === undefined) throw new Error("recorded clock was not written");
      const expected = directSubgraphStatementCount(context);

      starts.length = 0;
      ends.length = 0;
      const current = await store.subgraph(root.id, {
        edges: ["knows"],
        maxDepth: 1,
      });
      expect(current.nodes.has(peer.id)).toBe(true);
      expect(starts).toHaveLength(expected);
      expect(inOperationIdOrder(ends)).toEqual(inOperationIdOrder(starts));

      starts.length = 0;
      ends.length = 0;
      const recorded = await store.asOfRecorded(pin).subgraph(root.id, {
        edges: ["knows"],
        maxDepth: 1,
      });
      expect(recorded.nodes.has(peer.id)).toBe(true);
      expect(starts).toHaveLength(expected);
      expect(inOperationIdOrder(ends)).toEqual(inOperationIdOrder(starts));

      starts.length = 0;
      ends.length = 0;
      const recordedPeople = await store
        .asOfRecorded(pin)
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.id)
        .execute();
      expect(recordedPeople).toHaveLength(2);
      expect(starts).toHaveLength(1);
      expect(inOperationIdOrder(ends)).toEqual(inOperationIdOrder(starts));
    });

    it("fires once per statement a composition subgraph submits", async () => {
      const starts: QueryHookContext[] = [];
      const store = await context.createStore(hookCompositionGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            starts.push(ctx);
          },
        },
      });
      const whole = await store.nodes.HookWhole.create({ name: "Whole" });
      const part = await store.nodes.HookPart.create({ name: "Part" });
      await store.edges.hookPartOf.create(part, whole, {});

      starts.length = 0;
      const unit = await store.subgraph(whole.id, {
        edges: [],
        composition: true,
      });

      expect(new Set(unit.nodes.keys())).toEqual(new Set([whole.id, part.id]));
      expect(starts).toHaveLength(COMPOSITION_SUBGRAPH_STATEMENT_COUNT);
    });

    it("reports SQL, parameters, row count, and duration per submitted statement", async () => {
      const starts: QueryHookContext[] = [];
      const ends: Readonly<{
        ctx: QueryHookContext;
        result: Readonly<{ rowCount: number; durationMs: number }>;
      }>[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            starts.push(ctx);
          },
          onQueryEnd: (ctx, result) => {
            ends.push({ ctx, result });
          },
        },
      });
      await store.nodes.Person.create({
        name: "Hook Alice",
        age: 30,
        email: "hook-alice@example.com",
      });

      const rows = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq("Hook Alice"))
        .select((ctx) => ctx.p)
        .execute();

      expect(rows).toHaveLength(1);
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.sql).toContain("SELECT");
      expect(starts[0]?.params.length).toBeGreaterThan(0);
      expect(ends[0]?.ctx).toBe(starts[0]);
      expect(ends[0]?.result.rowCount).toBe(1);
      expect(ends[0]?.result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("fires once for each statement in a selective-projection fallback", async () => {
      const starts: QueryHookContext[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            starts.push(ctx);
          },
        },
      });
      await store.nodes.Person.create({
        name: "Hook Adult",
        email: "adult@example.com",
      });
      await store.nodes.Person.create({ name: "Hook Child", age: 10 });

      const rows = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "name", "asc")
        .select((ctx) =>
          ctx.p.name === "Hook Adult" ? ctx.p.email : ctx.p.name,
        )
        .execute();

      expect(rows).toEqual(["adult@example.com", "Hook Child"]);
      expect(starts).toHaveLength(2);
      expect(starts[0]?.operationId).not.toBe(starts[1]?.operationId);
      expect(starts[0]?.sql).not.toBe(starts[1]?.sql);
    });
  });
}

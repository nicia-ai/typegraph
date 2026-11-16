import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { ConfigurationError } from "../../../src/errors";
import { importGraph, ImportOptionsSchema } from "../../../src/interchange";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

/**
 * Which names `orderBy(alias, field)` accepts depends on whether the kind's
 * property set is closed. An open schema (`z.looseObject`, `.passthrough()`,
 * `.catchall()`) may store keys it does not declare, so an undeclared name is
 * ordered as a property, as before typed field names. A closed schema
 * (`z.object`, `z.strictObject`, and object schemas wrapped by `.refine()` /
 * `.superRefine()` or built with `.extend()`, which stay objects) refuses it.
 */
const LooseDocument = defineNode("OrderLooseDoc", {
  schema: z.looseObject({ title: z.string() }),
});
const PassthroughDocument = defineNode("OrderPassthroughDoc", {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated spelling still builds an open schema, so it must order like z.looseObject
  schema: z.object({ title: z.string() }).passthrough(),
});
const CatchallDocument = defineNode("OrderCatchallDoc", {
  schema: z.object({ title: z.string() }).catchall(z.string()),
});
const RefinedDocument = defineNode("OrderRefinedDoc", {
  schema: z
    .object({ title: z.string(), rank: z.number() })
    .refine((document) => document.rank >= 0),
});
const SuperRefinedDocument = defineNode("OrderSuperRefinedDoc", {
  schema: z
    .object({ title: z.string(), rank: z.number() })
    .superRefine((document, refinement) => {
      if (document.rank < 0) {
        refinement.addIssue({ code: "custom", message: "rank must be >= 0" });
      }
    }),
});
const ExtendedDocument = defineNode("OrderExtendedDoc", {
  schema: z.object({ title: z.string() }).extend({ rank: z.number() }),
});
const StrictDocument = defineNode("OrderStrictDoc", {
  schema: z.strictObject({ title: z.string() }),
});
const PlainDocument = defineNode("OrderPlainDoc", {
  schema: z.object({
    title: z.string(),
    rank: z.number().optional(),
    score: z.number().nullable(),
  }),
});
const looseLink = defineEdge("orderLooseLink", {
  schema: z.looseObject({}),
});
const plainLink = defineEdge("orderPlainLink", {
  schema: z.object({ weight: z.number() }),
});

const schemaFormGraph = defineGraph({
  id: "order_schema_forms",
  nodes: {
    OrderLooseDoc: { type: LooseDocument },
    OrderPassthroughDoc: { type: PassthroughDocument },
    OrderCatchallDoc: { type: CatchallDocument },
    OrderRefinedDoc: { type: RefinedDocument },
    OrderSuperRefinedDoc: { type: SuperRefinedDocument },
    OrderExtendedDoc: { type: ExtendedDocument },
    OrderStrictDoc: { type: StrictDocument },
    OrderPlainDoc: { type: PlainDocument },
  },
  edges: {
    orderLooseLink: {
      type: looseLink,
      from: [LooseDocument],
      to: [LooseDocument],
    },
    orderPlainLink: {
      type: plainLink,
      from: [PlainDocument],
      to: [PlainDocument],
    },
  },
});

type SchemaFormStore = InspectableStore<typeof schemaFormGraph>;

/** Undeclared-key values in an order that matches neither insertion nor its reverse. */
const EXTRA_VALUES = ["b", "c", "a"] as const;
const EXTRA_ASC = ["a", "b", "c"];
const EXTRA_DESC = ["c", "b", "a"];

function titles(rows: readonly Readonly<{ title: string }>[]): string[] {
  return rows.map((row) => row.title);
}

/** The `ConfigurationError` an `orderBy` call throws. */
function orderRefusal(build: () => unknown): ConfigurationError {
  try {
    build();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected orderBy to refuse the field");
}

async function seedOpenDocuments(store: SchemaFormStore) {
  for (const extra of EXTRA_VALUES) {
    await store.nodes.OrderLooseDoc.create({ title: extra, extra });
    await store.nodes.OrderPassthroughDoc.create({ title: extra, extra });
    await store.nodes.OrderCatchallDoc.create({ title: extra, extra });
  }
}

export function registerOrderingSchemaFormTests(
  context: IntegrationTestContext,
): void {
  describe("orderBy field names across schema forms", () => {
    it("orders an open node schema by an undeclared stored key, in both directions", async () => {
      const store = await context.createStore(schemaFormGraph);
      await seedOpenDocuments(store);
      const query = store.query();

      const results = {
        looseAsc: titles(
          await query
            .from("OrderLooseDoc", "d")
            .orderBy("d", "extra", "asc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
        looseDesc: titles(
          await query
            .from("OrderLooseDoc", "d")
            .select((ctx) => ({ title: ctx.d.title }))
            .orderBy("d", "extra", "desc")
            .execute(),
        ),
        passthroughAsc: titles(
          await query
            .from("OrderPassthroughDoc", "d")
            .orderBy("d", "extra", "asc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
        catchallDesc: titles(
          await query
            .from("OrderCatchallDoc", "d")
            .orderBy("d", "extra", "desc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
      };
      expect(results).toEqual({
        looseAsc: EXTRA_ASC,
        looseDesc: EXTRA_DESC,
        passthroughAsc: EXTRA_ASC,
        catchallDesc: EXTRA_DESC,
      });
    });

    it("pages an open node schema by an undeclared stored key", async () => {
      const store = await context.createStore(schemaFormGraph);
      await seedOpenDocuments(store);
      const ordered = store
        .query()
        .from("OrderLooseDoc", "d")
        .orderBy("d", "extra", "asc")
        .select((ctx) => ({ title: ctx.d.title }));
      const first = await ordered.paginate({ first: 2 });
      const second = await ordered.paginate({
        first: 2,
        ...(first.nextCursor === undefined ? {} : { after: first.nextCursor }),
      });
      expect([...titles(first.data), ...titles(second.data)]).toEqual(
        EXTRA_ASC,
      );
    });

    it("orders an open edge schema by an undeclared stored key", async () => {
      const store = await context.createStore(schemaFormGraph);
      const hub = await store.nodes.OrderLooseDoc.create({ title: "hub" });
      for (const extra of EXTRA_VALUES) {
        const target = await store.nodes.OrderLooseDoc.create({ title: extra });
        await store.edges.orderLooseLink.create(hub, target, { extra });
      }
      const rows = await store
        .query()
        .from("OrderLooseDoc", "hub")
        .whereNode("hub", (node) => node.id.eq(hub.id))
        .traverse("orderLooseLink", "link")
        .to("OrderLooseDoc", "target")
        .orderBy("link", "extra", "desc")
        .select((ctx) => ({ title: ctx.target.title }))
        .execute();
      expect(titles(rows)).toEqual(EXTRA_DESC);
    });

    it("orders refined, super-refined and extended object schemas by a declared field and refuses an undeclared one", async () => {
      const store = await context.createStore(schemaFormGraph);
      for (const rank of [2, 3, 1]) {
        const title = `r${rank}`;
        await store.nodes.OrderRefinedDoc.create({ title, rank });
        await store.nodes.OrderSuperRefinedDoc.create({ title, rank });
        await store.nodes.OrderExtendedDoc.create({ title, rank });
      }
      const query = store.query();
      expect({
        refined: titles(
          await query
            .from("OrderRefinedDoc", "d")
            .orderBy("d", "rank", "asc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
        superRefined: titles(
          await query
            .from("OrderSuperRefinedDoc", "d")
            .orderBy("d", "rank", "desc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
        extended: titles(
          await query
            .from("OrderExtendedDoc", "d")
            .orderBy("d", "rank", "asc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
      }).toEqual({
        refined: ["r1", "r2", "r3"],
        superRefined: ["r3", "r2", "r1"],
        extended: ["r1", "r2", "r3"],
      });

      const refusal = orderRefusal(() =>
        // @ts-expect-error A refined object is still closed; `extra` is undeclared.
        query.from("OrderRefinedDoc", "d").orderBy("d", "extra"),
      );
      expect(refusal.details).toMatchObject({ code: "ORDER_FIELD_UNKNOWN" });
    });

    it("refuses an undeclared name on a strict schema and on a plain edge schema", async () => {
      const store = await context.createStore(schemaFormGraph);
      const query = store.query();
      const strict = orderRefusal(() =>
        // @ts-expect-error z.strictObject declares no `extra`.
        query.from("OrderStrictDoc", "d").orderBy("d", "extra"),
      );
      const plainEdge = orderRefusal(() =>
        query
          .from("OrderPlainDoc", "source")
          .traverse("orderPlainLink", "link")
          .to("OrderPlainDoc", "target")
          // @ts-expect-error orderPlainLink declares only `weight`.
          .orderBy("link", "extra"),
      );
      expect([strict.details, plainEdge.details]).toMatchObject([
        { code: "ORDER_FIELD_UNKNOWN", field: "extra" },
        { code: "ORDER_FIELD_UNKNOWN", field: "extra" },
      ]);
    });

    it("refuses a removed snake_case name on an open schema rather than reading a property of that name", async () => {
      const store = await context.createStore(schemaFormGraph);
      const query = store.query();
      // An open schema types every name, so the compiler cannot catch this.
      const refusal = orderRefusal(() =>
        query.from("OrderLooseDoc", "d").orderBy("d", "created_at"),
      );
      expect(refusal.details).toMatchObject({
        code: "ORDER_FIELD_RENAMED",
        replacement: "meta.createdAt",
      });
    });

    it("orders an open schema by an undeclared version key as a property, as before", async () => {
      const store = await context.createStore(schemaFormGraph);
      for (const version of [2, 3, 1]) {
        await store.nodes.OrderLooseDoc.create({
          title: `v${version}`,
          version,
        });
      }
      const rows = await store
        .query()
        .from("OrderLooseDoc", "d")
        .orderBy("d", "version", "desc")
        .select((ctx) => ({ title: ctx.d.title }))
        .execute();
      expect(titles(rows)).toEqual(["v3", "v2", "v1"]);
    });

    it("orders optional and nullable declared fields with nulls last ascending and first descending", async () => {
      const store = await context.createStore(schemaFormGraph);
      await store.nodes.OrderPlainDoc.create({
        title: "two",
        rank: 2,
        score: 2,
      });
      // eslint-disable-next-line unicorn/no-null -- a nullable field is the point
      await store.nodes.OrderPlainDoc.create({ title: "none", score: null });
      await store.nodes.OrderPlainDoc.create({
        title: "one",
        rank: 1,
        score: 1,
      });
      const query = store.query();
      const run = async (field: "rank" | "score", direction: "asc" | "desc") =>
        titles(
          await query
            .from("OrderPlainDoc", "d")
            .orderBy("d", field, direction)
            .orderBy("d", "id", "asc")
            .select((ctx) => ({ title: ctx.d.title }))
            .execute(),
        );
      expect({
        optionalAsc: await run("rank", "asc"),
        optionalDesc: await run("rank", "desc"),
        nullableAsc: await run("score", "asc"),
        nullableDesc: await run("score", "desc"),
      }).toEqual({
        optionalAsc: ["one", "two", "none"],
        optionalDesc: ["none", "two", "one"],
        nullableAsc: ["one", "two", "none"],
        nullableDesc: ["none", "two", "one"],
      });
    });

    it("agrees with the type on a multi-kind alias: a shared field is accepted, a field some kinds lack is refused", async () => {
      const store = await context.createStore(schemaFormGraph);
      await store.nodes.OrderPlainDoc.create({ title: "p", score: 1 });
      await store.nodes.OrderStrictDoc.create({ title: "s" });
      const query = store.query();
      const shared = await query
        .from(["OrderPlainDoc", "OrderStrictDoc"] as const, "d")
        .orderBy("d", "title", "asc")
        .select((ctx) => ({ title: ctx.d.title }))
        .execute();
      expect(titles(shared)).toEqual(["p", "s"]);

      const partial = orderRefusal(() =>
        query
          .from(["OrderPlainDoc", "OrderStrictDoc"] as const, "d")
          // @ts-expect-error OrderStrictDoc does not declare `score`.
          .orderBy("d", "score"),
      );
      expect(partial).toBeInstanceOf(ConfigurationError);

      const openAndClosed = orderRefusal(() =>
        query
          .from(["OrderLooseDoc", "OrderStrictDoc"] as const, "d")
          // @ts-expect-error The kinds share only `title`.
          .orderBy("d", "extra"),
      );
      expect(openAndClosed).toBeInstanceOf(ConfigurationError);
    });

    it("refuses a key that an onUnknownProperty: allow import stored outside a closed schema", async () => {
      const store = await context.createStore(schemaFormGraph);
      const result = await importGraph(
        store,
        {
          formatVersion: "2.0",
          exportedAt: "2026-01-01T00:00:00.000Z",
          source: { type: "external" },
          nodes: EXTRA_VALUES.map((extra) => ({
            kind: "OrderPlainDoc",
            id: `imported-${extra}`,
            // eslint-disable-next-line unicorn/no-null -- `score` is declared nullable
            properties: { title: extra, score: null, extra },
          })),
          edges: [],
        },
        ImportOptionsSchema.parse({
          onConflict: "error",
          onUnknownProperty: "allow",
        }),
      );
      expect(result.success).toBe(true);
      const refusal = orderRefusal(() =>
        store
          .query()
          .from("OrderPlainDoc", "d")
          // @ts-expect-error The schema is closed; declare `extra` to order by it.
          .orderBy("d", "extra"),
      );
      expect(refusal.details).toMatchObject({
        code: "ORDER_FIELD_UNKNOWN",
        field: "extra",
      });
    });
  });
}

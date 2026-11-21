/**
 * Generated SQL names on the standard query path: a statement whose names
 * would collide on some engine — after PostgreSQL clips them to 63 bytes, or
 * once letter case is ignored where SQL refers to them — or whose decoded
 * result column would be clipped, is refused with one typed `ValidationError`
 * on every backend before any SQL is sent. Every entry point checks the
 * statement it actually sends or hands out: `execute()` the one it sends,
 * `compile()`/`toSQL()` the one they return, `prepare()` every statement the
 * prepared query can run. Every query that worked on all backends keeps
 * working.
 */
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  max,
  min,
  type Store,
} from "../../../src";
import {
  SQL_IDENTIFIER_COLLISION_CODE,
  SQL_IDENTIFIER_TOO_LONG_CODE,
  ValidationError,
} from "../../../src/errors-entry";
import { compileNameCheckedQuery } from "../../../src/query/compiler";
import { requireDefined } from "../../../src/utils/presence";
import {
  createStatementCounter,
  type StatementCounter,
} from "./statement-counter";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    // A property whose selected output name meets the id of an alias `p_edge`.
    edge_id: z.string().optional(),
    age: z.number().optional(),
  }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const Score = defineNode("Score", {
  schema: z.object({ team: z.string(), points: z.number() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const worksAt = defineEdge("worksAt", { schema: z.object({}) });

const identifierGraph = defineGraph({
  id: "sql_identifier_identity",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Score: { type: Score },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});

type IdentifierStore = Store<typeof identifierGraph>;

/** Two 60-character aliases that share their first 59 characters. */
const CLIPPED_TWIN_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const CLIPPED_TWIN_B =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
/** Two 60-character aliases that share only their first 58 characters. */
const DISTINCT_TWIN_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1x";
const DISTINCT_TWIN_B =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2x";

type Seed = Readonly<{
  aliceId: string;
  bobId: string;
  acmeId: string;
  knowsId: string;
  worksAtId: string;
}>;

type Refusal = Readonly<{
  name: string;
  message: string;
  codes: readonly (string | undefined)[];
}>;

function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof Error)) throw error;
  return {
    name: error.name,
    message: error.message,
    // The distinct issue codes, in first-seen order.
    codes:
      error instanceof ValidationError ?
        [...new Set(error.details.issues.map((issue) => issue.code))]
      : [],
  };
}

async function captureRefusal(
  action: () => unknown,
): Promise<Refusal | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return describeRefusal(error);
  }
}

type SurfaceQuery = Readonly<{
  execute: () => Promise<unknown>;
  compile: () => unknown;
  toSQL: () => unknown;
  prepare: () => unknown;
}>;

type SurfaceRefusals = Readonly<{
  execute: Refusal | undefined;
  compile: Refusal | undefined;
  toSQL: Refusal | undefined;
  prepare: Refusal | undefined;
}>;

/**
 * Runs the four entry points of one query and returns the refusal each raised,
 * asserting that none of them sent a statement.
 */
async function refusalsBySurface(
  counter: StatementCounter,
  build: () => SurfaceQuery,
): Promise<SurfaceRefusals> {
  counter.reset();
  const refusals = {
    execute: await captureRefusal(() => build().execute()),
    compile: await captureRefusal(() => build().compile()),
    toSQL: await captureRefusal(() => build().toSQL()),
    prepare: await captureRefusal(() => build().prepare()),
  };
  expect(counter.count()).toBe(0);
  return refusals;
}

/** Asserts every entry point refuses with exactly `expected`. */
async function expectRefusedEverywhere(
  counter: StatementCounter,
  build: () => SurfaceQuery,
  expected: Refusal,
): Promise<void> {
  const refusals = await refusalsBySurface(counter, build);
  expect(refusals).toEqual({
    execute: expected,
    compile: expected,
    toSQL: expected,
    prepare: expected,
  });
}

function refusal(
  code: string,
  message: string,
  codes: readonly string[] = [code],
): Refusal {
  return {
    name: "ValidationError",
    message: `Query refused before any SQL was sent: ${message}`,
    codes,
  };
}

function collisionMessage(
  first: string,
  firstValue: string,
  second: string,
  secondValue: string,
  scope: string,
): string {
  return `"${first}" (${firstValue}) and "${second}" (${secondValue}) collide in ${scope}, which PostgreSQL clips to 63 bytes and the engines compare without regard to letter case.`;
}

/** The refusal of a statement that declares both `cte_item` and `cte_Item`. */
const ITEM_CASE_REFUSAL = refusal(
  SQL_IDENTIFIER_COLLISION_CODE,
  collisionMessage(
    "cte_item",
    'the rows of alias "item"',
    "cte_Item",
    'the rows of alias "Item"',
    "the WITH list",
  ),
);

async function seed(store: IdentifierStore): Promise<Seed> {
  const alice = await store.nodes.Person.create({
    name: "Alice",
    edge_id: "alice-property",
  });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const acme = await store.nodes.Company.create({ name: "Acme" });
  const knowsEdge = await store.edges.knows.create(alice, bob, {});
  const worksAtEdge = await store.edges.worksAt.create(alice, acme, {});
  return {
    aliceId: alice.id,
    bobId: bob.id,
    acmeId: acme.id,
    knowsId: knowsEdge.id,
    worksAtId: worksAtEdge.id,
  };
}

function idOf(value: unknown): unknown {
  return typeof value === "object" && value !== null ?
      (value as { id?: unknown }).id
    : value;
}

/** A props column as a row returns it: JSON text on SQLite, an object on PostgreSQL. */
function propsOf(value: unknown): Readonly<Record<string, unknown>> {
  return (typeof value === "string" ? JSON.parse(value) : value) as Readonly<
    Record<string, unknown>
  >;
}

const SQL_NAME_REFUSAL = "a typed SQL-name refusal";

/** Whether every issue of a refusal is a SQL-name issue. */
function isSqlNameRefusal(error: unknown): boolean {
  return (
    error instanceof ValidationError &&
    describeRefusal(error).codes.every(
      (code) =>
        code === SQL_IDENTIFIER_COLLISION_CODE ||
        code === SQL_IDENTIFIER_TOO_LONG_CODE,
    )
  );
}

type PropertyOutcome =
  | Readonly<{ refused: string }>
  | Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>;

/** The selector shapes the alias property drives through the standard path. */
type PropertyShape = "ids" | "whole rows" | "target name" | "projected name";

/** Runs a query and reduces it to its refusal or its normalized rows. */
async function propertyOutcome(
  execute: () => Promise<readonly unknown[]>,
  shape: PropertyShape,
): Promise<PropertyOutcome> {
  try {
    const rows = (await execute()) as readonly Readonly<
      Record<string, unknown>
    >[];
    return {
      rows: rows.map((row) => {
        switch (shape) {
          case "ids": {
            return {
              start: row["start"],
              edge: row["edge"],
              target: row["target"],
            };
          }
          case "whole rows": {
            return {
              start: row["start"],
              startName: row["startName"],
              edge: idOf(row["edge"]),
              target: idOf(row["target"]),
              targetName: (row["target"] as { name?: unknown }).name,
            };
          }
          case "target name":
          case "projected name": {
            return { name: row["name"] };
          }
        }
      }),
    };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return {
      refused:
        isSqlNameRefusal(error) ? SQL_NAME_REFUSAL : (
          describeRefusal(error).codes.join(", ")
        ),
    };
  }
}

/** A property `edge_id` of `p` beside the id of an edge alias `p_edge`. */
function propertyBesideEdgeId(store: IdentifierStore) {
  return store
    .query()
    .from("Person", "p")
    .traverse("worksAt", "p_edge")
    .to("Company", "c")
    .select((ctx) => ({ property: ctx.p.edge_id, edge: ctx.p_edge.id }));
}

/** Node `k` beside edge `K`, selecting only ids. */
function nodeBesideEdgeIds(store: IdentifierStore) {
  return store
    .query()
    .from("Person", "k")
    .traverse("knows", "K")
    .to("Person", "friend")
    .select((ctx) => ({ id: ctx.k.id, friend: ctx.friend.id }));
}

/** The team with the highest maximum, ordered by the output key `high`. */
function topTeam(store: IdentifierStore, low: string, high: string) {
  return store
    .query()
    .from("Score", "s")
    .groupBy("s", "team")
    .aggregate({
      team: field("s", "team"),
      [low]: min("s", "points"),
      [high]: max("s", "points"),
    })
    .orderBy(high, "desc")
    .limit(1);
}

export function registerSqlIdentifierIdentityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("generated SQL name identity", () => {
    let store: IdentifierStore;
    let counter: StatementCounter;
    let seeded: Seed;

    beforeEach(async () => {
      counter = createStatementCounter(context.getBackend());
      [store] = await createStoreWithSchema(identifierGraph, counter.backend);
      seeded = await seed(store);
    });

    describe("long aliases (#931)", () => {
      it("refuses reading the root id under a 61-character alias", async () => {
        const alias = `r${"o".repeat(60)}`;
        const tooLong = refusal(
          SQL_IDENTIFIER_TOO_LONG_CODE,
          `The result column "${alias}_id" (id of alias "${alias}") is 64 bytes long; PostgreSQL clips SQL names to 63 bytes, so the value would come back under a different name.`,
        );
        const refusals = await refusalsBySurface(counter, () =>
          store
            .query()
            .from("Person", alias)
            .select((ctx) => requireDefined(ctx[alias]).id),
        );
        // execute() sends the statement that reads only the id; prepare()
        // checks it first. compile() returns the full projection, whose
        // clipped column names already meet inside the start CTE.
        const fullProjection = refusals.compile;
        expect(fullProjection?.codes).toEqual([
          SQL_IDENTIFIER_COLLISION_CODE,
          SQL_IDENTIFIER_TOO_LONG_CODE,
        ]);
        expect(refusals).toEqual({
          execute: tooLong,
          compile: fullProjection,
          toSQL: fullProjection,
          prepare: tooLong,
        });
      });

      it("refuses selecting a whole node under a 62-character alias", async () => {
        const alias = `r${"o".repeat(61)}`;
        const refusals = await refusalsBySurface(counter, () =>
          store
            .query()
            .from("Person", alias)
            .select((ctx) => requireDefined(ctx[alias])),
        );
        const expectedFirst = collisionMessage(
          `${alias}_id`,
          `column id of alias "${alias}"`,
          `${alias}_kind`,
          `column kind of alias "${alias}"`,
          `the columns of cte_${alias}`,
        );
        for (const surfaceRefusal of Object.values(refusals)) {
          expect(surfaceRefusal?.name).toBe("ValidationError");
          expect(surfaceRefusal?.message).toBe(
            `Query refused before any SQL was sent: ${expectedFirst}`,
          );
          expect(surfaceRefusal?.codes).toContain(SQL_IDENTIFIER_TOO_LONG_CODE);
        }
      });

      it("refuses two 60-character aliases whose WITH names clip to one name", async () => {
        await expectRefusedEverywhere(
          counter,
          () =>
            store
              .query()
              .from("Person", CLIPPED_TWIN_A)
              .traverse("knows", "e")
              .to("Person", CLIPPED_TWIN_B)
              .project((ctx) => ({
                friend: requireDefined(ctx[CLIPPED_TWIN_B]).name,
              })),
          refusal(
            SQL_IDENTIFIER_COLLISION_CODE,
            collisionMessage(
              `cte_${CLIPPED_TWIN_A}`,
              `the rows of alias "${CLIPPED_TWIN_A}"`,
              `cte_${CLIPPED_TWIN_B}`,
              `the rows of alias "${CLIPPED_TWIN_B}"`,
              "the WITH list",
            ),
          ),
        );
      });

      it("keeps two 60-character aliases that differ within the clipped length", async () => {
        const rows = await store
          .query()
          .from("Person", DISTINCT_TWIN_A)
          .whereNode(DISTINCT_TWIN_A, (person) => person.id.eq(seeded.aliceId))
          .traverse("knows", "e")
          .to("Person", DISTINCT_TWIN_B)
          .project((ctx) => ({
            friend: requireDefined(ctx[DISTINCT_TWIN_B]).name,
          }))
          .execute();
        expect(rows).toEqual([{ friend: "Bob" }]);
      });
    });

    describe("names that meet across aliases", () => {
      it("refuses an edge alias `e` beside a node alias `e_from` when whole rows are selected", async () => {
        await expectRefusedEverywhere(
          counter,
          () =>
            store
              .query()
              .from("Person", "p")
              .traverse("worksAt", "e")
              .to("Company", "e_from")
              .select((ctx) => ({ edge: ctx.e, company: ctx.e_from })),
          refusal(
            SQL_IDENTIFIER_COLLISION_CODE,
            collisionMessage(
              "e_from_id",
              'column from_id of alias "e"',
              "e_from_id",
              'column id of alias "e_from"',
              "the columns of cte_e_from",
            ),
          ),
        );
      });

      it("keeps `e` beside `e_from` when only ids are selected", async () => {
        const rows = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "e_from")
          .select((ctx) => ({ edge: ctx.e.id, company: ctx.e_from.id }))
          .execute();
        expect(rows).toEqual([
          { edge: seeded.worksAtId, company: seeded.acmeId },
        ]);
      });

      it("keeps a projection of `e_from`'s name beside an edge `e` on every entry point, since neither copy of `e_from_id` is read", async () => {
        const query = store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "e_from")
          .project((ctx) => ({ name: ctx.e_from.name }));
        expect(await query.execute()).toEqual([{ name: "Acme" }]);
        expect(await query.prepare().execute({})).toEqual([{ name: "Acme" }]);
        const rows = await context
          .getBackend()
          .execute<Record<string, unknown>>(query.compile());
        expect(rows).toEqual([{ name: "Acme" }]);
        expect(() => query.toSQL()).not.toThrow();
      });

      it("executes a selector that reads only `e_from`'s name, while compile() refuses the full projection that reads both `e_from_id` columns", async () => {
        const query = store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "e_from")
          .select((ctx) => ({ name: ctx.e_from.name }));
        expect(await query.execute()).toEqual([{ name: "Acme" }]);
        const fullProjection = refusal(
          SQL_IDENTIFIER_COLLISION_CODE,
          collisionMessage(
            "e_from_id",
            'column from_id of alias "e"',
            "e_from_id",
            'column id of alias "e_from"',
            "the columns of cte_e_from",
          ),
        );
        counter.reset();
        expect(await captureRefusal(() => query.compile())).toEqual(
          fullProjection,
        );
        expect(await captureRefusal(() => query.toSQL())).toEqual(
          fullProjection,
        );
        // The prepared query can fall back to the full projection.
        expect(await captureRefusal(() => query.prepare())).toEqual(
          fullProjection,
        );
        expect(counter.count()).toBe(0);
      });

      it("refuses executing a property `edge_id` of `p` beside the id of `p_edge`, and hands out the full projection that keeps them apart", async () => {
        const selective = refusal(
          SQL_IDENTIFIER_COLLISION_CODE,
          '"p_edge_id" (property edge_id of alias "p") and "p_edge_id" (id of alias "p_edge") collide in the result columns once PostgreSQL clips them to 63 bytes.',
        );
        const refusals = await refusalsBySurface(counter, () =>
          propertyBesideEdgeId(store),
        );
        expect(refusals).toEqual({
          execute: selective,
          compile: undefined,
          toSQL: undefined,
          prepare: selective,
        });
        // The full projection carries the property inside `p_props`.
        const [row] = await context
          .getBackend()
          .execute<Record<string, unknown>>(
            propertyBesideEdgeId(store).compile(),
          );
        expect({
          property: propsOf(row?.["p_props"])["edge_id"],
          edge: row?.["p_edge_id"],
        }).toEqual({ property: "alice-property", edge: seeded.worksAtId });
      });
    });

    describe("aliases that differ only by letter case", () => {
      it("refuses node aliases `item` and `Item`", async () => {
        await expectRefusedEverywhere(
          counter,
          () =>
            store
              .query()
              .from("Person", "item")
              .traverse("knows", "e")
              .to("Person", "Item")
              .select((ctx) => ({ from: ctx.item.id, to: ctx.Item.id })),
          ITEM_CASE_REFUSAL,
        );
      });

      it("refuses node `k` beside edge `K` when whole rows are selected", async () => {
        await expectRefusedEverywhere(
          counter,
          () =>
            store
              .query()
              .from("Person", "k")
              .traverse("knows", "K")
              .to("Person", "friend")
              .select((ctx) => ({ person: ctx.k, edge: ctx.K })),
          refusal(
            SQL_IDENTIFIER_COLLISION_CODE,
            collisionMessage(
              "k_id",
              'column id of alias "k"',
              "K_id",
              'column id of alias "K"',
              "the columns of cte_friend",
            ),
          ),
        );
      });

      it("executes node `k` beside edge `K` selecting only ids, but refuses to hand out or prepare the full projection that reads both `k_id` and `K_id`", async () => {
        expect(await nodeBesideEdgeIds(store).execute()).toEqual([
          { id: seeded.aliceId, friend: seeded.bobId },
        ]);
        const fullProjection = refusal(
          SQL_IDENTIFIER_COLLISION_CODE,
          collisionMessage(
            "k_id",
            'column id of alias "k"',
            "K_id",
            'column id of alias "K"',
            "the columns of cte_friend",
          ),
        );
        counter.reset();
        expect({
          compile: await captureRefusal(() =>
            nodeBesideEdgeIds(store).compile(),
          ),
          toSQL: await captureRefusal(() => nodeBesideEdgeIds(store).toSQL()),
          prepare: await captureRefusal(() =>
            nodeBesideEdgeIds(store).prepare(),
          ),
        }).toEqual({
          compile: fullProjection,
          toSQL: fullProjection,
          prepare: fullProjection,
        });
        expect(counter.count()).toBe(0);
      });

      it("keeps a single mixed-case alias", async () => {
        const rows = await store
          .query()
          .from("Person", "Doc")
          .whereNode("Doc", (person) => person.id.eq(seeded.aliceId))
          .traverse("knows", "Knows")
          .to("Person", "Friend")
          .select((ctx) => ({
            doc: ctx.Doc.name,
            friend: ctx.Friend,
            edge: ctx.Knows.id,
          }))
          .execute();
        expect(
          rows.map((row) => ({
            doc: row.doc,
            friend: row.friend.id,
            edge: row.edge,
          })),
        ).toEqual([
          { doc: "Alice", friend: seeded.bobId, edge: seeded.knowsId },
        ]);
      });
    });

    it("runs the SQL compile() and toSQL() hand out for near-colliding aliases, returning the rows execute() returns", async () => {
      for (const [start, edge, target] of [
        ["p", "p_edge", "p_e"],
        ["Doc", "doc_K", "dOc_K2"],
      ] as const) {
        const query = store
          .query()
          .fromDynamic("Person", start as "compiled_start")
          .whereNode(start as "compiled_start", (person) =>
            person.id.eq(seeded.aliceId),
          )
          .traverseDynamic("knows", edge as "compiled_edge")
          .toDynamic("Person", target as "compiled_target")
          .select(
            (
              ctx: Readonly<
                Record<string, Readonly<{ id: string; name?: string }>>
              >,
            ) => ({
              start: requireDefined(ctx[start]),
              edge: requireDefined(ctx[edge]),
              target: requireDefined(ctx[target]),
            }),
          );
        const executedRows = await query.execute();
        const executed = executedRows.map((row) => ({
          start: row.start.id,
          startName: row.start.name,
          edge: row.edge.id,
          target: row.target.id,
          targetName: row.target.name,
        }));
        expect(executed).toEqual([
          {
            start: seeded.aliceId,
            startName: "Alice",
            edge: seeded.knowsId,
            target: seeded.bobId,
            targetName: "Bob",
          },
        ]);
        const backend = context.getBackend();
        const statements: (() => Promise<
          readonly Record<string, unknown>[]
        >)[] = [() => backend.execute(query.compile())];
        const executeRaw = backend.executeRaw;
        if (executeRaw !== undefined) {
          const { sql, params } = query.toSQL();
          statements.push(() => executeRaw(sql, params));
        }
        for (const statement of statements) {
          const rows = await statement();
          expect(
            rows.map((row) => ({
              start: row[`${start}_id`],
              startName: propsOf(row[`${start}_props`])["name"],
              edge: row[`${edge}_id`],
              target: row[`${target}_id`],
              targetName: propsOf(row[`${target}_props`])["name"],
            })),
          ).toEqual(executed);
        }
      }
    });

    describe("aggregate() keys", () => {
      it("returns a 63-byte key and a key that is not an identifier", async () => {
        const key = "k".repeat(63);
        const rows = await store
          .query()
          .from("Person", "p")
          .aggregate({ [key]: count("p"), "total count": count("p") })
          .execute();
        expect(rows).toEqual([{ [key]: 2, "total count": 2 }]);
      });

      it("refuses a key longer than 63 bytes, counting bytes rather than characters", async () => {
        for (const key of ["é".repeat(32), "k".repeat(70)]) {
          counter.reset();
          const refused = await captureRefusal(() =>
            store
              .query()
              .from("Person", "p")
              .aggregate({ [key]: count("p") })
              .execute(),
          );
          const bytes = new TextEncoder().encode(key).byteLength;
          expect(refused).toEqual(
            refusal(
              SQL_IDENTIFIER_TOO_LONG_CODE,
              `The result column "${key}" (the aggregate key "${key}") is ${bytes} bytes long; PostgreSQL clips SQL names to 63 bytes, so the value would come back under a different name.`,
            ),
          );
          expect(counter.count()).toBe(0);
        }
      });

      it("refuses a key in the reserved `__tg_` namespace in any letter case", async () => {
        for (const key of ["__tg_relation_order_0", "__TG_order_0"]) {
          const refused = await captureRefusal(() =>
            store
              .query()
              .from("Person", "p")
              .aggregate({ [key]: count("p") }),
          );
          expect(refused).toEqual({
            name: "ConfigurationError",
            message: "Projection output name is reserved.",
            codes: [],
          });
          expect(
            await captureRefusal(() =>
              store
                .query()
                .from("Person", "p")
                .project((ctx) => ({ [key]: ctx.p.name })),
            ),
          ).toEqual({
            name: "ConfigurationError",
            message: "Projection output name is reserved.",
            codes: [],
          });
        }
      });

      describe("ordering by an output key", () => {
        beforeEach(async () => {
          // Team "spread" has the highest maximum, team "steady" the highest
          // minimum: ordering by the wrong key picks the other team.
          for (const [team, points] of [
            ["spread", 1],
            ["spread", 5],
            ["steady", 3],
            ["steady", 3],
          ] as const)
            await store.nodes.Score.create({ team, points });
        });

        it("orders by the named key when the keys differ in more than letter case", async () => {
          expect(await topTeam(store, "lowest", "highest").execute()).toEqual([
            { team: "spread", lowest: 1, highest: 5 },
          ]);
        });

        it("refuses `total` and `Total` with ORDER BY `Total` on every terminal, before any SQL is sent", async () => {
          const expected = refusal(
            SQL_IDENTIFIER_COLLISION_CODE,
            '"total" (the value selected as "total") and "Total" (the value selected as "Total") collide in the result columns, which SQL refers to by name and the engines compare without regard to letter case.',
          );
          const query = topTeam(store, "total", "Total");
          const terminals: Readonly<Record<string, () => unknown>> = {
            execute: () => query.execute(),
            compile: () => query.compile(),
            toSQL: () => query.toSQL(),
            prepare: () => query.prepare(),
            first: () => query.first(),
            count: () => query.count(),
            exists: () => query.exists(),
            executeOn: () => query.executeOn(counter.backend),
          };
          counter.reset();
          const refusals: Record<string, Refusal | undefined> = {};
          for (const [terminal, run] of Object.entries(terminals))
            refusals[terminal] = await captureRefusal(run);
          expect(refusals).toEqual(
            Object.fromEntries(
              Object.keys(terminals).map((terminal) => [terminal, expected]),
            ),
          );
          expect(counter.count()).toBe(0);
        });
      });
    });

    it("refuses a standard-path query whose generated names collide on every public terminal of every builder, before any SQL is sent", async () => {
      const active = await counter.backend.getActiveSchema(store.graphId);
      const version = active?.version;
      function traversal() {
        return store
          .query()
          .from("Person", "item")
          .traverse("knows", "e")
          .to("Person", "Item");
      }
      function rows() {
        return traversal()
          .orderBy("item", "name")
          .select((ctx) => ({ from: ctx.item.name, to: ctx.Item.name }));
      }
      function projection() {
        return traversal().project((ctx) => ({
          source: ctx.item.name,
          target: ctx.Item.name,
        }));
      }
      function aggregate() {
        return traversal()
          .groupBy("item", "name")
          .aggregate({
            name: field("item", "name"),
            oldest: max("Item", "age"),
          });
      }
      const terminals: Readonly<Record<string, () => unknown>> = {
        "query builder count()": () => traversal().count(),
        "query builder exists()": () => traversal().exists(),
        "select execute()": () => rows().execute(),
        "select first()": () => rows().first(),
        "select count()": () => rows().count(),
        "select exists()": () => rows().exists(),
        "select executeOn()": () => rows().executeOn(counter.backend),
        "select executeChecked()": () => rows().executeChecked(version),
        "select compile()": () => rows().compile(),
        "select toSQL()": () => rows().toSQL(),
        "select prepare()": () => rows().prepare(),
        "select paginate()": () => rows().paginate({ first: 1 }),
        "select stream()": async () => {
          for await (const row of rows().stream()) return row;
          return;
        },
        "select page().execute()": () => rows().page({ first: 1 }).execute(),
        "select union()": () => rows().union(rows()).execute(),
        "select batch()": () => store.batch(rows(), rows()),
        "select batchOnce()": () => store.batchOnce(() => [rows()] as const),
        "select page() in batchOnce()": () =>
          store.batchOnce(() => [rows().page({ first: 1 })] as const),
        "select withCheckedReads()": () =>
          store.withCheckedReads(version, (reads) =>
            reads
              .query()
              .from("Person", "item")
              .traverse("knows", "e")
              .to("Person", "Item")
              .select((ctx) => ctx.item.name)
              .execute(),
          ),
        "updateWhere() candidates": () =>
          store.nodes.Person.updateWhere({
            candidates: traversal().select((ctx) => ctx.item.id),
            patch: { name: "updated" },
          }),
        "project execute()": () => projection().execute(),
        "project first()": () => projection().first(),
        "project count()": () => projection().count(),
        "project exists()": () => projection().exists(),
        "project executeOn()": () => projection().executeOn(counter.backend),
        "project compile()": () => projection().compile(),
        "project toSQL()": () => projection().toSQL(),
        "project prepare()": () => projection().prepare(),
        "project batchOnce()": () =>
          store.batchOnce(() => [projection()] as const),
        "project withCheckedReads()": () =>
          store.withCheckedReads(version, (reads) =>
            reads
              .query()
              .from("Person", "item")
              .traverse("knows", "e")
              .to("Person", "Item")
              .project((ctx) => ({ source: ctx.item.name }))
              .execute(),
          ),
        "aggregate execute()": () => aggregate().execute(),
        "aggregate first()": () => aggregate().first(),
        "aggregate count()": () => aggregate().count(),
        "aggregate exists()": () => aggregate().exists(),
        "aggregate executeOn()": () => aggregate().executeOn(counter.backend),
        "aggregate compile()": () => aggregate().compile(),
        "aggregate toSQL()": () => aggregate().toSQL(),
        "aggregate prepare()": () => aggregate().prepare(),
        "aggregate batchOnce()": () =>
          store.batchOnce(() => [aggregate()] as const),
      };
      counter.reset();
      const refusals: Record<string, Refusal | undefined> = {};
      for (const [terminal, run] of Object.entries(terminals))
        refusals[terminal] = await captureRefusal(run);
      expect(refusals).toEqual(
        Object.fromEntries(
          Object.keys(terminals).map((terminal) => [
            terminal,
            ITEM_CASE_REFUSAL,
          ]),
        ),
      );
      expect(counter.count()).toBe(0);
      expect(
        await store
          .query()
          .from("Person", "p")
          .whereNode("p", (person) => person.id.eq(seeded.aliceId))
          .select((ctx) => ctx.p.name)
          .execute(),
      ).toEqual(["Alice"]);
    });

    it("either refuses a query on every engine or returns exactly the right row (alias property)", async () => {
      const aliasPool = [
        "p",
        "P",
        "e",
        "E",
        "e_from",
        "E_from",
        "e_to",
        "item",
        "Item",
        "p_edge",
        CLIPPED_TWIN_A,
        CLIPPED_TWIN_B,
        DISTINCT_TWIN_A,
        `r${"o".repeat(60)}`,
      ];
      const aliasTriple = fc
        .tuple(
          fc.constantFrom(...aliasPool),
          fc.constantFrom(...aliasPool),
          fc.constantFrom(...aliasPool),
        )
        .filter(
          ([start, edge, target]) =>
            start !== edge && start !== target && edge !== target,
        );
      const shapes: readonly PropertyShape[] = [
        "ids",
        "whole rows",
        "target name",
        "projected name",
      ];

      await fc.assert(
        fc.asyncProperty(
          aliasTriple,
          fc.constantFrom(...shapes),
          async ([start, edge, target], shape) => {
            type Row = Readonly<{ id: unknown; name?: unknown }>;
            type Context = Readonly<Record<string, Row>>;
            const query = store
              .query()
              // Runtime aliases: the type-level alias-uniqueness check cannot
              // tell two `string`s apart, so each is typed as a distinct
              // placeholder literal.
              .fromDynamic("Person", start as "property_start")
              .whereNode(start as "property_start", (person) =>
                person.id.eq(seeded.aliceId),
              )
              .traverseDynamic("knows", edge as "property_edge")
              .toDynamic("Person", target as "property_target");
            const selected = (() => {
              switch (shape) {
                case "ids": {
                  return query.select((ctx: Context) => ({
                    start: requireDefined(ctx[start]).id,
                    edge: requireDefined(ctx[edge]).id,
                    target: requireDefined(ctx[target]).id,
                  }));
                }
                case "whole rows": {
                  return query.select((ctx: Context) => ({
                    start: requireDefined(ctx[start]).id,
                    startName: requireDefined(ctx[start]).name,
                    edge: requireDefined(ctx[edge]),
                    target: requireDefined(ctx[target]),
                  }));
                }
                case "target name": {
                  return query.select((ctx: Context) => ({
                    name: requireDefined(ctx[target]).name,
                  }));
                }
                case "projected name": {
                  return query.project(
                    (ctx) =>
                      ({
                        name: requireDefined(
                          (ctx as unknown as Readonly<Record<string, Row>>)[
                            target
                          ],
                        ).name,
                      }) as never,
                  );
                }
              }
            })();

            // The verdict on the statement compile() returns does not depend
            // on the dialect, so no query can be accepted on one backend and
            // refused on another.
            const [sqliteVerdict, postgresVerdict] = await Promise.all(
              (["sqlite", "postgres"] as const).map((dialect) =>
                captureRefusal(() =>
                  compileNameCheckedQuery(
                    selected.toAst(),
                    identifierGraph.id,
                    dialect,
                    "decoded",
                  ),
                ),
              ),
            );
            expect(sqliteVerdict).toEqual(postgresVerdict);

            // Either a typed refusal, or exactly the right row: never an
            // engine error and never another value's data.
            const outcome = await propertyOutcome(
              () => selected.execute(),
              shape,
            );
            const expectedRow = (() => {
              switch (shape) {
                case "ids": {
                  return {
                    start: seeded.aliceId,
                    edge: seeded.knowsId,
                    target: seeded.bobId,
                  };
                }
                case "whole rows": {
                  return {
                    start: seeded.aliceId,
                    startName: "Alice",
                    edge: seeded.knowsId,
                    target: seeded.bobId,
                    targetName: "Bob",
                  };
                }
                case "target name":
                case "projected name": {
                  return { name: "Bob" };
                }
              }
            })();
            expect(outcome).toEqual(
              "refused" in outcome ?
                { refused: SQL_NAME_REFUSAL }
              : { rows: [expectedRow] },
            );
          },
        ),
        { numRuns: 60, seed: 931 },
      );
    });
  });
}

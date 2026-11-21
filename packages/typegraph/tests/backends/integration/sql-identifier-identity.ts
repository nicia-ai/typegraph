/**
 * Generated SQL names on the standard query path: a query whose names would
 * collide on some engine — after PostgreSQL clips them to 63 bytes, or once
 * letter case is ignored — or whose decoded result column would be clipped, is
 * refused with one typed `ValidationError` on every backend before any SQL is
 * sent. Every query that worked on all backends keeps working.
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
  type Store,
} from "../../../src";
import {
  SQL_IDENTIFIER_COLLISION_CODE,
  SQL_IDENTIFIER_TOO_LONG_CODE,
  ValidationError,
} from "../../../src/errors-entry";
import { assertQuerySqlNames } from "../../../src/query/compiler";
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
  }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const worksAt = defineEdge("worksAt", { schema: z.object({}) });

const identifierGraph = defineGraph({
  id: "sql_identifier_identity",
  nodes: { Person: { type: Person }, Company: { type: Company } },
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

type Surface = "execute" | "compile" | "toSQL" | "prepare";

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

/**
 * Runs the four entry points of one query and returns the refusal each raised,
 * asserting that none of them sent a statement.
 */
async function refusalsBySurface(
  counter: StatementCounter,
  build: () => SurfaceQuery,
): Promise<Readonly<Record<Surface, Refusal | undefined>>> {
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

const SQL_NAME_REFUSAL = "a typed SQL-name refusal";

type PropertyOutcome =
  | Readonly<{ refused: string }>
  | Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>;

/** Runs a query and reduces it to its refusal codes or its normalized rows. */
async function propertyOutcome(
  execute: () => Promise<readonly unknown[]>,
  wholeRows: boolean,
): Promise<PropertyOutcome> {
  try {
    const rows = (await execute()) as readonly Readonly<
      Record<string, unknown>
    >[];
    return {
      rows: rows.map((row) => ({
        start: row["start"],
        edge: idOf(row["edge"]),
        target: idOf(row["target"]),
        ...(wholeRows ?
          {
            startName: row["startName"],
            targetName: (row["target"] as { name?: unknown }).name,
          }
        : {}),
      })),
    };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const codes = describeRefusal(error).codes;
    const typed = codes.every(
      (code) =>
        code === SQL_IDENTIFIER_COLLISION_CODE ||
        code === SQL_IDENTIFIER_TOO_LONG_CODE,
    );
    return { refused: typed ? SQL_NAME_REFUSAL : codes.join(", ") };
  }
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
        await expectRefusedEverywhere(
          counter,
          () =>
            store
              .query()
              .from("Person", alias)
              .select((ctx) => requireDefined(ctx[alias]).id),
          refusal(
            SQL_IDENTIFIER_TOO_LONG_CODE,
            `The result column "${alias}_id" (id of alias "${alias}") is 64 bytes long; PostgreSQL clips SQL names to 63 bytes, so the value would come back under a different name.`,
          ),
        );
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

      it("refuses a property `edge_id` of `p` beside the id of `p_edge`", async () => {
        await expectRefusedEverywhere(
          counter,
          () =>
            store
              .query()
              .from("Person", "p")
              .traverse("worksAt", "p_edge")
              .to("Company", "c")
              .select((ctx) => ({
                property: ctx.p.edge_id,
                edge: ctx.p_edge.id,
              })),
          refusal(
            SQL_IDENTIFIER_COLLISION_CODE,
            '"p_edge_id" (property edge_id of alias "p") and "p_edge_id" (id of alias "p_edge") collide in the result columns once PostgreSQL clips them to 63 bytes.',
          ),
        );
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
          refusal(
            SQL_IDENTIFIER_COLLISION_CODE,
            collisionMessage(
              "cte_item",
              'the rows of alias "item"',
              "cte_Item",
              'the rows of alias "Item"',
              "the WITH list",
            ),
          ),
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

      it("keeps node `k` beside edge `K` when only ids are selected, on every entry point", async () => {
        const query = store
          .query()
          .from("Person", "k")
          .traverse("knows", "K")
          .to("Person", "friend")
          .select((ctx) => ({ id: ctx.k.id, friend: ctx.friend.id }));
        expect(() => query.compile()).not.toThrow();
        expect(() => query.toSQL()).not.toThrow();
        const prepared = query.prepare();
        const expected = [{ id: seeded.aliceId, friend: seeded.bobId }];
        expect(await query.execute()).toEqual(expected);
        expect(await prepared.execute()).toEqual(expected);
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
    });

    it("either refuses a query on every engine or returns the right rows (alias property)", async () => {
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

      await fc.assert(
        fc.asyncProperty(
          aliasTriple,
          fc.boolean(),
          async ([start, edge, target], wholeRows) => {
            type Row = Readonly<{ id: unknown; name?: unknown }>;
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
            const selected =
              wholeRows ?
                query.select((ctx: Readonly<Record<string, Row>>) => ({
                  start: requireDefined(ctx[start]).id,
                  startName: requireDefined(ctx[start]).name,
                  edge: requireDefined(ctx[edge]),
                  target: requireDefined(ctx[target]),
                }))
              : query.select((ctx: Readonly<Record<string, Row>>) => ({
                  start: requireDefined(ctx[start]).id,
                  edge: requireDefined(ctx[edge]).id,
                  target: requireDefined(ctx[target]).id,
                }));

            // The verdict does not depend on the dialect, so no query can be
            // accepted on one backend and refused on another.
            const [sqliteVerdict, postgresVerdict] = await Promise.all(
              (["sqlite", "postgres"] as const).map((dialect) =>
                captureRefusal(() => {
                  assertQuerySqlNames(
                    selected.toAst(),
                    identifierGraph.id,
                    dialect,
                    "decoded",
                  );
                }),
              ),
            );
            expect(sqliteVerdict).toEqual(postgresVerdict);

            // Either a typed refusal, or exactly the right row: never an
            // engine error and never another value's data.
            const outcome = await propertyOutcome(
              () => selected.execute(),
              wholeRows,
            );
            expect(outcome).toEqual(
              "refused" in outcome ?
                { refused: SQL_NAME_REFUSAL }
              : {
                  rows: [
                    {
                      start: seeded.aliceId,
                      edge: seeded.knowsId,
                      target: seeded.bobId,
                      ...(wholeRows ?
                        { startName: "Alice", targetName: "Bob" }
                      : {}),
                    },
                  ],
                },
            );
          },
        ),
        { numRuns: 40, seed: 931 },
      );
    });
  });
}

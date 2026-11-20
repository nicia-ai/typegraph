import { beforeEach, describe, expect, it } from "vitest";

import { createStoreWithSchema, expr, param as parameter } from "../../../src";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { createStatementCounter } from "./statement-counter";
import { type IntegrationTestContext } from "./test-context";

const MIDNIGHT = "2024-01-01T00:00:00.000Z";
const JUST_BEFORE = "2023-12-31T23:59:59.999Z";
const MIDYEAR = "2024-06-01T12:00:00.000Z";

/**
 * Strings each backend compared differently before the date operators refused
 * them. The non-canonical ones name (or fail to name) an instant without being
 * the fixed-width UTC form a date property is stored in: a short form of a
 * stored instant sorts after it as text, a zoneless one is read in the
 * PostgreSQL session time zone, and a regex-shaped impossible date is refused
 * by one engine's cast only. The year-0000 ones are canonical text SQLite
 * compares as text, and PostgreSQL's `timestamptz` cast refuses
 * (`date/time field value out of range`).
 */
const REFUSED_STRINGS = [
  "2024-01-01",
  "2024-01-01T00:00:00Z",
  "2024-01-01T00:00:00.0Z",
  "2024-01-01T01:00:00.000+01:00",
  "2024-01-01T00:00:00.000",
  "2024-02-30T00:00:00.000Z",
  "not a date",
  "0000-01-01T00:00:00.000Z",
  "0000-12-31T23:59:59.999Z",
] as const;

/**
 * Valid `Date`s no backend-portable comparison takes. One's `toISOString()`
 * is the six-digit extended-year form (`+010000-…`), which as text sorts
 * before every four-digit year; the other falls in year 0000, which
 * PostgreSQL's `timestamptz` cast refuses.
 */
const REFUSED_DATES = {
  extendedYear: new Date("+010000-01-01T00:00:00.000Z"),
  yearZero: new Date("0000-06-01T00:00:00.000Z"),
} as const;

/** The first and last instants every backend compares the same way. */
const FIRST_COMPARABLE = "0001-01-01T00:00:00.000Z";
const LAST_COMPARABLE = "9999-12-31T23:59:59.999Z";

async function seedDatedDocuments(store: IntegrationStore): Promise<void> {
  await store.nodes.Document.create({
    title: "just-before",
    publishedAt: new Date(JUST_BEFORE),
  });
  await store.nodes.Document.create({
    title: "midnight",
    publishedAt: new Date(MIDNIGHT),
  });
  await store.nodes.Document.create({
    title: "midyear",
    publishedAt: new Date(MIDYEAR),
    metadata: { publishedAt: new Date(MIDYEAR) },
  });
}

/** The error a run throws, by name, or `"ran"` when it does not throw. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ran";
  } catch (error) {
    return error instanceof Error ? error.name : typeof error;
  }
}

type QueryStore = Pick<IntegrationStore, "query">;

function queryDocuments(store: QueryStore) {
  return store.query().from("Document", "d");
}

function sortedTitles(rows: readonly string[]): readonly string[] {
  return rows.toSorted();
}

function titlesOf(
  rows: readonly Readonly<{ title: string }>[],
): readonly string[] {
  return rows.map((row) => row.title);
}

function sortedRows(
  rows: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(rows).map(([name, titles]) => [name, sortedTitles(titles)]),
  );
}

/**
 * A store over the lane's backend whose statements are counted, on the
 * packed raw-SQL path a prepared query takes when the backend has
 * `executeRaw`, or on the AST-substitution fallback it takes without one.
 */
async function countedStore(
  context: IntegrationTestContext,
  path: "packed" | "fallback",
) {
  const counter = createStatementCounter(context.getBackend(), {
    withoutRawExecution: path === "fallback",
  });
  const [store] = await createStoreWithSchema(
    integrationTestGraph,
    counter.backend,
  );
  counter.reset();
  return { store, counter };
}

/** Every operand position a date comparison takes, refused or run. */
async function dateOperandOutcomes(
  store: QueryStore,
  operand: string,
): Promise<Readonly<Record<string, string>>> {
  const boundGte = queryDocuments(store)
    .whereNode("d", (d) => d.publishedAt.gte(parameter("from")))
    .select((ctx) => ctx.d.title)
    .prepare();
  const boundBetween = queryDocuments(store)
    .whereNode("d", (d) =>
      d.publishedAt.between(parameter("lower"), parameter("upper")),
    )
    .select((ctx) => ctx.d.title)
    .prepare();
  const boundEq = queryDocuments(store)
    .whereNode("d", (d) => d.publishedAt.eq(parameter("at")))
    .select((ctx) => ctx.d.title)
    .prepare();
  const boundIn = queryDocuments(store)
    .whereNode("d", (d) => d.publishedAt.in(parameter("instants")))
    .select((ctx) => ctx.d.title)
    .prepare();
  const boundExpression = queryDocuments(store)
    .where((ctx) => expr.gte(ctx.d.publishedAt, expr.param("from", "date")))
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();
  const boundComposed = queryDocuments(store)
    .where((ctx) =>
      expr.gte(
        expr.coalesce(ctx.d.publishedAt, expr.literal(new Date(MIDYEAR))),
        expr.param("from", "date"),
      ),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();
  const boundInsideComposed = queryDocuments(store)
    .where((ctx) =>
      expr.gte(
        expr.coalesce(ctx.d.publishedAt, expr.param("fallback", "date")),
        expr.literal(new Date(MIDNIGHT)),
      ),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();
  const boundConditional = queryDocuments(store)
    .where((ctx) =>
      expr.lt(
        expr.when(
          expr.isNull(ctx.d.publishedAt),
          expr.param("otherwise", "date"),
          ctx.d.publishedAt,
        ),
        expr.literal(new Date(MIDNIGHT)),
      ),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();

  return {
    gte: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.gte(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    lt: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.lt(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    betweenLower: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.between(operand, MIDYEAR))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    betweenUpper: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.between(JUST_BEFORE, operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    nested: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.metadata.get("publishedAt").gte(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    metadata: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.$meta.createdAt.gte(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    boundGte: await refusal(() => boundGte.execute({ from: operand })),
    boundBetween: await refusal(() =>
      boundBetween.execute({ lower: JUST_BEFORE, upper: operand }),
    ),
    boundEq: await refusal(() => boundEq.execute({ at: operand })),
    boundIn: await refusal(() =>
      boundIn.execute({ instants: [MIDNIGHT, operand] }),
    ),
    boundExpression: await refusal(() =>
      boundExpression.execute({ from: operand }),
    ),
    boundComposed: await refusal(() =>
      boundComposed.execute({ from: operand }),
    ),
    boundInsideComposed: await refusal(() =>
      boundInsideComposed.execute({ fallback: operand }),
    ),
    boundConditional: await refusal(() =>
      boundConditional.execute({ otherwise: operand }),
    ),
  };
}

/** Every position a `Date` operand takes, refused or run. */
async function dateValueOutcomes(
  store: QueryStore,
  operand: Date,
): Promise<Readonly<Record<string, string>>> {
  const boundGte = queryDocuments(store)
    .whereNode("d", (d) => d.publishedAt.gte(parameter("from")))
    .select((ctx) => ctx.d.title)
    .prepare();
  const boundComposed = queryDocuments(store)
    .where((ctx) =>
      expr.gte(
        expr.coalesce(ctx.d.publishedAt, expr.literal(new Date(MIDYEAR))),
        expr.param("from", "date"),
      ),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();

  return {
    literal: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.lt(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    eq: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.eq(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    listElement: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.in([operand]))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    expressionLiteral: await refusal(() =>
      queryDocuments(store)
        .where((ctx) => expr.lt(ctx.d.publishedAt, expr.literal(operand)))
        .project((ctx) => ({ title: ctx.d.title }))
        .execute(),
    ),
    composedLiteral: await refusal(() =>
      queryDocuments(store)
        .where((ctx) =>
          expr.lt(
            expr.coalesce(ctx.d.publishedAt, expr.literal(new Date(MIDYEAR))),
            expr.literal(operand),
          ),
        )
        .project((ctx) => ({ title: ctx.d.title }))
        .execute(),
    ),
    literalInsideComposed: await refusal(() =>
      queryDocuments(store)
        .where((ctx) =>
          expr.lt(
            expr.coalesce(ctx.d.publishedAt, expr.literal(operand)),
            expr.literal(new Date(MIDYEAR)),
          ),
        )
        .project((ctx) => ({ title: ctx.d.title }))
        .execute(),
    ),
    bound: await refusal(() => boundGte.execute({ from: operand })),
    boundComposed: await refusal(() =>
      boundComposed.execute({ from: operand }),
    ),
    metadata: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.$meta.createdAt.lt(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
  };
}

export function registerDatePredicateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Date property predicates", () => {
    beforeEach(async () => {
      await seedDatedDocuments(context.getStore());
    });

    it.each(["packed", "fallback"] as const)(
      "refuses a non-canonical or uncastable string operand in every position, literal or bound, before any SQL runs (%s prepared path)",
      async (path) => {
        const { store, counter } = await countedStore(context, path);

        const outcomes: Record<string, Readonly<Record<string, string>>> = {};
        for (const operand of REFUSED_STRINGS) {
          outcomes[operand] = await dateOperandOutcomes(store, operand);
        }
        const refusedStatements = counter.count();

        const refusedEverywhere = {
          gte: "UnsupportedPredicateError",
          lt: "UnsupportedPredicateError",
          betweenLower: "UnsupportedPredicateError",
          betweenUpper: "UnsupportedPredicateError",
          nested: "UnsupportedPredicateError",
          metadata: "ValidationError",
          boundGte: "UnsupportedPredicateError",
          boundBetween: "UnsupportedPredicateError",
          boundEq: "UnsupportedPredicateError",
          boundIn: "UnsupportedPredicateError",
          boundExpression: "UnsupportedPredicateError",
          boundComposed: "UnsupportedPredicateError",
          boundInsideComposed: "UnsupportedPredicateError",
          boundConditional: "UnsupportedPredicateError",
        };
        expect(outcomes).toEqual(
          Object.fromEntries(
            REFUSED_STRINGS.map((operand) => [operand, refusedEverywhere]),
          ),
        );
        expect(refusedStatements).toBe(0);

        // The counter observes this store's statements: the same positions
        // with a canonical operand all run, each through SQL.
        expect(
          Object.values(await dateOperandOutcomes(store, MIDNIGHT)),
        ).toEqual(Array.from({ length: 14 }, () => "ran"));
        expect(counter.count()).toBeGreaterThanOrEqual(14);
      },
    );

    it("refuses a Date outside the years 0001 to 9999 in every position, before any SQL runs", async () => {
      const { store, counter } = await countedStore(context, "packed");

      const outcomes = {
        extendedYear: await dateValueOutcomes(
          store,
          REFUSED_DATES.extendedYear,
        ),
        yearZero: await dateValueOutcomes(store, REFUSED_DATES.yearZero),
      };

      const refusedEverywhere = {
        literal: "UnsupportedPredicateError",
        eq: "UnsupportedPredicateError",
        listElement: "UnsupportedPredicateError",
        expressionLiteral: "UnsupportedPredicateError",
        composedLiteral: "UnsupportedPredicateError",
        literalInsideComposed: "UnsupportedPredicateError",
        bound: "UnsupportedPredicateError",
        boundComposed: "UnsupportedPredicateError",
        metadata: "ValidationError",
      };
      expect(outcomes).toEqual({
        extendedYear: refusedEverywhere,
        yearZero: refusedEverywhere,
      });
      expect(counter.count()).toBe(0);
    });

    it("compares the first and last comparable instants to the same rows on every backend", async () => {
      const store = context.getStore();
      const rows = {
        gteFirst: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.gte(FIRST_COMPARABLE))
          .select((ctx) => ctx.d.title)
          .execute(),
        gteFirstDate: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.gte(new Date(FIRST_COMPARABLE)))
          .select((ctx) => ctx.d.title)
          .execute(),
        lteLast: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.lte(LAST_COMPARABLE))
          .select((ctx) => ctx.d.title)
          .execute(),
        ltFirst: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.lt(FIRST_COMPARABLE))
          .select((ctx) => ctx.d.title)
          .execute(),
        metadataGteFirst: await queryDocuments(store)
          .whereNode("d", (d) => d.$meta.createdAt.gte(FIRST_COMPARABLE))
          .select((ctx) => ctx.d.title)
          .execute(),
      };

      expect(sortedRows(rows)).toEqual({
        gteFirst: ["just-before", "midnight", "midyear"],
        gteFirstDate: ["just-before", "midnight", "midyear"],
        lteLast: ["just-before", "midnight", "midyear"],
        ltFirst: [],
        metadataGteFirst: ["just-before", "midnight", "midyear"],
      });
    });

    it("compares a canonical string and the equivalent Date to the same rows on every backend", async () => {
      const store = context.getStore();
      const boundGte = queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.gte(parameter("from")))
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundBetween = queryDocuments(store)
        .whereNode("d", (d) =>
          d.publishedAt.between(parameter("lower"), parameter("upper")),
        )
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundIn = queryDocuments(store)
        .whereNode("d", (d) => d.publishedAt.in(parameter("instants")))
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundComposed = queryDocuments(store)
        .where((ctx) =>
          expr.gte(
            expr.coalesce(ctx.d.publishedAt, expr.literal(new Date(MIDYEAR))),
            expr.param("from", "date"),
          ),
        )
        .project((ctx) => ({ title: ctx.d.title }))
        .prepare();

      const rows = {
        gteString: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.gte(MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        gteDate: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.gte(new Date(MIDNIGHT)))
          .select((ctx) => ctx.d.title)
          .execute(),
        ltString: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.lt(MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        betweenString: await queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.between(JUST_BEFORE, MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        nested: await queryDocuments(store)
          .whereNode("d", (d) => d.metadata.get("publishedAt").gte(MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        boundString: await boundGte.execute({ from: MIDNIGHT }),
        boundDate: await boundGte.execute({ from: new Date(MIDNIGHT) }),
        boundBetween: await boundBetween.execute({
          lower: MIDNIGHT,
          upper: MIDYEAR,
        }),
        boundBetweenDates: await boundBetween.execute({
          lower: new Date(MIDNIGHT),
          upper: new Date(MIDYEAR),
        }),
        boundIn: await boundIn.execute({ instants: [MIDNIGHT] }),
        boundComposedString: titlesOf(
          await boundComposed.execute({ from: MIDNIGHT }),
        ),
        boundComposedDate: titlesOf(
          await boundComposed.execute({ from: new Date(MIDNIGHT) }),
        ),
      };

      expect(sortedRows(rows)).toEqual({
        gteString: ["midnight", "midyear"],
        gteDate: ["midnight", "midyear"],
        ltString: ["just-before"],
        betweenString: ["just-before", "midnight"],
        nested: ["midyear"],
        boundString: ["midnight", "midyear"],
        boundDate: ["midnight", "midyear"],
        boundBetween: ["midnight", "midyear"],
        boundBetweenDates: ["midnight", "midyear"],
        boundIn: ["midnight"],
        boundComposedString: ["midnight", "midyear"],
        boundComposedDate: ["midnight", "midyear"],
      });
    });

    it.each(["packed", "fallback"] as const)(
      "takes a Date and a canonical string mixed in one in() list or between() on the %s prepared path",
      async (path) => {
        const { store } = await countedStore(context, path);
        const boundIn = queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.in(parameter("instants")))
          .select((ctx) => ctx.d.title)
          .prepare();
        const boundNotIn = queryDocuments(store)
          .whereNode("d", (d) => d.publishedAt.notIn(parameter("instants")))
          .select((ctx) => ctx.d.title)
          .prepare();
        const boundBetween = queryDocuments(store)
          .whereNode("d", (d) =>
            d.publishedAt.between(parameter("lower"), parameter("upper")),
          )
          .select((ctx) => ctx.d.title)
          .prepare();

        const rows = {
          in: await boundIn.execute({
            instants: [new Date(MIDNIGHT), MIDYEAR],
          }),
          notIn: await boundNotIn.execute({
            instants: [MIDNIGHT, new Date(MIDYEAR)],
          }),
          betweenDateLower: await boundBetween.execute({
            lower: new Date(JUST_BEFORE),
            upper: MIDNIGHT,
          }),
          betweenDateUpper: await boundBetween.execute({
            lower: MIDNIGHT,
            upper: new Date(MIDYEAR),
          }),
          literalBetween: await queryDocuments(store)
            .whereNode("d", (d) =>
              d.publishedAt.between(new Date(JUST_BEFORE), MIDNIGHT),
            )
            .select((ctx) => ctx.d.title)
            .execute(),
        };

        expect(sortedRows(rows)).toEqual({
          in: ["midnight", "midyear"],
          notIn: ["just-before"],
          betweenDateLower: ["just-before", "midnight"],
          betweenDateUpper: ["midnight", "midyear"],
          literalBetween: ["just-before", "midnight"],
        });
      },
    );

    it("names the property, not the props column, when it refuses a date operand", () => {
      const messages = {
        eqString: refusalMessage(() =>
          queryDocuments(context.getStore()).whereNode("d", (d) =>
            // @ts-expect-error -- eq on a date property is typed Date
            d.publishedAt.eq(MIDNIGHT),
          ),
        ),
        rangeString: refusalMessage(() =>
          queryDocuments(context.getStore()).whereNode("d", (d) =>
            d.publishedAt.gte("2024-01-01"),
          ),
        ),
        nestedString: refusalMessage(() =>
          queryDocuments(context.getStore()).whereNode("d", (d) =>
            d.metadata.get("publishedAt").gte("2024-01-01"),
          ),
        ),
      };

      expect(messages.eqString).toContain('"d.publishedAt"');
      expect(messages.rangeString).toContain('"d.publishedAt"');
      expect(messages.nestedString).toContain('"d.metadata.publishedAt"');
      expect(Object.values(messages).join("\n")).not.toContain("d.props");
    });
  });
}

function refusalMessage(run: () => unknown): string {
  try {
    run();
    return "ran";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

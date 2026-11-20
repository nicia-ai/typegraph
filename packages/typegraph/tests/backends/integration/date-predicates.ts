import { beforeEach, describe, expect, it } from "vitest";

import { expr, param as parameter } from "../../../src";
import { type IntegrationStore } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const MIDNIGHT = "2024-01-01T00:00:00.000Z";
const JUST_BEFORE = "2023-12-31T23:59:59.999Z";
const MIDYEAR = "2024-06-01T12:00:00.000Z";

/**
 * Strings that name (or fail to name) an instant without being the canonical
 * fixed-width UTC form a date property is stored in. Each one compared
 * differently on SQLite (text) and PostgreSQL (`timestamptz`) before the
 * range operators refused them: a short form of a stored instant sorts after
 * it as text, a zoneless one is read in the PostgreSQL session time zone, and
 * a regex-shaped impossible date is refused by one engine's cast only.
 */
const NON_CANONICAL = [
  "2024-01-01",
  "2024-01-01T00:00:00Z",
  "2024-01-01T00:00:00.0Z",
  "2024-01-01T01:00:00.000+01:00",
  "2024-01-01T00:00:00.000",
  "2024-02-30T00:00:00.000Z",
  "not a date",
] as const;

/**
 * A valid `Date` whose `toISOString()` is the six-digit extended-year form
 * (`+010000-…`). As text it sorts before every four-digit year, so SQLite and
 * PostgreSQL disagreed on it exactly as they did on a non-canonical string.
 */
const EXTENDED_YEAR = new Date("+010000-01-01T00:00:00.000Z");

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

function queryDocuments(context: IntegrationTestContext) {
  return context.getStore().query().from("Document", "d");
}

function sortedTitles(rows: readonly string[]): readonly string[] {
  return rows.toSorted();
}

export function registerDatePredicateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Date property predicates", () => {
    beforeEach(async () => {
      await seedDatedDocuments(context.getStore());
    });

    it("refuses a non-canonical string operand on every range form, literal or bound, before any SQL runs", async () => {
      const boundGte = queryDocuments(context)
        .whereNode("d", (d) => d.publishedAt.gte(parameter("from")))
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundBetween = queryDocuments(context)
        .whereNode("d", (d) =>
          d.publishedAt.between(parameter("lower"), parameter("upper")),
        )
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundEq = queryDocuments(context)
        .whereNode("d", (d) => d.publishedAt.eq(parameter("at")))
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundIn = queryDocuments(context)
        .whereNode("d", (d) => d.publishedAt.in(parameter("instants")))
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundExpression = queryDocuments(context)
        .where((ctx) => expr.gte(ctx.d.publishedAt, expr.param("from", "date")))
        .project((ctx) => ({ title: ctx.d.title }))
        .prepare();

      const outcomes: Record<string, Record<string, string>> = {};
      for (const operand of NON_CANONICAL) {
        outcomes[operand] = {
          gte: await refusal(() =>
            queryDocuments(context)
              .whereNode("d", (d) => d.publishedAt.gte(operand))
              .select((ctx) => ctx.d.title)
              .execute(),
          ),
          lt: await refusal(() =>
            queryDocuments(context)
              .whereNode("d", (d) => d.publishedAt.lt(operand))
              .select((ctx) => ctx.d.title)
              .execute(),
          ),
          betweenLower: await refusal(() =>
            queryDocuments(context)
              .whereNode("d", (d) => d.publishedAt.between(operand, MIDYEAR))
              .select((ctx) => ctx.d.title)
              .execute(),
          ),
          betweenUpper: await refusal(() =>
            queryDocuments(context)
              .whereNode("d", (d) =>
                d.publishedAt.between(JUST_BEFORE, operand),
              )
              .select((ctx) => ctx.d.title)
              .execute(),
          ),
          nested: await refusal(() =>
            queryDocuments(context)
              .whereNode("d", (d) => d.metadata.get("publishedAt").gte(operand))
              .select((ctx) => ctx.d.title)
              .execute(),
          ),
          expressionLiteral: await refusal(() =>
            queryDocuments(context)
              .where((ctx) =>
                // @ts-expect-error -- a string literal is not a date expression
                expr.gte(ctx.d.publishedAt, expr.literal(operand)),
              )
              .project((ctx) => ({ title: ctx.d.title }))
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
        };
      }

      const refusedEverywhere = {
        gte: "UnsupportedPredicateError",
        lt: "UnsupportedPredicateError",
        betweenLower: "UnsupportedPredicateError",
        betweenUpper: "UnsupportedPredicateError",
        nested: "UnsupportedPredicateError",
        // The expression context types a string literal as a string, which
        // it already refuses to compare with a date expression.
        expressionLiteral: "TypeError",
        boundGte: "UnsupportedPredicateError",
        boundBetween: "UnsupportedPredicateError",
        boundEq: "UnsupportedPredicateError",
        boundIn: "UnsupportedPredicateError",
        boundExpression: "UnsupportedPredicateError",
      };
      expect(outcomes).toEqual(
        Object.fromEntries(
          NON_CANONICAL.map((operand) => [operand, refusedEverywhere]),
        ),
      );
    });

    it("refuses a Date outside the four-digit-year range on a property and on $meta", async () => {
      const boundGte = queryDocuments(context)
        .whereNode("d", (d) => d.publishedAt.gte(parameter("from")))
        .select((ctx) => ctx.d.title)
        .prepare();

      const outcomes = {
        literal: await refusal(() =>
          queryDocuments(context)
            .whereNode("d", (d) => d.publishedAt.lt(EXTENDED_YEAR))
            .select((ctx) => ctx.d.title)
            .execute(),
        ),
        eq: await refusal(() =>
          queryDocuments(context)
            .whereNode("d", (d) => d.publishedAt.eq(EXTENDED_YEAR))
            .select((ctx) => ctx.d.title)
            .execute(),
        ),
        listElement: await refusal(() =>
          queryDocuments(context)
            .whereNode("d", (d) => d.publishedAt.in([EXTENDED_YEAR]))
            .select((ctx) => ctx.d.title)
            .execute(),
        ),
        expressionLiteral: await refusal(() =>
          queryDocuments(context)
            .where((ctx) =>
              expr.lt(ctx.d.publishedAt, expr.literal(EXTENDED_YEAR)),
            )
            .project((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
        bound: await refusal(() => boundGte.execute({ from: EXTENDED_YEAR })),
        metadata: await refusal(() =>
          queryDocuments(context)
            .whereNode("d", (d) => d.$meta.createdAt.lt(EXTENDED_YEAR))
            .select((ctx) => ctx.d.title)
            .execute(),
        ),
      };

      expect(outcomes).toEqual({
        literal: "UnsupportedPredicateError",
        eq: "UnsupportedPredicateError",
        listElement: "UnsupportedPredicateError",
        expressionLiteral: "UnsupportedPredicateError",
        bound: "UnsupportedPredicateError",
        metadata: "ValidationError",
      });
    });

    it("compares a canonical string and the equivalent Date to the same rows on every backend", async () => {
      const boundGte = queryDocuments(context)
        .whereNode("d", (d) => d.publishedAt.gte(parameter("from")))
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundBetween = queryDocuments(context)
        .whereNode("d", (d) =>
          d.publishedAt.between(parameter("lower"), parameter("upper")),
        )
        .select((ctx) => ctx.d.title)
        .prepare();
      const boundIn = queryDocuments(context)
        .whereNode("d", (d) => d.publishedAt.in(parameter("instants")))
        .select((ctx) => ctx.d.title)
        .prepare();

      const rows = {
        gteString: await queryDocuments(context)
          .whereNode("d", (d) => d.publishedAt.gte(MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        gteDate: await queryDocuments(context)
          .whereNode("d", (d) => d.publishedAt.gte(new Date(MIDNIGHT)))
          .select((ctx) => ctx.d.title)
          .execute(),
        ltString: await queryDocuments(context)
          .whereNode("d", (d) => d.publishedAt.lt(MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        betweenString: await queryDocuments(context)
          .whereNode("d", (d) => d.publishedAt.between(JUST_BEFORE, MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        nested: await queryDocuments(context)
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
      };

      expect(
        Object.fromEntries(
          Object.entries(rows).map(([name, titles]) => [
            name,
            sortedTitles(titles),
          ]),
        ),
      ).toEqual({
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
      });
    });

    it("names the property, not the props column, when it refuses a date operand", () => {
      const messages = {
        eqString: refusalMessage(() =>
          queryDocuments(context).whereNode("d", (d) =>
            // @ts-expect-error -- eq on a date property is typed Date
            d.publishedAt.eq(MIDNIGHT),
          ),
        ),
        rangeString: refusalMessage(() =>
          queryDocuments(context).whereNode("d", (d) =>
            d.publishedAt.gte("2024-01-01"),
          ),
        ),
        nestedString: refusalMessage(() =>
          queryDocuments(context).whereNode("d", (d) =>
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

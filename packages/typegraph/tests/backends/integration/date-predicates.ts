import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeId,
  expr,
  inSubquery,
  type Node,
  notInSubquery,
  param as parameter,
} from "../../../src";
import { TrustedImportError } from "../../../src/errors-entry";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  trustedImportGraph,
} from "../../../src/interchange";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { jsonPointer } from "../../../src/query/json-pointer";
import { fieldRef } from "../../../src/query/predicates";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../../src/query/sql-intent";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { createStatementCounter } from "./statement-counter";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

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
    revisedAt: [new Date(JUST_BEFORE)],
  });
  await store.nodes.Document.create({
    title: "midnight",
    publishedAt: new Date(MIDNIGHT),
    revisedAt: [new Date(MIDNIGHT)],
    metadata: { revisedAt: [new Date(MIDNIGHT)] },
  });
  await store.nodes.Document.create({
    title: "midyear",
    publishedAt: new Date(MIDYEAR),
    revisedAt: [new Date(MIDNIGHT), new Date(MIDYEAR)],
    metadata: {
      publishedAt: new Date(MIDYEAR),
      revisedAt: [new Date(MIDYEAR)],
    },
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

/** The `publishedAt` property as an `in`/`notIn` subquery compares it. */
const PUBLISHED_AT_FIELD = fieldRef("d", ["props"], {
  jsonPointer: jsonPointer(["publishedAt"]),
  valueType: "date",
});

/**
 * Every membership and subquery position a date operand takes,
 * refused or run: a membership test against a date array (the expression
 * context's `arrayContains`, directly or through a `coalesce`, and the
 * predicate builder's `contains`, `containsAll`, `containsAny` and
 * `pathContains`), a JSON-path equality with a date value, a date projected by
 * a `$scalar()` or an `in` subquery.
 */
async function membershipOperandOutcomes(
  store: Pick<IntegrationStore, "query" | "nodes">,
  operand: string,
): Promise<Readonly<Record<string, string>>> {
  const boundArrayContains = queryDocuments(store)
    .where((ctx) =>
      expr.arrayContains(ctx.d.revisedAt, expr.param("at", "date")),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();
  const boundComposedArrayContains = queryDocuments(store)
    .where((ctx) =>
      expr.arrayContains(
        ctx.d.revisedAt,
        expr.coalesce(
          expr.param("at", "date"),
          expr.literal(new Date(MIDYEAR)),
        ),
      ),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();
  const boundScalar = queryDocuments(store)
    .where((ctx) =>
      expr.gte(
        ctx.d.publishedAt,
        ctx.$scalar((subquery) =>
          subquery
            .from("Document", "x")
            .project(() => ({ cutoff: expr.param("from", "date") }))
            .limit(1),
        ),
      ),
    )
    .project((ctx) => ({ title: ctx.d.title }))
    .prepare();
  const boundInSubquery = queryDocuments(store)
    .whereNode("d", () =>
      inSubquery(
        PUBLISHED_AT_FIELD,
        store
          .query()
          .from("Document", "x")
          .project(() => ({ instant: expr.param("at", "date") }))
          .limit(1)
          .toAst(),
      ),
    )
    .select((ctx) => ctx.d.title)
    .prepare();

  return {
    boundArrayContains: await refusal(() =>
      boundArrayContains.execute({ at: operand }),
    ),
    boundComposedArrayContains: await refusal(() =>
      boundComposedArrayContains.execute({ at: operand }),
    ),
    contains: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.revisedAt.contains(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    containsAll: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) =>
          d.revisedAt.containsAll([new Date(MIDNIGHT), operand]),
        )
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    containsAny: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) =>
          d.revisedAt.containsAny([new Date(MIDNIGHT), operand]),
        )
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    pathContains: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.metadata.pathContains("/revisedAt", operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    pathEquals: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.metadata.pathEquals("/publishedAt", operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    boundScalar: await refusal(() => boundScalar.execute({ from: operand })),
    boundInSubquery: await refusal(() =>
      boundInSubquery.execute({ at: operand }),
    ),
  };
}

/** The positions of {@link membershipOperandOutcomes} a `Date` literal takes. */
async function membershipDateOutcomes(
  store: Pick<IntegrationStore, "query" | "nodes">,
  operand: Date,
): Promise<Readonly<Record<string, string>>> {
  return {
    arrayContains: await refusal(() =>
      queryDocuments(store)
        .where((ctx) =>
          expr.arrayContains(ctx.d.revisedAt, expr.literal(operand)),
        )
        .project((ctx) => ({ title: ctx.d.title }))
        .execute(),
    ),
    contains: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.revisedAt.contains(operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    pathEquals: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", (d) => d.metadata.pathEquals("/publishedAt", operand))
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
    scalar: await refusal(() =>
      queryDocuments(store)
        .where((ctx) =>
          expr.gte(
            ctx.d.publishedAt,
            ctx.$scalar((subquery) =>
              subquery
                .from("Document", "x")
                .project(() => ({ cutoff: expr.literal(operand) }))
                .limit(1),
            ),
          ),
        )
        .project((ctx) => ({ title: ctx.d.title }))
        .execute(),
    ),
    inSubquery: await refusal(() =>
      queryDocuments(store)
        .whereNode("d", () =>
          inSubquery(
            PUBLISHED_AT_FIELD,
            store
              .query()
              .from("Document", "x")
              .project(() => ({ instant: expr.literal(operand) }))
              .limit(1)
              .toAst(),
          ),
        )
        .select((ctx) => ctx.d.title)
        .execute(),
    ),
  };
}

/**
 * Valid `Date`s whose `toISOString()` text the store would write but
 * PostgreSQL's `timestamptz` cast refuses: year 0000 (`22008`), a year before
 * the common era in its six-digit form (`22007`), and a five-digit year
 * (`22009`). On SQLite the latter two also sort out of chronological order as
 * text.
 */
const UNSTORABLE_DATES = {
  yearZero: new Date("0000-06-01T00:00:00.000Z"),
  beforeCommonEra: new Date("-000001-01-01T00:00:00.000Z"),
  extendedYear: new Date("+010000-01-01T00:00:00.000Z"),
} as const;

const STAMPED_AT = new Date(MIDNIGHT);

const Stamp = defineNode("DatePredicateStamp", {
  schema: z.object({
    key: z.string(),
    at: z.date().optional(),
    history: z.array(z.date()).optional(),
    nested: z.object({ at: z.date().optional() }).optional(),
    // Coerces interchange text, which `importGraph` then stores verbatim under
    // `onUnknownProperty: "allow"`.
    coerced: z.coerce.date().optional(),
  }),
});
const stampedBy = defineEdge("datePredicateStampedBy", {
  schema: z.object({ at: z.date().optional() }),
});
const STAMP_KEY = {
  name: "date_predicate_stamp_key",
  fields: ["key"],
  scope: "kind",
  collation: "binary",
} as const;
const stampGraph = defineGraph({
  id: "date_predicate_stamps",
  nodes: { DatePredicateStamp: { type: Stamp, unique: [STAMP_KEY] } },
  edges: {
    datePredicateStampedBy: {
      type: stampedBy,
      from: [Stamp],
      to: [Stamp],
      cardinality: "many",
    },
  },
});

/**
 * The same kinds without the uniqueness constraint, which trusted import
 * refuses to load (it maintains no claims).
 */
const importStampGraph = defineGraph({
  id: "date_predicate_imported_stamps",
  nodes: { DatePredicateStamp: { type: Stamp } },
  edges: {
    datePredicateStampedBy: {
      type: stampedBy,
      from: [Stamp],
      to: [Stamp],
      cardinality: "many",
    },
  },
});

/**
 * Every node and edge write path that can store a `Date`, each writing `date`
 * into a date property. `compareAndSet` and `updateWhere` are absent: their
 * patches are JSON-only and refuse a `Date`, so they cannot write a date
 * property at all.
 */
function stampWrites(
  store: InspectableStore<typeof stampGraph>,
  existing: Readonly<{
    first: Node<typeof Stamp>;
    second: Node<typeof Stamp>;
    edgeId: EdgeId<typeof stampedBy>;
  }>,
  date: Date,
): Readonly<Record<string, () => Promise<unknown>>> {
  const stamps = store.nodes.DatePredicateStamp;
  const links = store.edges.datePredicateStampedBy;
  const { first, second, edgeId } = existing;
  return {
    create: () => stamps.create({ key: "create", at: date }),
    createArrayElement: () =>
      stamps.create({ key: "array", history: [STAMPED_AT, date] }),
    createNested: () => stamps.create({ key: "nested", nested: { at: date } }),
    createFromRecord: () =>
      stamps.createFromRecord({ key: "record", at: date }),
    update: () => stamps.update(first.id, { at: date }),
    upsertByIdCreate: () =>
      stamps.upsertById("upserted", { key: "upserted", at: date }),
    upsertByIdUpdate: () =>
      stamps.upsertById(first.id, { key: "first", at: date }),
    upsertByIdFromRecord: () =>
      stamps.upsertByIdFromRecord("upserted-record", {
        key: "upserted-record",
        at: date,
      }),
    bulkCreate: () =>
      stamps.bulkCreate([{ props: { key: "bulk-created", at: date } }]),
    bulkReplaceById: () =>
      stamps.bulkReplaceById([
        { id: first.id, props: { key: "first", at: date } },
      ]),
    bulkUpsertById: () =>
      stamps.bulkUpsertById([
        { id: "bulk-upserted", props: { key: "bulk-upserted", at: date } },
        { id: first.id, props: { key: "first", at: date } },
      ]),
    bulkInsert: () =>
      stamps.bulkInsert([{ props: { key: "bulk-inserted", at: date } }]),
    getOrCreateByConstraint: () =>
      stamps.getOrCreateByConstraint(STAMP_KEY.name, {
        key: "got",
        at: date,
      }),
    bulkGetOrCreateByConstraint: () =>
      stamps.bulkGetOrCreateByConstraint(STAMP_KEY.name, [
        { props: { key: "bulk-got", at: date } },
      ]),
    edgeCreate: () => links.create(first, second, { at: date }),
    edgeUpdate: () => links.update(edgeId, { at: date }),
    edgeBulkCreate: () =>
      links.bulkCreate([{ from: first, to: second, props: { at: date } }]),
    edgeBulkUpsertById: () =>
      links.bulkUpsertById([
        { id: edgeId, from: first, to: second, props: { at: date } },
      ]),
    edgeBulkInsert: () =>
      links.bulkInsert([{ from: first, to: second, props: { at: date } }]),
    edgeGetOrCreateByEndpoints: () =>
      links.getOrCreateByEndpoints(second, first, { at: date }),
    edgeBulkGetOrCreateByEndpoints: () =>
      links.bulkGetOrCreateByEndpoints([
        { from: second, to: first, props: { at: date } },
      ]),
  };
}

/** Every stored stamp and link, as the property values a read returns. */
async function storedStamps(store: InspectableStore<typeof stampGraph>) {
  const nodes = await store.nodes.DatePredicateStamp.find();
  const edges = await store.edges.datePredicateStampedBy.find();
  return {
    nodes: nodes
      .map((node) => ({
        id: node.id,
        key: node.key,
        at: node.at,
        history: node.history,
        nested: node.nested,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    edges: edges.map((edge) => ({ id: edge.id, at: edge.at })),
  };
}

async function seedStamps(store: InspectableStore<typeof stampGraph>) {
  const first = await store.nodes.DatePredicateStamp.create({
    key: "first",
    at: STAMPED_AT,
  });
  const second = await store.nodes.DatePredicateStamp.create({
    key: "second",
  });
  const edge = await store.edges.datePredicateStampedBy.create(first, second, {
    at: STAMPED_AT,
  });
  return { first, second, edgeId: edge.id };
}

/** A trusted-import document of one stamp and one link, with `override` applied. */
function stampDocument(
  override: Readonly<{
    nodeProperties?: Record<string, unknown>;
    edgeProperties?: Record<string, unknown>;
  }>,
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "stored date values" },
    nodes: [
      {
        kind: "DatePredicateStamp",
        id: "imported",
        properties: {
          key: "imported",
          at: MIDNIGHT,
          history: [MIDNIGHT],
          nested: { at: MIDNIGHT },
          ...override.nodeProperties,
        },
      },
    ],
    edges: [
      {
        kind: "datePredicateStampedBy",
        id: "imported-link",
        from: { kind: "DatePredicateStamp", id: "imported" },
        to: { kind: "DatePredicateStamp", id: "imported" },
        properties: { at: MIDNIGHT, ...override.edgeProperties },
      },
    ],
  };
}

export function registerDatePredicateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Stored date values", () => {
    it("refuses a Date outside the years 0001 to 9999 on every node and edge write path, writing nothing", async () => {
      const store = await context.createStore(stampGraph);
      const existing = await seedStamps(store);
      const before = await storedStamps(store);

      const outcomes: Record<string, Readonly<Record<string, string>>> = {};
      for (const [name, date] of Object.entries(UNSTORABLE_DATES)) {
        const results: Record<string, string> = {};
        for (const [write, run] of Object.entries(
          stampWrites(store, existing, date),
        )) {
          results[write] = await refusal(run);
        }
        outcomes[name] = results;
      }

      const writes = Object.keys(stampWrites(store, existing, STAMPED_AT));
      const refusedEverywhere = Object.fromEntries(
        writes.map((write) => [write, "ValidationError"]),
      );
      expect(outcomes).toEqual({
        yearZero: refusedEverywhere,
        beforeCommonEra: refusedEverywhere,
        extendedYear: refusedEverywhere,
      });
      expect(await storedStamps(store)).toEqual(before);

      // Every path writes the same property with a storable Date.
      const accepted: Record<string, string> = {};
      for (const [write, run] of Object.entries(
        stampWrites(store, existing, new Date(MIDYEAR)),
      )) {
        accepted[write] = await refusal(run);
      }
      expect(accepted).toEqual(
        Object.fromEntries(writes.map((write) => [write, "ran"])),
      );
    });

    it("refuses a year-0000 validity bound or asOf coordinate on every backend, before any SQL runs", async () => {
      const store = await context.createStore(stampGraph);
      const existing = await seedStamps(store);
      const before = await storedStamps(store);
      const { store: counted, counter } = await countedStore(context, "packed");
      const yearZero = UNSTORABLE_DATES.yearZero.toISOString();

      const outcomes = {
        createValidFrom: await refusal(() =>
          store.nodes.DatePredicateStamp.create(
            { key: "bounded" },
            { validFrom: yearZero },
          ),
        ),
        createValidTo: await refusal(() =>
          store.nodes.DatePredicateStamp.create(
            { key: "ended" },
            // eslint-disable-next-line unicorn/no-null -- null states an open-left window, so only the year-0000 end is stated
            { validFrom: null, validTo: yearZero },
          ),
        ),
        upsertValidFrom: await refusal(() =>
          store.nodes.DatePredicateStamp.upsertById(
            existing.first.id,
            { key: "first" },
            { validFrom: yearZero },
          ),
        ),
        edgeValidFrom: await refusal(() =>
          store.edges.datePredicateStampedBy.create(
            existing.first,
            existing.second,
            {},
            { validFrom: yearZero },
          ),
        ),
        asOf: await refusal(() =>
          queryDocuments(counted)
            .temporal("asOf", yearZero)
            .select((ctx) => ctx.d.title)
            .execute(),
        ),
      };

      expect(outcomes).toEqual({
        createValidFrom: "ValidationError",
        createValidTo: "ValidationError",
        upsertValidFrom: "ValidationError",
        edgeValidFrom: "ValidationError",
        asOf: "ValidationError",
      });
      expect(counter.count()).toBe(0);
      expect(await storedStamps(store)).toEqual(before);
    });

    it("refuses to re-state a year-0000 validity bound a row stored before the check, even when nothing else changes", async () => {
      const store = await context.createStore(stampGraph);
      const { first } = await seedStamps(store);
      const yearZero = UNSTORABLE_DATES.yearZero.toISOString();
      const executeStatement = store.backend.executeStatement;
      if (executeStatement === undefined)
        throw new Error("Integration backend does not support raw statements");
      const nodes = createSqlSchema(store.backend.tableNames).nodesTable;
      const planted = await executeStatement(
        asCompiledStatementSql(
          sql`UPDATE ${nodes} SET valid_from = ${yearZero} WHERE graph_id = ${store.graphId} AND id = ${first.id}`,
        ),
      ).then(
        () => true,
        () => false,
      );

      // The upsert restates the stored props and bound exactly, so it would
      // coalesce as unchanged; the stated bound is refused before that.
      const restated =
        planted ?
          await refusal(() =>
            store.nodes.DatePredicateStamp.upsertById(
              first.id,
              { key: "first", at: STAMPED_AT },
              { validFrom: yearZero },
            ),
          )
        : "not planted";

      // Only SQLite can hold such a bound: PostgreSQL's timestamptz column
      // refuses the planting write itself.
      expect({ planted, restated }).toEqual(
        store.backend.dialect === "postgres" ?
          { planted: false, restated: "not planted" }
        : { planted: true, restated: "ValidationError" },
      );
    });
  });

  describe("Stored date values through import", () => {
    it("refuses a Date outside the years 0001 to 9999 under every unknown-property strategy, writing nothing", async () => {
      const store = await context.createStore(stampGraph);
      /** A document whose one node (or edge) states `date` at `position`. */
      function importDocument(
        id: string,
        position: "node" | "arrayElement" | "nested" | "edge" | "coerced",
        date: Date | string,
        unknownProperties: Readonly<Record<string, unknown>> = {},
      ): GraphData {
        return {
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          source: { type: "external", description: "stored date values" },
          nodes: [
            {
              kind: "DatePredicateStamp",
              id,
              properties: {
                key: id,
                at: position === "node" ? date : STAMPED_AT,
                history:
                  position === "arrayElement" ?
                    [STAMPED_AT, date]
                  : [STAMPED_AT],
                nested: { at: position === "nested" ? date : STAMPED_AT },
                ...(position === "coerced" && { coerced: date }),
                ...unknownProperties,
              },
            },
          ],
          edges: [
            {
              kind: "datePredicateStampedBy",
              id: `${id}-link`,
              from: { kind: "DatePredicateStamp", id },
              to: { kind: "DatePredicateStamp", id },
              properties: {
                at: position === "edge" ? date : STAMPED_AT,
                ...unknownProperties,
              },
            },
          ],
        };
      }

      /** `"refused"` when the first error refuses the stated entity's date. */
      function rangeRefusal(
        errors: readonly Readonly<{ entityType: string; error: string }>[],
        entityType: "node" | "edge",
      ): string {
        const [first] = errors;
        return (
            first?.entityType === entityType &&
              first.error.includes("in the years 0001 to 9999")
          ) ?
            "refused"
          : JSON.stringify(errors);
      }
      const positions = ["node", "arrayElement", "nested", "edge"] as const;
      const outcomes: Record<string, Readonly<Record<string, string>>> = {};
      for (const strategy of ["error", "strip", "allow"] as const) {
        // "strip" and "allow" act only on a row stating an unknown property:
        // "allow" then stores the original props verbatim.
        const unknownProperties =
          strategy === "error" ? {} : { unrecognized: "kept" };
        const results: Record<string, string> = {};
        for (const [name, date] of Object.entries(UNSTORABLE_DATES)) {
          for (const position of positions) {
            const result = await importGraph(
              store,
              importDocument(
                `${strategy}-${name}-${position}`,
                position,
                date,
                unknownProperties,
              ),
              { onConflict: "error", onUnknownProperty: strategy },
            );
            results[`${name}.${position}`] = rangeRefusal(
              result.errors,
              position === "edge" ? "edge" : "node",
            );
          }
        }
        // A coercing schema turns year-0000 text into a year-0000 Date, which
        // "allow" would otherwise store as the original text.
        const coerced = await importGraph(
          store,
          importDocument(
            `${strategy}-coerced`,
            "coerced",
            "0000-06-01T00:00:00.000Z",
            unknownProperties,
          ),
          { onConflict: "error", onUnknownProperty: strategy },
        );
        results["coerced"] = rangeRefusal(coerced.errors, "node");
        outcomes[strategy] = results;
      }

      // An unknown property holding such a Date: "allow" stores it verbatim and
      // refuses it, "strip" drops it and stores the rest.
      const unknownDate = { unrecognized: UNSTORABLE_DATES.yearZero };
      const allowedUnknown = await importGraph(
        store,
        importDocument("allow-unknown", "node", STAMPED_AT, unknownDate),
        { onConflict: "error", onUnknownProperty: "allow" },
      );
      const strippedUnknown = await importGraph(
        store,
        importDocument("strip-unknown", "node", STAMPED_AT, unknownDate),
        { onConflict: "error", onUnknownProperty: "strip" },
      );
      const unknownDateOutcomes = {
        allow: rangeRefusal(allowedUnknown.errors, "node"),
        strip: strippedUnknown.errors,
      };
      expect(unknownDateOutcomes).toEqual({ allow: "refused", strip: [] });

      const refusedEverywhere: Readonly<Record<string, string>> =
        Object.fromEntries([
          ...Object.keys(UNSTORABLE_DATES).flatMap((name) =>
            positions.map(
              (position) => [`${name}.${position}`, "refused"] as const,
            ),
          ),
          ["coerced", "refused"] as const,
        ]);
      expect(outcomes).toEqual({
        error: refusedEverywhere,
        strip: refusedEverywhere,
        allow: refusedEverywhere,
      });

      // Nothing stored holds a date outside the range: every stamp written
      // (the nodes of the edge cases) holds only the storable instant, read
      // back as its stored text.
      const stored = await storedStamps(store);
      for (const node of stored.nodes) {
        expect({
          at: node.at,
          history: node.history,
          nested: node.nested,
        }).toEqual({
          at: MIDNIGHT,
          history: [MIDNIGHT],
          nested: { at: MIDNIGHT },
        });
      }
      expect(stored.edges.map((edge) => edge.id)).toEqual([
        "strip-unknown-link",
      ]);

      // The same document with storable Dates imports, and a date predicate
      // over it runs on every backend.
      const imported = await importGraph(
        store,
        importDocument("storable", "node", new Date(MIDYEAR)),
        { onConflict: "error", onUnknownProperty: "error" },
      );
      expect(imported.errors).toEqual([]);
      const matched = await store
        .query()
        .from("DatePredicateStamp", "s")
        .whereNode("s", (s) => s.at.gte(MIDYEAR))
        .select((ctx) => ctx.s.key)
        .execute();
      expect(matched).toEqual(["storable"]);
    });
  });

  describe("Stored date values through trusted import", () => {
    it("refuses a date property that is not a canonical instant in the years 0001 to 9999, writing nothing", async () => {
      if (context.getStore().backend.trustedImport === undefined) return;
      const store = await context.createStore(importStampGraph);
      async function storedCount(): Promise<number> {
        const nodes = await store.nodes.DatePredicateStamp.find();
        const edges = await store.edges.datePredicateStampedBy.find();
        return nodes.length + edges.length;
      }
      const unstorable = [
        "0000-06-01T00:00:00.000Z",
        "-000001-01-01T00:00:00.000Z",
        "+010000-01-01T00:00:00.000Z",
        "2024-01-01T00:00:00Z",
        "2024-01-01",
      ] as const;

      const outcomes: Record<string, Readonly<Record<string, unknown>>> = {};
      for (const value of unstorable) {
        const documents = {
          nodeProperty: stampDocument({ nodeProperties: { at: value } }),
          arrayElement: stampDocument({
            nodeProperties: { history: [MIDNIGHT, value] },
          }),
          nestedProperty: stampDocument({
            nodeProperties: { nested: { at: value } },
          }),
          edgeProperty: stampDocument({ edgeProperties: { at: value } }),
        };
        const results: Record<string, unknown> = {};
        for (const [position, document] of Object.entries(documents)) {
          results[position] = await trustedImportGraph(store, document).then(
            () => "ran",
            (error: unknown) =>
              error instanceof TrustedImportError ?
                error.details["reason"]
              : String(error),
          );
        }
        outcomes[value] = results;
      }

      const refusedEverywhere = {
        nodeProperty: "invalid_stream",
        arrayElement: "invalid_stream",
        nestedProperty: "invalid_stream",
        edgeProperty: "invalid_stream",
      };
      expect(outcomes).toEqual(
        Object.fromEntries(
          unstorable.map((value) => [value, refusedEverywhere]),
        ),
      );
      // A value whose own conversion throws (a parsed JSON object with
      // non-function toString and valueOf) is refused with the typed error,
      // not a TypeError raised while the refusal names it.
      const unprintable = await trustedImportGraph(
        store,
        stampDocument({
          nodeProperties: { at: { toString: 4, valueOf: 5 } },
        }),
      ).then(
        () => "ran",
        (error: unknown) =>
          error instanceof TrustedImportError ?
            error.details["reason"]
          : String(error),
      );
      expect(unprintable).toBe("invalid_stream");
      // A validity bound in year 0000 is refused the same way: PostgreSQL's
      // timestamptz column cannot hold it.
      const boundedDocument = stampDocument({});
      const yearZeroBound = await trustedImportGraph(store, {
        ...boundedDocument,
        nodes: boundedDocument.nodes.map((node) => ({
          ...node,
          validFrom: "0000-06-01T00:00:00.000Z",
        })),
      }).then(
        () => "ran",
        (error: unknown) =>
          error instanceof TrustedImportError ?
            error.details["reason"]
          : String(error),
      );
      expect(yearZeroBound).toBe("invalid_stream");
      expect(await storedCount()).toBe(0);

      // The same document with canonical instants imports, and a date
      // predicate over it runs on every backend.
      await trustedImportGraph(store, stampDocument({}));
      const matched = await store
        .query()
        .from("DatePredicateStamp", "s")
        .whereNode("s", (s) => s.at.gte(MIDNIGHT))
        .select((ctx) => ctx.s.key)
        .execute();
      expect(matched).toEqual(["imported"]);
    });
  });

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

    it.each(["packed", "fallback"] as const)(
      "refuses a non-canonical or uncastable string in every membership and subquery position, before any SQL runs (%s prepared path)",
      async (path) => {
        const { store, counter } = await countedStore(context, path);

        const outcomes: Record<string, Readonly<Record<string, string>>> = {};
        for (const operand of REFUSED_STRINGS) {
          outcomes[operand] = await membershipOperandOutcomes(store, operand);
        }
        const refusedStatements = counter.count();

        const refusedEverywhere = {
          boundArrayContains: "UnsupportedPredicateError",
          boundComposedArrayContains: "UnsupportedPredicateError",
          contains: "UnsupportedPredicateError",
          containsAll: "UnsupportedPredicateError",
          containsAny: "UnsupportedPredicateError",
          pathContains: "UnsupportedPredicateError",
          pathEquals: "UnsupportedPredicateError",
          boundScalar: "UnsupportedPredicateError",
          boundInSubquery: "UnsupportedPredicateError",
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
          Object.values(await membershipOperandOutcomes(store, MIDNIGHT)),
        ).toEqual(Array.from({ length: 9 }, () => "ran"));
        expect(counter.count()).toBeGreaterThanOrEqual(9);
      },
    );

    it("refuses a Date outside the years 0001 to 9999 in every membership and subquery position, before any SQL runs", async () => {
      const { store, counter } = await countedStore(context, "packed");

      const outcomes = {
        extendedYear: await membershipDateOutcomes(
          store,
          REFUSED_DATES.extendedYear,
        ),
        yearZero: await membershipDateOutcomes(store, REFUSED_DATES.yearZero),
      };

      const refusedEverywhere = {
        arrayContains: "UnsupportedPredicateError",
        contains: "UnsupportedPredicateError",
        pathEquals: "UnsupportedPredicateError",
        scalar: "UnsupportedPredicateError",
        inSubquery: "UnsupportedPredicateError",
      };
      expect(outcomes).toEqual({
        extendedYear: refusedEverywhere,
        yearZero: refusedEverywhere,
      });
      expect(counter.count()).toBe(0);
    });

    it("matches the same rows for a canonical string and the equivalent Date in membership and subquery positions on every backend", async () => {
      const store = context.getStore();
      const boundArrayContains = queryDocuments(store)
        .where((ctx) =>
          expr.arrayContains(ctx.d.revisedAt, expr.param("at", "date")),
        )
        .project((ctx) => ({ title: ctx.d.title }))
        .prepare();
      function scalarCutoff(cutoff: Date | "param") {
        return queryDocuments(store)
          .where((ctx) =>
            expr.gte(
              ctx.d.publishedAt,
              ctx.$scalar((subquery) =>
                subquery
                  .from("Document", "x")
                  .project(() => ({
                    cutoff:
                      cutoff === "param" ?
                        expr.param("from", "date")
                      : expr.literal(cutoff),
                  }))
                  .limit(1),
              ),
            ),
          )
          .project((ctx) => ({ title: ctx.d.title }));
      }
      function inSubqueryOf(instant: Date | "param") {
        return queryDocuments(store)
          .whereNode("d", () =>
            inSubquery(
              PUBLISHED_AT_FIELD,
              store
                .query()
                .from("Document", "x")
                .project(() => ({
                  instant:
                    instant === "param" ?
                      expr.param("at", "date")
                    : expr.literal(instant),
                }))
                .limit(1)
                .toAst(),
            ),
          )
          .select((ctx) => ctx.d.title);
      }
      const boundScalar = scalarCutoff("param").prepare();
      const boundInSubquery = inSubqueryOf("param").prepare();
      const rows = {
        arrayContainsString: titlesOf(
          await boundArrayContains.execute({
            at: MIDNIGHT,
          }),
        ),
        arrayContainsDate: titlesOf(
          await boundArrayContains.execute({ at: new Date(MIDNIGHT) }),
        ),
        arrayContainsLiteral: titlesOf(
          await queryDocuments(store)
            .where((ctx) =>
              expr.arrayContains(
                ctx.d.revisedAt,
                expr.literal(new Date(MIDYEAR)),
              ),
            )
            .project((ctx) => ({ title: ctx.d.title }))
            .execute(),
        ),
        containsString: await queryDocuments(store)
          .whereNode("d", (d) => d.revisedAt.contains(MIDNIGHT))
          .select((ctx) => ctx.d.title)
          .execute(),
        containsAll: await queryDocuments(store)
          .whereNode("d", (d) =>
            d.revisedAt.containsAll([new Date(MIDNIGHT), new Date(MIDYEAR)]),
          )
          .select((ctx) => ctx.d.title)
          .execute(),
        containsAny: await queryDocuments(store)
          .whereNode("d", (d) =>
            d.revisedAt.containsAny([new Date(JUST_BEFORE), MIDYEAR]),
          )
          .select((ctx) => ctx.d.title)
          .execute(),
        pathContains: await queryDocuments(store)
          .whereNode("d", (d) =>
            d.metadata.pathContains("/revisedAt", new Date(MIDNIGHT)),
          )
          .select((ctx) => ctx.d.title)
          .execute(),
        pathEqualsString: await queryDocuments(store)
          .whereNode("d", (d) => d.metadata.pathEquals("/publishedAt", MIDYEAR))
          .select((ctx) => ctx.d.title)
          .execute(),
        pathEqualsDate: await queryDocuments(store)
          .whereNode("d", (d) =>
            d.metadata.pathEquals("/publishedAt", new Date(MIDYEAR)),
          )
          .select((ctx) => ctx.d.title)
          .execute(),
        scalarLiteral: titlesOf(
          await scalarCutoff(new Date(MIDNIGHT)).execute(),
        ),
        scalarBoundString: titlesOf(
          await boundScalar.execute({ from: MIDNIGHT }),
        ),
        scalarBoundDate: titlesOf(
          await boundScalar.execute({ from: new Date(MIDNIGHT) }),
        ),
        inSubqueryLiteral: await inSubqueryOf(new Date(MIDYEAR)).execute(),
        inSubqueryBound: await boundInSubquery.execute({
          at: MIDNIGHT,
        }),
      };

      expect(sortedRows(rows)).toEqual({
        arrayContainsString: ["midnight", "midyear"],
        arrayContainsDate: ["midnight", "midyear"],
        arrayContainsLiteral: ["midyear"],
        containsString: ["midnight", "midyear"],
        containsAll: ["midyear"],
        containsAny: ["just-before", "midyear"],
        pathContains: ["midnight"],
        pathEqualsString: ["midyear"],
        pathEqualsDate: ["midyear"],
        scalarLiteral: ["midnight", "midyear"],
        scalarBoundString: ["midnight", "midyear"],
        scalarBoundDate: ["midnight", "midyear"],
        inSubqueryLiteral: ["midyear"],
        inSubqueryBound: ["midnight"],
      });
    });

    it("compares a date property with the date a $scalar() subquery projects, in a projection, on every backend", async () => {
      // A subquery types its projected literal as text on PostgreSQL, so the
      // comparison failed there ("operator does not exist: timestamp with
      // time zone >= text") while SQLite answered.
      const rows = await queryDocuments(context.getStore())
        .project((ctx) => ({
          title: ctx.d.title,
          afterCutoff: expr.gte(
            ctx.d.publishedAt,
            ctx.$scalar((subquery) =>
              subquery
                .from("Document", "x")
                .project(() => ({ cutoff: expr.literal(new Date(MIDNIGHT)) }))
                .limit(1),
            ),
          ),
        }))
        .execute();

      expect(
        rows.toSorted((left, right) => left.title.localeCompare(right.title)),
      ).toEqual([
        { title: "just-before", afterCutoff: false },
        { title: "midnight", afterCutoff: true },
        { title: "midyear", afterCutoff: true },
      ]);
    });

    it("projects a date no comparison takes as the Date it states on every backend, typing only compared dates", async () => {
      // Only a date compared with a date is typed as one. A projected date is
      // compared with nothing, so a year PostgreSQL cannot cast still
      // projects, as it did before compared dates were typed.
      const store = context.getStore();
      const yearZero = REFUSED_DATES.yearZero;
      const boundProjection = queryDocuments(store)
        .whereNode("d", (d) => d.title.eq("midnight"))
        .project(() => ({ bound: expr.param("at", "date") }))
        .prepare();
      const rows = await queryDocuments(store)
        .whereNode("d", (d) => d.title.eq("midnight"))
        .project((ctx) => ({
          literal: expr.literal(yearZero),
          scalar: ctx.$scalar((subquery) =>
            subquery
              .from("Document", "x")
              .project(() => ({ value: expr.literal(yearZero) }))
              .limit(1),
          ),
          canonical: ctx.$scalar((subquery) =>
            subquery
              .from("Document", "x")
              .project(() => ({ value: expr.literal(new Date(MIDYEAR)) }))
              .limit(1),
          ),
        }))
        .execute();

      expect({
        rows,
        bound: await boundProjection.execute({ at: yearZero }),
      }).toEqual({
        rows: [
          { literal: yearZero, scalar: yearZero, canonical: new Date(MIDYEAR) },
        ],
        bound: [{ bound: yearZero }],
      });
    });

    it.each(["packed", "fallback"] as const)(
      "checks a value an in() / notIn() subquery projects as the date it is compared as when the field reference states no type (%s prepared path)",
      async (path) => {
        const { store, counter } = await countedStore(context, path);
        // No valueType: the comparison takes the subquery column's date type.
        const untypedPublishedAt = fieldRef("d", ["props"], {
          jsonPointer: jsonPointer(["publishedAt"]),
        });
        function projecting(value: Date | "param") {
          return store
            .query()
            .from("Document", "x")
            .project(() => ({
              instant:
                value === "param" ?
                  expr.param("at", "date")
                : expr.literal(value),
            }))
            .limit(1)
            .toAst();
        }
        const boundIn = queryDocuments(store)
          .whereNode("d", () =>
            inSubquery(untypedPublishedAt, projecting("param")),
          )
          .select((ctx) => ctx.d.title)
          .prepare();
        const boundNotIn = queryDocuments(store)
          .whereNode("d", () =>
            notInSubquery(untypedPublishedAt, projecting("param")),
          )
          .select((ctx) => ctx.d.title)
          .prepare();

        const refused = {
          boundIn: await refusal(() =>
            boundIn.execute({ at: "2024-01-01T00:00:00Z" }),
          ),
          boundNotIn: await refusal(() =>
            boundNotIn.execute({ at: "2024-01-01T00:00:00Z" }),
          ),
          boundYearZero: await refusal(() =>
            boundIn.execute({ at: REFUSED_DATES.yearZero }),
          ),
          literalYearZero: await refusal(() =>
            queryDocuments(store)
              .whereNode("d", () =>
                inSubquery(
                  untypedPublishedAt,
                  projecting(REFUSED_DATES.yearZero),
                ),
              )
              .select((ctx) => ctx.d.title)
              .execute(),
          ),
        };
        const refusedStatements = counter.count();

        expect(refused).toEqual({
          boundIn: "UnsupportedPredicateError",
          boundNotIn: "UnsupportedPredicateError",
          boundYearZero: "UnsupportedPredicateError",
          literalYearZero: "UnsupportedPredicateError",
        });
        expect(refusedStatements).toBe(0);

        const rows = {
          boundIn: await boundIn.execute({ at: MIDNIGHT }),
          boundInDate: await boundIn.execute({ at: new Date(MIDNIGHT) }),
          boundNotIn: await boundNotIn.execute({ at: MIDNIGHT }),
          literal: await queryDocuments(store)
            .whereNode("d", () =>
              inSubquery(untypedPublishedAt, projecting(new Date(MIDYEAR))),
            )
            .select((ctx) => ctx.d.title)
            .execute(),
        };
        expect(sortedRows(rows)).toEqual({
          boundIn: ["midnight"],
          boundInDate: ["midnight"],
          boundNotIn: ["just-before", "midyear"],
          literal: ["midyear"],
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

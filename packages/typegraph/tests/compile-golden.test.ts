/**
 * The query compiler's golden corpus.
 *
 * Pins compiled `{sql, params}` so a read-path refactor cannot change
 * emitted SQL unnoticed: it snapshots the query compiler's output across
 * the temporal-mode / recorded-binding matrix, on both dialects, under a
 * faked clock, plus the pure store-level SQL builders (subgraph traversal
 * and fetch, neighbors, algorithm expansion, historical identity
 * reconstruction, and the separation-probe statements).
 *
 * A snapshot diff is not automatically wrong — a step that deliberately
 * changes emitted SQL (moving "now" from a literal to a placeholder, for
 * instance) updates the snapshot in the same commit, with the reason stated
 * there. Every OTHER diff means something changed behavior it was not
 * scoped to change.
 *
 * Regenerating on a new base: delete `compile-golden.test.ts.snap` and rerun
 * `pnpm test compile-golden -u`; review the new snapshot as you would any
 * other diff before committing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  count,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  exists,
  expr,
  field,
  inSubquery,
  notExists,
} from "../src";
import { assumeRecursiveTraversalSupported } from "../src/backend/capabilities/recursive-traversal";
import { deriveBackend } from "../src/backend/derive-backend";
import type {
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
  UpdateNodeSetParams,
  UpdateNodeSetResult,
} from "../src/backend/types";
import {
  createRecordedInstant,
  type ReadCoordinate,
} from "../src/core/temporal";
import type { TemporalMode } from "../src/core/types";
import {
  historicalIdentityPeerClassQuery,
  historicalIdentityReconstructionCtes,
  identityAssertionSnapshotSource,
  identityNodeSnapshotSource,
  identitySqlCoordinate,
} from "../src/identity/historical-sql";
import { separationRebuildRequired } from "../src/identity/separation";
import { createFragment } from "../src/query";
import type { FulltextMatchPredicate, QueryAst } from "../src/query/ast";
import { createQueryBuilder } from "../src/query/builder";
import { compileQuery } from "../src/query/compiler";
import {
  createRecordedReadBinding,
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  recordedRelation,
  vectorSlotKey,
  type VectorSlotMap,
} from "../src/query/compiler/schema";
import { compileSetOperation } from "../src/query/compiler/set-operations";
import { getDialect } from "../src/query/dialect";
import {
  fts5Strategy,
  tsvectorStrategy,
} from "../src/query/dialect/fulltext-strategy";
import { libsqlVectorStrategy } from "../src/query/dialect/vector/libsql-strategy";
import { pgvectorStrategy } from "../src/query/dialect/vector/pgvector-strategy";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { fieldRef } from "../src/query/predicates";
import type { SqlFragment } from "../src/query/sql-fragment";
import { buildKindRegistry } from "../src/registry";
import { readGraphAllocationOwner } from "../src/store/allocation-owner";
import {
  createNeighborCountRead,
  createNeighborRead,
} from "../src/store/neighbors";
import { recordedAnchorOwner } from "../src/store/recorded-anchor-origin";
import { buildReachableCte } from "../src/store/recursive-cte";
import type { StoreViewCoordinate } from "../src/store/store-view";
import { executeSubgraph } from "../src/store/subgraph";
import { requireDefined } from "../src/utils/presence";
import { toSqlWithParams } from "./sql-test-utils";
import { createTestBackend, disableTransactions } from "./test-utils";

// ============================================================
// Faked clock
// ============================================================

const FAKE_NOW = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FAKE_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Shared graph fixture
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number().optional(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({ name: z.string(), industry: z.string().optional() }),
});

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    content: z.string().optional(),
    embedding: embedding(3),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string().optional() }),
});
const knows = defineEdge("knows");

const graph = defineGraph({
  id: "compile_golden",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Document: { type: Document },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Organization] },
    knows: { type: knows, from: [Person], to: [Person] },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

const registry = buildKindRegistry(graph);

function builder() {
  return createQueryBuilder<typeof graph>(graph.id, registry);
}

// ============================================================
// Temporal-mode / recorded-binding matrix
// ============================================================

const MODES: readonly TemporalMode[] = [
  "current",
  "asOf",
  "includeEnded",
  "includeTombstones",
];
const AS_OF_TIMESTAMP = "2025-03-01T00:00:00.000Z";
/**
 * Recorded reads refuse an anchor that does not name the graph's allocation
 * owner, so the pinned instant carries a fixed origin. The capture backends
 * answer the origin probe with the same origin (see
 * {@link answerRevisionOriginProbe}), which keeps the probe statement in the
 * snapshots without a generated id.
 */
const GOLDEN_REVISION_ORIGIN = "compile-golden-origin";
const RECORDED_REVISION = 7;
const RECORDED_AT = "2025-06-01T00:00:00.000Z";
const RECORDED_AS_OF = createRecordedInstant(
  RECORDED_REVISION,
  RECORDED_AT,
  await recordedAnchorOwner(DEFAULT_SQL_SCHEMA, GOLDEN_REVISION_ORIGIN),
);

/**
 * The rows a capture backend returns for the revision-origin probe a
 * recorded read runs before it trusts its anchor, or `undefined` when
 * `statement` is not that probe.
 */
function answerRevisionOriginProbe(
  statement: string,
): readonly unknown[] | undefined {
  return statement.includes('FROM "typegraph_revision_origins"') ?
      [{ origin: GOLDEN_REVISION_ORIGIN }]
    : undefined;
}

type Variant = Readonly<{
  label: string;
  mode: TemporalMode;
  asOf?: string;
  recorded: boolean;
}>;

/** The full 4-mode × recorded-on/off grid. */
function fullMatrix(
  modes: readonly TemporalMode[] = MODES,
): readonly Variant[] {
  return modes.flatMap((mode) =>
    [false, true].map((recorded) => ({
      label: `${mode}${recorded ? "+recorded" : ""}`,
      mode,
      ...(mode === "asOf" ? { asOf: AS_OF_TIMESTAMP } : {}),
      recorded,
    })),
  );
}

function withVariant(ast: QueryAst, variant: Variant): QueryAst {
  return {
    ...ast,
    temporalMode: {
      mode: variant.mode,
      ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
    },
    ...(variant.recorded ? { recordedAsOf: RECORDED_AS_OF } : {}),
  };
}

/** The `ReadCoordinate` a variant describes, for the identity-SQL builders. */
function variantCoordinate(variant: Variant): ReadCoordinate {
  return {
    valid: {
      mode: variant.mode,
      ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
    },
    ...(variant.recorded ? { recorded: { asOf: RECORDED_AS_OF } } : {}),
  };
}

/**
 * The `StoreViewCoordinate` a variant's valid-time axis describes, for
 * `store.view(...)`. A real branch, not a conditional spread: `asOf` is
 * required for `"asOf"` and rejected (typed `never`) for every other mode,
 * so only an if/else satisfies the discriminated union — a spread produces
 * a widened `{ mode: TemporalMode; asOf?: string }` that does not match
 * either arm.
 */
function variantViewCoordinate(variant: Variant): StoreViewCoordinate {
  if (variant.mode === "asOf") {
    return { mode: "asOf", asOf: requireDefined(variant.asOf) };
  }
  return { mode: variant.mode };
}

const DIALECTS = ["sqlite", "postgres"] as const;
type Dialect = (typeof DIALECTS)[number];

function compileVariant(
  ast: QueryAst,
  variant: Variant,
  dialect: Dialect,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  const schema = DEFAULT_SQL_SCHEMA;
  const compiled = compileQuery(withVariant(ast, variant), graph.id, {
    dialect,
    schema,
    ...(variant.recorded ?
      { recordedReadBinding: createRecordedReadBinding(schema) }
    : {}),
  });
  return toSqlWithParams(compiled, dialect);
}

/**
 * Runs one base AST across the full temporal/recorded/dialect grid and
 * snapshots every cell under one label.
 */
function goldenGrid(
  suiteLabel: string,
  ast: QueryAst,
  variants: readonly Variant[] = fullMatrix(),
): void {
  // eslint-disable-next-line vitest/valid-title -- suiteLabel is always a string literal at every call site below; the rule cannot see through this helper's indirection.
  describe(suiteLabel, () => {
    for (const variant of variants) {
      for (const dialect of DIALECTS) {
        it(`${variant.label} / ${dialect}`, () => {
          expect(compileVariant(ast, variant, dialect)).toMatchSnapshot();
        });
      }
    }
  });
}

function vectorAst(approximate: boolean): QueryAst {
  return builder()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.embedding.similarTo([0.1, 0.2, 0.3], 5, { approximate }),
    )
    .select((ctx) => ctx.d.id)
    .toAst();
}

function fulltextAst(): QueryAst {
  const base = builder()
    .from("Document", "d")
    .select((ctx) => ctx.d.id)
    .toAst();
  const predicate: FulltextMatchPredicate = {
    __type: "fulltext_match",
    field: fieldRef("d", ["$fulltext"]),
    query: "typegraph refactor",
    mode: "websearch",
    limit: 10,
  };
  return {
    ...base,
    predicates: [{ targetAlias: "d", expression: predicate }],
  };
}

/**
 * Every statement a one-hop `reachable` round sends, captured through a
 * recording backend overlay rather than rendered from a hand-built AST — a
 * future step converting this statement's literal `NOW` to a bound
 * placeholder changes exactly the shape this pin has to catch, so the pin
 * has to come from the real call. The fake execute never touches a real
 * engine: `capabilities`, `transaction`, and everything else besides
 * `dialect` and `execute` come from a real in-memory backend so
 * `createStore`'s capability checks pass, but rendering "postgres" SQL
 * against SQLite storage would fail, so both dialects run against canned
 * rows instead of a live database.
 */
function algorithmExpansionCapture(
  dialect: Dialect,
): Readonly<{ backend: GraphBackend; captured: SqlFragment[] }> {
  const { backend, captured } = algorithmStatementCapture(
    dialect,
    (statement) =>
      isReachableSeedLookup(statement) ?
        [{ id: "person-1", kind: "Person" }]
      : [],
  );
  return { backend: disableTransactions(backend), captured };
}

/**
 * Whether `statement` is the seed lookup a `reachable` call runs before it
 * expands: the root's (id, kind) read from the node relation. Matched by
 * shape, not by position: a recorded read sends the revision-origin probe
 * first, so a positional match answers the probe's slot and hands the seed
 * lookup an empty result, which ends traversal before any expansion
 * statement is built.
 */
function isReachableSeedLookup(statement: string): boolean {
  return statement.startsWith("SELECT n.id, n.kind FROM ");
}

/**
 * Asserts that `captured` holds a `reachable` expansion round (the working
 * set joined to the edge relation), so a fixture that stops traversal at
 * the seed cannot be snapshotted as if it pinned the expansion.
 */
function expectReachableExpansionCaptured(
  captured: readonly SqlFragment[],
  dialect: Dialect,
): void {
  expect(
    captured.some((fragment) =>
      toSqlWithParams(fragment, dialect).sql.includes(
        "FROM (SELECT w.node_id AS source_id",
      ),
    ),
  ).toBe(true);
}

function algorithmStatementCapture(
  dialect: Dialect,
  rowsForStatement: (statement: string, index: number) => readonly unknown[],
): Readonly<{ backend: GraphBackend; captured: SqlFragment[] }> {
  const captured: SqlFragment[] = [];
  const base = createTestBackend();
  const execute = <T>(query: unknown): Promise<readonly T[]> => {
    const fragment = query as SqlFragment;
    captured.push(fragment);
    const statement = toSqlWithParams(fragment, dialect).sql;
    return Promise.resolve(
      (answerRevisionOriginProbe(statement) ??
        rowsForStatement(statement, captured.length)) as readonly T[],
    );
  };
  const executeTemporaryStatement = (query: unknown): Promise<void> => {
    captured.push(query as SqlFragment);
    return Promise.resolve();
  };
  const backend = deriveBackend(base, {
    dialect,
    execute,
    executeTemporaryStatement,
    transaction: <T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> =>
      base.transaction(
        (tx) =>
          fn(
            deriveBackend(tx, { dialect, execute, executeTemporaryStatement }),
          ),
        options,
      ),
  });
  return { backend, captured };
}

/**
 * The captured statements other than the revision-origin probes a recorded
 * read brackets its statements with — the statements the algorithm itself
 * issued. The snapshot still pins the probes.
 */
function withoutOriginProbes(
  captured: readonly SqlFragment[],
  dialect: Dialect,
): readonly SqlFragment[] {
  return captured.filter(
    (fragment) =>
      answerRevisionOriginProbe(toSqlWithParams(fragment, dialect).sql) ===
      undefined,
  );
}

function capturedAlgorithmStatements(
  captured: readonly SqlFragment[],
  dialect: Dialect,
): readonly Readonly<{ sql: string; params: readonly unknown[] }>[] {
  const seenIds = new Map<string, string>();
  const rendered = captured.map((fragment) =>
    toSqlWithParams(fragment, dialect),
  );
  const runIdPlaceholders = workingTableRunIdPlaceholders(
    rendered.map((statement) => statement.sql),
  );
  return rendered.map(({ sql: sqlText, params }) => ({
    sql: normalizeWorkingTableRunIds(sqlText, runIdPlaceholders),
    params: normalizeGeneratedIdParams(params, seenIds),
  }));
}

/**
 * `subgraphMembershipStrategy` ("inline-cte" on SQLite, "materialized-ids"
 * on PostgreSQL — `dialect/{sqlite,postgres}.ts`) picks which statements
 * `executeSubgraph` sends: SQLite embeds the traversal CTE in the node and
 * edge fetches directly, PostgreSQL fetches the closure ids once and
 * semi-joins against them. Both are captured here; the composable
 * one-statement form (`createSubgraphRead`) always takes the inline shape
 * regardless of dialect and is out of scope for this block.
 */
function subgraphFetchCapture(
  dialect: Dialect,
): Readonly<{ backend: GraphBackend; captured: SqlFragment[] }> {
  const captured: SqlFragment[] = [];
  const backend = deriveBackend(createTestBackend(), {
    dialect,
    execute: <T>(query: unknown): Promise<readonly T[]> => {
      captured.push(query as SqlFragment);
      if (dialect === "postgres" && captured.length === 1) {
        // The materialized-ids strategy's closure-id fetch, consulted
        // before the node/edge fetches below.
        return Promise.resolve([
          { id: "person-1", kind: "Person" },
        ] as unknown as readonly T[]);
      }
      return Promise.resolve([]);
    },
  });
  return { backend, captured };
}

/**
 * Overlay members that record every statement a backend runs — through
 * `execute` and, when a temporary-table iteration path uses it, through
 * `executeTemporaryStatement` — then delegate to the real implementation.
 * Reused unmodified for a nested transaction backend so a captured working-
 * table round (created inside `backend.transaction(...)`) is not silently
 * dropped: `deriveBackend`'s overlay does not itself propagate into a
 * `transaction` callback's backend, so the caller re-applies these members
 * to the `tx` argument it receives.
 */
function recordingOverlayMembers<
  T extends Pick<GraphBackend, "execute" | "executeTemporaryStatement">,
>(
  target: T,
  captured: SqlFragment[],
): Pick<T, "execute" | "executeTemporaryStatement"> {
  const execute = <U>(query: unknown): Promise<readonly U[]> => {
    captured.push(query as SqlFragment);
    return target.execute<U>(query as never);
  };
  if (target.executeTemporaryStatement === undefined) {
    return { execute };
  }
  return {
    execute,
    executeTemporaryStatement: (query: unknown) => {
      captured.push(query as SqlFragment);
      return requireDefined(target.executeTemporaryStatement)(query as never);
    },
  };
}

/**
 * The working table an iterative run creates, `"typegraph_iterative_<runId>"`,
 * where `<runId>` is the run's 21-character generated id with `-` mapped to
 * `_`. The auxiliary relations of the same run (`typegraph_iterative_n_<runId>`,
 * `typegraph_iterative_a_<runId>`, `typegraph_iterative_<runId>_frontier`)
 * never match: the closing quote must follow the 21 id characters directly.
 */
const WORKING_TABLE_IDENTIFIER = /"typegraph_iterative_([A-Za-z0-9_]{21})"/gu;

/**
 * Maps each run id a cell's working tables carry to a stable placeholder
 * (`<id>`, then `<id-2>`, … in first-seen order).
 */
function workingTableRunIdPlaceholders(
  statements: readonly string[],
): ReadonlyMap<string, string> {
  const placeholders = new Map<string, string>();
  for (const statement of statements) {
    for (const match of statement.matchAll(WORKING_TABLE_IDENTIFIER)) {
      const runId = requireDefined(match[1]);
      if (!placeholders.has(runId)) {
        placeholders.set(
          runId,
          placeholders.size === 0 ? "<id>" : `<id-${placeholders.size + 1}>`,
        );
      }
    }
  }
  return placeholders;
}

/** Any iterative relation name whose run id is still not a placeholder. */
const UNNORMALIZED_ITERATIVE_NAME =
  /typegraph_iterative_(?!(?:[an]_)?<id(?:-\d+)?>)/u;

/**
 * Replaces only the random run id inside each iterative relation name, so
 * the working table, the neighbor table and their indexes stay distinct in
 * the snapshot: a statement that reads the working table where it should
 * read the neighbor table changes the normalized SQL. Throws when a name
 * keeps an id no working table in the cell declared, rather than letting a
 * random id reach the snapshot.
 */
function normalizeWorkingTableRunIds(
  sqlText: string,
  placeholders: ReadonlyMap<string, string>,
): string {
  // Run ids are `[A-Za-z0-9_]` only, so they need no escaping in the pattern.
  const normalized =
    placeholders.size === 0 ?
      sqlText
    : sqlText.replaceAll(
        new RegExp([...placeholders.keys()].join("|"), "gu"),
        (runId) => requireDefined(placeholders.get(runId)),
      );
  if (UNNORMALIZED_ITERATIVE_NAME.test(normalized)) {
    throw new Error(
      `An iterative relation name kept its run id after normalization: ${normalized}`,
    );
  }
  return normalized;
}

/** A default `generateId()` nanoid: 21 characters, URL-safe alphabet. */
const NANOID_SHAPE = /^[A-Za-z0-9_-]{21}$/u;

/**
 * Replaces every nanoid-shaped bound parameter (a node's generated id, or
 * the algorithm run's own generated `run_id`) with a stable placeholder, so
 * a snapshot captured against a real (non-fixed-clock) id generator stays
 * reproducible across runs. The same source value always maps to the same
 * placeholder, so which rows share an id stays visible in the snapshot.
 */
function normalizeGeneratedIdParams(
  params: readonly unknown[],
  seen: Map<string, string>,
): unknown[] {
  return params.map((parameter) => {
    if (typeof parameter !== "string" || !NANOID_SHAPE.test(parameter)) {
      return parameter;
    }
    const placeholder = seen.get(parameter);
    if (placeholder !== undefined) return placeholder;
    const next = `<generated-id-${seen.size + 1}>`;
    seen.set(parameter, next);
    return next;
  });
}

// ============================================================
// Section A — query-compiler AST shapes
// ============================================================

describe("compile-golden: query compiler ASTs", () => {
  goldenGrid(
    "start-only",
    builder()
      .from("Person", "p")
      .select((ctx) => ctx.p)
      .toAst(),
  );

  goldenGrid(
    "two-hop traversal",
    builder()
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .select((ctx) => ({ person: ctx.p.name, org: ctx.o.name }))
      .toAst(),
  );

  goldenGrid(
    "variable-length traversal",
    builder()
      .from("Person", "p")
      .traverse("knows", "e")
      .recursive({ maxHops: 4 })
      .to("Person", "friend")
      .select((ctx) => ctx.friend.id)
      .toAst(),
  );

  goldenGrid(
    "identity-expanded traversal",
    builder()
      .from("Person", "p")
      .traverse("knows", "e", { includeIdentityMembers: true })
      .to("Person", "friend")
      .select((ctx) => ctx.friend.id)
      .toAst(),
  );

  goldenGrid(
    "aggregate with GROUP BY",
    builder()
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .aggregate({ orgName: field("o", "name"), employeeCount: count("p") })
      .toAst(),
  );

  describe("EXISTS / IN / expression subqueries", () => {
    // `.aggregate()` with an explicit `fieldRef` is the narrow-projection
    // path: `.select()` always hydrates the whole node row, which
    // `inSubquery` refuses as "not exactly 1 column".
    const innerAst = builder()
      .from("Organization", "o")
      .whereNode("o", (o) => o.industry.eq("Tech"))
      .aggregate({ id: fieldRef("o", ["id"], { valueType: "string" }) })
      .toAst();

    const existsAst = builder()
      .from("Person", "p")
      .whereNode("p", () => exists(innerAst))
      .select((ctx) => ({ id: ctx.p.id }))
      .toAst();

    const notExistsAst = builder()
      .from("Person", "p")
      .whereNode("p", () => notExists(innerAst))
      .select((ctx) => ({ id: ctx.p.id }))
      .toAst();

    const inAst = builder()
      .from("Person", "p")
      .whereNode("p", () => inSubquery(fieldRef("p", ["id"]), innerAst))
      .select((ctx) => ({ id: ctx.p.id }))
      .toAst();

    goldenGrid("EXISTS", existsAst);
    goldenGrid("NOT EXISTS", notExistsAst);
    goldenGrid("IN subquery", inAst);

    // `expressions.$exists(...)` (the field-expression-scope form used from
    // `.project()`, as in `tests/backends/integration/expression-subquery-queries.ts`)
    // is a distinct AST shape from `exists(innerAst)` above: it is built
    // through a correlated subquery builder callback, not a standalone AST
    // value.
    const expressionExistsAst = builder()
      .from("Person", "p")
      .project((fields) => ({
        id: fields.p.id,
        hasTaggedDocument: fields.$exists((subquery, outer) =>
          subquery
            .from("Document", "document")
            .where((inner) => expr.eq(inner.document.title, outer.p.name))
            .project((inner) => ({ id: inner.document.id }))
            .limit(1),
        ),
      }))
      .toAst();
    goldenGrid("expression subquery ($exists)", expressionExistsAst);
  });

  describe("set operations with mixed valid axes", () => {
    // The valid-time axis is deliberately free per leaf (set-operations.ts's
    // own error text: "Valid-time differences are allowed"): one operand
    // reads "current", the other pins a fixed `asOf` instant, in the same
    // UNION.
    for (const dialect of DIALECTS) {
      it(`union, live vs asOf / ${dialect}`, () => {
        const left = createQueryBuilder<typeof graph>(graph.id, registry, {
          dialect,
        })
          .from("Person", "p")
          .temporal("current")
          .select((ctx) => ({ id: ctx.p.id }));
        const right = createQueryBuilder<typeof graph>(graph.id, registry, {
          dialect,
        })
          .from("Person", "p2")
          .temporal("asOf", AS_OF_TIMESTAMP)
          .select((ctx) => ({ id: ctx.p2.id }));
        const compiled = left.union(right).compile();
        expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
      });

      it(`intersect, live vs includeEnded / ${dialect}`, () => {
        const left = createQueryBuilder<typeof graph>(graph.id, registry, {
          dialect,
        })
          .from("Person", "p")
          .temporal("current")
          .select((ctx) => ({ id: ctx.p.id }));
        const right = createQueryBuilder<typeof graph>(graph.id, registry, {
          dialect,
        })
          .from("Person", "p2")
          .temporal("includeEnded")
          .select((ctx) => ({ id: ctx.p2.id }));
        const compiled = left.intersect(right).compile();
        expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
      });
    }
  });

  describe("set operations (uniform mode/recorded grid)", () => {
    /**
     * The mixed-axis block above pins the deliberately-free valid-time case.
     * This one pins the ordinary case — both operands share one coordinate —
     * across the full mode/recorded grid, which the mixed-axis tests cannot:
     * a set operation refuses a mixed RECORDED axis
     * (`assertUniformSetOperationRecordedCoordinates`), so a uniform pin is
     * the only way to exercise a recorded union at all. Built from raw
     * `SetOperation` nodes rather than the fluent builder, because
     * `.union()` has no recorded-pin method — the same AST-level route
     * `goldenGrid` above already takes.
     */
    const leftAst = builder()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id }))
      .toAst();
    const rightAst = builder()
      .from("Person", "p2")
      .select((ctx) => ({ id: ctx.p2.id }))
      .toAst();

    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        it(`union, ${variant.label} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const setOperation = {
            __type: "set_operation" as const,
            operator: "union" as const,
            left: withVariant(leftAst, variant),
            right: withVariant(rightAst, variant),
          };
          const compiled = compileSetOperation(
            setOperation,
            graph.id,
            getDialect(dialect),
            (ast, gid) =>
              compileQuery(ast, gid, {
                dialect,
                schema,
                ...(variant.recorded ?
                  { recordedReadBinding: createRecordedReadBinding(schema) }
                : {}),
              }),
          );
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("relations and topPerPartition", () => {
    // No recorded-pin method exists on the plain builder chain: a relation
    // reaches recorded time only through a live store's coordinate-pinned view
    // (`store.view({mode,asOf}).asOfRecorded(...).query()...asRelation()`),
    // not through this file's plain-compiler AST tricks. The temporal-mode
    // axis is public on the builder (`.temporal()`), so that axis is
    // covered here directly; the recorded axis is covered in the block
    // below, through a real store.
    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        if (variant.recorded) continue;
        it(`asRelation projection, ${variant.label} / ${dialect}`, () => {
          const relation = createQueryBuilder<typeof graph>(
            graph.id,
            registry,
            { dialect },
          )
            .from("Person", "p")
            .temporal(variant.mode, variant.asOf)
            .project((fields) => ({ id: fields.p.id, name: fields.p.name }))
            .asRelation();
          const compiled = relation.compile();
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });

        it(`topPerPartition, ${variant.label} / ${dialect}`, () => {
          const relation = createQueryBuilder<typeof graph>(
            graph.id,
            registry,
            { dialect },
          )
            .from("Person", "p")
            .temporal(variant.mode, variant.asOf)
            .traverse("worksAt", "e")
            .to("Organization", "o")
            .project((fields) => ({
              org: fields.o.id,
              person: fields.p.id,
              name: fields.p.name,
            }))
            .asRelation()
            .topPerPartition({
              partitionBy: (columns) => [columns.org],
              orderBy: (columns) => [{ expression: columns.name }],
              limit: 1,
            });
          const compiled = relation.compile();
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("relations and topPerPartition, recorded (store.view(...).asOfRecorded(...))", () => {
    // The recorded axis a relation source reaches only through a live
    // store's coordinate-pinned view — the compile-only route the block
    // above takes has no recorded-pin method to call. `store.view(...)`
    // pins any of the four valid-time modes; `.asOfRecorded(...)` then
    // layers the recorded pin on top. Every cell here calls
    // `.asOfRecorded(...)` unconditionally, so only the `variant.recorded`
    // half of `fullMatrix()` is iterated — a non-recorded variant would
    // still render the recorded statement (the non-recorded route to
    // relations is pinned above by the plain `.temporal()` block), which
    // would pin a "current" / "includeEnded" / … label over SQL that reads
    // `typegraph_recorded_nodes`, indistinguishable from its "+recorded"
    // sibling.
    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix().filter((entry) => entry.recorded)) {
        it(`asRelation projection, ${variant.label} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const backend = deriveBackend(createTestBackend(), { dialect });
          const store = createStore(graph, backend, {
            schema,
            recordedRead: recordedRelation({ schema }),
          });
          const view = store
            .view(variantViewCoordinate(variant))
            .asOfRecorded(RECORDED_AS_OF);
          const relation = view
            .query()
            .from("Person", "p")
            .project((fields) => ({ id: fields.p.id, name: fields.p.name }))
            .asRelation();
          const compiled = relation.compile();
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });

        it(`topPerPartition, ${variant.label} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const backend = deriveBackend(createTestBackend(), { dialect });
          const store = createStore(graph, backend, {
            schema,
            recordedRead: recordedRelation({ schema }),
          });
          const view = store
            .view(variantViewCoordinate(variant))
            .asOfRecorded(RECORDED_AS_OF);
          const relation = view
            .query()
            .from("Person", "p")
            .traverse("worksAt", "e")
            .to("Organization", "o")
            .project((fields) => ({
              org: fields.o.id,
              person: fields.p.id,
              name: fields.p.name,
            }))
            .asRelation()
            .topPerPartition({
              partitionBy: (columns) => [columns.org],
              orderBy: (columns) => [{ expression: columns.name }],
              limit: 1,
            });
          const compiled = relation.compile();
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("approximate vector similarity", () => {
    const VECTOR_SLOTS: VectorSlotMap = new Map([
      [
        vectorSlotKey("Document", "embedding"),
        {
          dimensions: 3,
          metric: "cosine" as const,
          indexType: "hnsw" as const,
        },
      ],
    ]);
    const VECTOR_STRATEGY = {
      sqlite: sqliteVecStrategy,
      postgres: pgvectorStrategy,
    } as const;

    // `sqliteVecStrategy` declares `searchIsExact: true`, so both values of
    // `approximate` use the same engine form and produce identical SQL. The
    // libsql cells below pin a SQLite strategy whose two forms diverge.
    // The valid-time mode axis is not gridded here: the vector
    // strategy's own SQL (the ANN/exact join, the distance predicate) is
    // mode-independent. The node CTE it joins against does still carry a
    // mode-dependent temporal filter, but that filter is the same one the
    // full 4-mode × recorded grid at the top of this file already pins on
    // every other builder shape, so gridding it again here would only
    // repeat that coverage under the vector strategy's own SQL.
    for (const dialect of DIALECTS) {
      for (const approximate of [false, true]) {
        it(`cosine, ${approximate ? "approximate" : "exact"} / ${dialect}`, () => {
          const compiled = compileQuery(vectorAst(approximate), graph.id, {
            dialect,
            vectorStrategy: VECTOR_STRATEGY[dialect],
            vectorSlots: VECTOR_SLOTS,
          });
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });
      }
    }

    // libsqlVectorStrategy is the one sqlite-dialect strategy that DOES read
    // `approximate` (it has no `searchIsExact`), so — unlike the sqlite-vec
    // pair above — its exact and approximate compiles genuinely diverge:
    // `engineFormEligible` in `standard-builders.ts` only routes through the
    // strategy's own ANN form when `approximate === true` or the strategy
    // declares `searchIsExact`.
    for (const approximate of [false, true]) {
      it(`cosine, ${approximate ? "approximate" : "exact"} / sqlite (libsql strategy)`, () => {
        const compiled = compileQuery(vectorAst(approximate), graph.id, {
          dialect: "sqlite",
          vectorStrategy: libsqlVectorStrategy,
          vectorSlots: VECTOR_SLOTS,
        });
        expect(toSqlWithParams(compiled, "sqlite")).toMatchSnapshot();
      });
    }

    // Declared, not silent: a recorded-time read refuses a vector predicate
    // outright (`recorded-current-index-guard.ts`) rather than silently
    // reading a current index under a stale coordinate. Pinned as a refusal,
    // on both dialects, so this guard cannot regress into either a crash of
    // a different shape or — worse — a query that runs and answers wrong.
    for (const dialect of DIALECTS) {
      it(`recorded pin refuses the vector predicate / ${dialect}`, () => {
        const schema = DEFAULT_SQL_SCHEMA;
        const ast = { ...vectorAst(false), recordedAsOf: RECORDED_AS_OF };
        expect(() =>
          compileQuery(ast, graph.id, {
            dialect,
            schema,
            vectorStrategy: VECTOR_STRATEGY[dialect],
            vectorSlots: VECTOR_SLOTS,
            recordedReadBinding: createRecordedReadBinding(schema),
          }),
        ).toThrow(
          "Recorded-time queries cannot use vector or fulltext predicates because those indexes reflect current state.",
        );
      });
    }
  });

  describe("fulltext match", () => {
    const FULLTEXT_STRATEGY = {
      sqlite: fts5Strategy,
      postgres: tsvectorStrategy,
    } as const;

    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix().filter((entry) => !entry.recorded)) {
        it(`websearch match, ${variant.label} / ${dialect}`, () => {
          const compiled = compileQuery(
            withVariant(fulltextAst(), variant),
            graph.id,
            {
              dialect,
              fulltextStrategy: FULLTEXT_STRATEGY[dialect],
            },
          );
          expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
        });
      }
    }

    // Same refusal as the vector predicate above, and the same reason: a
    // fulltext index reflects current state only.
    for (const dialect of DIALECTS) {
      it(`recorded pin refuses the fulltext predicate / ${dialect}`, () => {
        const schema = DEFAULT_SQL_SCHEMA;
        const ast = { ...fulltextAst(), recordedAsOf: RECORDED_AS_OF };
        expect(() =>
          compileQuery(ast, graph.id, {
            dialect,
            schema,
            fulltextStrategy: FULLTEXT_STRATEGY[dialect],
            recordedReadBinding: createRecordedReadBinding(schema),
          }),
        ).toThrow(
          "Recorded-time queries cannot use vector or fulltext predicates because those indexes reflect current state.",
        );
      });
    }
  });
});

// ============================================================
// Section A2 — metadata, date, fragment, recursive-output, set-operation
// and alias shapes
// ============================================================

/**
 * A second graph for the shapes the shared fixture cannot express: date
 * properties (the shared fixture has none) and a weighted edge. Kept apart so
 * adding it does not move a single cell of the shared fixture's snapshots.
 */
const Meeting = defineNode("Meeting", {
  schema: z.object({
    title: z.string(),
    startsAt: z.date(),
    endsAt: z.date().optional(),
  }),
});

const attends = defineEdge("attends", {
  schema: z.object({ since: z.date().optional(), weight: z.number() }),
});

const scheduleGraph = defineGraph({
  id: "compile_golden_schedule",
  nodes: { Person: { type: Person }, Meeting: { type: Meeting } },
  edges: {
    attends: { type: attends, from: [Person], to: [Meeting] },
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

const scheduleRegistry = buildKindRegistry(scheduleGraph);

function scheduleBuilder() {
  return createQueryBuilder<typeof scheduleGraph>(
    scheduleGraph.id,
    scheduleRegistry,
  );
}

/** Canonical instants: the one ISO-8601 shape date predicates accept. */
const MIDNIGHT = "2024-01-01T00:00:00.000Z";
const MIDYEAR = "2024-06-01T12:00:00.000Z";

/**
 * Sixty-plus-character aliases the builder accepts (it allows at most 63):
 * once the compiler prefixes or suffixes them they exceed PostgreSQL's
 * 63-byte identifier limit, so these cells pin whatever identifier
 * generation does with them today. One character more is refused.
 */
const LONG_NODE_ALIAS =
  "person_alias_at_the_sixty_three_character_identifier_limit_xyzw";
const LONG_EDGE_ALIAS =
  "knows_edge_alias_sixty_one_characters_long_for_identifiers_ab";
const OVERLONG_NODE_ALIAS =
  "person_alias_one_character_past_the_sixty_three_character_limit_";

/**
 * Compiles a query a builder chain produces, or records the refusal it
 * raises: an alias shape the builder refuses today is pinned as that
 * refusal, so a later change that starts accepting it shows as a diff.
 */
function compileOrRefusal(
  build: () => Readonly<{ compile: () => SqlFragment }>,
  dialect: Dialect,
):
  | Readonly<{ sql: string; params: readonly unknown[] }>
  | Readonly<{ refused: string }> {
  try {
    return toSqlWithParams(build().compile(), dialect);
  } catch (error) {
    return {
      refused: `${(error as Error).name}: ${(error as Error).message}`,
    };
  }
}

/** Compiles a shared-fixture AST at the builder's own (current) coordinate. */
function compileCurrent(
  ast: QueryAst,
  dialect: Dialect,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  return toSqlWithParams(
    compileQuery(ast, graph.id, { dialect, schema: DEFAULT_SQL_SCHEMA }),
    dialect,
  );
}

describe("compile-golden: metadata, dates, fragments, recursive outputs, aliases", () => {
  goldenGrid(
    "$meta in whereNode (version and createdAt)",
    builder()
      .from("Person", "p")
      .whereNode("p", (p) =>
        p.$meta.version.gte(2).and(p.$meta.createdAt.lt(MIDNIGHT)),
      )
      .select((ctx) => ctx.p.id)
      .toAst(),
  );

  goldenGrid(
    "$meta in whereEdge (validFrom and deletedAt)",
    builder()
      .from("Person", "p")
      .traverse("worksAt", "e")
      .whereEdge("e", (edge) =>
        edge.$meta.validFrom
          .lt(new Date(MIDYEAR))
          .and(edge.$meta.deletedAt.isNull()),
      )
      .to("Organization", "o")
      .select((ctx) => ({ person: ctx.p.id, org: ctx.o.id }))
      .toAst(),
  );

  describe("date predicates with canonical operands", () => {
    // A user-schema date property takes Date operands; the compiler binds
    // their canonical ISO-8601 text. `$meta` instants above take strings.
    const shapes = {
      gte: () =>
        scheduleBuilder()
          .from("Meeting", "m")
          .whereNode("m", (m) => m.startsAt.gte(new Date(MIDNIGHT)))
          .select((ctx) => ctx.m.id),
      between: () =>
        scheduleBuilder()
          .from("Meeting", "m")
          .whereNode("m", (m) =>
            m.startsAt.between(new Date(MIDNIGHT), new Date(MIDYEAR)),
          )
          .select((ctx) => ctx.m.id),
      "in list": () =>
        scheduleBuilder()
          .from("Meeting", "m")
          .whereNode("m", (m) =>
            m.startsAt.in([new Date(MIDNIGHT), new Date(MIDYEAR)]),
          )
          .select((ctx) => ctx.m.id),
      "optional date isNull": () =>
        scheduleBuilder()
          .from("Meeting", "m")
          .whereNode("m", (m) => m.endsAt.isNull())
          .select((ctx) => ctx.m.id),
      "edge date property": () =>
        scheduleBuilder()
          .from("Person", "p")
          .traverse("attends", "a")
          .whereEdge("a", (edge) => edge.since.lt(new Date(MIDYEAR)))
          .to("Meeting", "m")
          .select((ctx) => ctx.m.id),
      // Pinned as today's refusal: a canonical string is not accepted for a
      // user-schema date property.
      "canonical string operand": () =>
        scheduleBuilder()
          .from("Meeting", "m")
          .whereNode("m", (m) => m.startsAt.gte(MIDNIGHT as unknown as Date))
          .select((ctx) => ctx.m.id),
    };
    for (const [label, query] of Object.entries(shapes)) {
      for (const dialect of DIALECTS) {
        it(`${label} / ${dialect}`, () => {
          expect(
            compileOrRefusal(
              () => ({
                compile: () =>
                  compileQuery(query().toAst(), scheduleGraph.id, {
                    dialect,
                    schema: DEFAULT_SQL_SCHEMA,
                  }),
              }),
              dialect,
            ),
          ).toMatchSnapshot();
        });
      }
    }
  });

  describe("fragments with declared aliases", () => {
    const fragment = createFragment<typeof graph>();
    const namedPeople = fragment({ p: "Person" }, (query) =>
      query.whereNode("p", (person) => person.name.startsWith("A")),
    );
    const employer = fragment({ p: "Person" }, (query) =>
      query.traverse("worksAt", "e", { from: "p" }).to("Organization", "o"),
    );
    const firstFive = fragment((query) => query.limit(5));

    goldenGrid(
      "piped filter, traversal and limit fragments",
      builder()
        .from("Person", "p")
        .pipe(namedPeople)
        .pipe(employer)
        .pipe(firstFive)
        .select((ctx) => ({ person: ctx.p.id, org: ctx.o.id }))
        .toAst(),
    );

    // A fragment is the transformation itself: piping it must emit the same
    // statement as writing the chain inline.
    for (const dialect of DIALECTS) {
      it(`piped fragments equal the inline chain / ${dialect}`, () => {
        const piped = builder()
          .from("Person", "p")
          .pipe(namedPeople)
          .pipe(employer)
          .pipe(firstFive)
          .select((ctx) => ({ person: ctx.p.id, org: ctx.o.id }))
          .toAst();
        const inline = builder()
          .from("Person", "p")
          .whereNode("p", (person) => person.name.startsWith("A"))
          .traverse("worksAt", "e", { from: "p" })
          .to("Organization", "o")
          .limit(5)
          .select((ctx) => ({ person: ctx.p.id, org: ctx.o.id }))
          .toAst();
        expect(compileCurrent(piped, dialect)).toEqual(
          compileCurrent(inline, dialect),
        );
      });
    }
  });

  goldenGrid(
    "recursive traversal with depth and path outputs",
    builder()
      .from("Person", "p")
      .whereNode("p", (person) => person.name.eq("root"))
      .traverse("knows", "e")
      .recursive({ maxHops: 3, depth: "level", path: "route" })
      .to("Person", "report")
      .select((ctx) => ({
        id: ctx.report.id,
        level: ctx.level,
        route: ctx.route,
      }))
      .toAst(),
  );

  goldenGrid(
    "recursive traversal with default depth alias and minHops",
    builder()
      .from("Person", "p")
      .traverse("knows", "e")
      .recursive({ minHops: 2, maxHops: 4, depth: true })
      .to("Person", "report")
      .select((ctx) => ({ id: ctx.report.id, depth: ctx.report_depth }))
      .toAst(),
  );

  describe("set operations: unionAll, except and a chained three-way", () => {
    for (const dialect of DIALECTS) {
      const leg = (alias: "a" | "b" | "c", name: string) =>
        createQueryBuilder<typeof graph>(graph.id, registry, { dialect })
          .from("Person", alias)
          .whereNode(alias, (person) => person.name.eq(name))
          .select((ctx) => ({ id: ctx[alias].id }));

      it(`unionAll / ${dialect}`, () => {
        const compiled = leg("a", "x").unionAll(leg("b", "y")).compile();
        expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
      });

      it(`except / ${dialect}`, () => {
        const compiled = leg("a", "x").except(leg("b", "y")).compile();
        expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
      });

      it(`union then except, chained / ${dialect}`, () => {
        const compiled = leg("a", "x")
          .union(leg("b", "y"))
          .except(leg("c", "z"))
          .compile();
        expect(toSqlWithParams(compiled, dialect)).toMatchSnapshot();
      });
    }
  });

  describe("long and case-differing aliases (pinned as they behave today)", () => {
    for (const dialect of DIALECTS) {
      const query = () =>
        createQueryBuilder<typeof graph>(graph.id, registry, { dialect });

      it(`60+ character node and edge aliases / ${dialect}`, () => {
        expect(
          compileOrRefusal(
            () =>
              query()
                .from("Person", LONG_NODE_ALIAS)
                .traverse("knows", LONG_EDGE_ALIAS)
                .to("Person", "friend")
                .select((ctx) => ({
                  person: ctx[LONG_NODE_ALIAS].id,
                  friend: ctx.friend.id,
                })),
            dialect,
          ),
        ).toMatchSnapshot();
      });

      it(`60+ character alias on a recursive traversal / ${dialect}`, () => {
        expect(
          compileOrRefusal(
            () =>
              query()
                .from("Person", "p")
                .traverse("knows", "e")
                .recursive({ maxHops: 2, path: true })
                .to("Person", LONG_NODE_ALIAS)
                .select((ctx) => ({ id: ctx[LONG_NODE_ALIAS].id })),
            dialect,
          ),
        ).toMatchSnapshot();
      });

      it(`64-character alias is refused / ${dialect}`, () => {
        expect(
          compileOrRefusal(
            () =>
              query()
                .from("Person", OVERLONG_NODE_ALIAS)
                .select((ctx) => ({ id: ctx[OVERLONG_NODE_ALIAS].id })),
            dialect,
          ),
        ).toMatchSnapshot();
      });

      // `person` / `Person` compile to unquoted identifiers that collide, so
      // both engines rejected the statement (SQLite: duplicate WITH table
      // name; PostgreSQL: WITH query name specified more than once). The name
      // registry now refuses it with a typed error before any SQL is built;
      // the test name keeps its original snapshot key.
      it(`node aliases differing only by case (known defect: SQL both engines reject) / ${dialect}`, () => {
        expect(
          compileOrRefusal(
            () =>
              query()
                .from("Person", "person")
                .traverse("knows", "e")
                .to("Person", "Person")
                .select((ctx) => ({
                  lower: ctx.person.id,
                  upper: ctx.Person.id,
                })),
            dialect,
          ),
        ).toMatchSnapshot();
      });

      it(`node and edge aliases differing only by case / ${dialect}`, () => {
        expect(
          compileOrRefusal(
            () =>
              query()
                .from("Person", "k")
                .traverse("knows", "K")
                .to("Person", "friend")
                .select((ctx) => ({ id: ctx.k.id, friend: ctx.friend.id })),
            dialect,
          ),
        ).toMatchSnapshot();
      });
    }
  });
});

// ============================================================
// Section B — store-level SQL builders
// ============================================================

describe("compile-golden: store statement builders", () => {
  const recursiveTraversal = assumeRecursiveTraversalSupported(
    "compile-golden pinning fixture — no backend involved",
  );

  describe("subgraph reachability (buildReachableCte)", () => {
    for (const variant of fullMatrix()) {
      for (const dialect of DIALECTS) {
        it(`single root, ${variant.label} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const fragment = buildReachableCte({
            graphId: graph.id,
            source: { kind: "Person", id: "person-1" },
            edgeKinds: ["knows"],
            maxHops: 3,
            direction: "out",
            cyclePolicy: "prevent",
            includePath: false,
            temporalMode: variant.mode,
            ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
            ...(variant.recorded ? { recordedAsOf: RECORDED_AS_OF } : {}),
            dialect: getDialect(dialect),
            schema,
            ...(variant.recorded ?
              { recordedReadBinding: createRecordedReadBinding(schema) }
            : {}),
            recursiveTraversal,
            operation: "subgraph",
          });
          expect(toSqlWithParams(fragment, dialect)).toMatchSnapshot();
        });

        it(`batch roots, ${variant.label} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const fragment = buildReachableCte({
            graphId: graph.id,
            sources: [
              { kind: "Person", id: "person-1" },
              { kind: "Person", id: "person-2" },
            ],
            edgeKinds: ["knows"],
            maxHops: 3,
            direction: "out",
            cyclePolicy: "prevent",
            includePath: false,
            temporalMode: variant.mode,
            ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
            ...(variant.recorded ? { recordedAsOf: RECORDED_AS_OF } : {}),
            dialect: getDialect(dialect),
            schema,
            ...(variant.recorded ?
              { recordedReadBinding: createRecordedReadBinding(schema) }
            : {}),
            recursiveTraversal,
            operation: "batchOnce.subgraph",
          });
          expect(toSqlWithParams(fragment, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("subgraph edge windows (executeSubgraph with edgeWindows)", () => {
    // Captured from a real windowed `executeSubgraph` call rather than from
    // `buildWindowedEdgesCte` with a hand-built filter: the row filter a
    // window ranks over is assembled by the production callers (the
    // reachability CTE's windowed edge relation and the edge fetch's
    // windowed source), so only the real call pins what those callers pass.
    // One unbounded kind (`knows`) and one windowed kind (`worksAt`, ordered
    // and limited) share the call, across the full valid-time × recorded
    // grid.
    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        it(`unbounded knows, windowed worksAt, ${variant.label} / ${dialect}`, async () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const { backend, captured } = subgraphFetchCapture(dialect);
          await executeSubgraph({
            graph,
            graphId: graph.id,
            root: { kind: "Person", id: asNodeId<typeof Person>("person-1") },
            registry,
            backend,
            dialect: getDialect(dialect),
            schema,
            recordedReadBinding:
              variant.recorded ? createRecordedReadBinding(schema) : undefined,
            options: {
              edges: ["knows", "worksAt"],
              edgeWindows: {
                worksAt: {
                  limit: 5,
                  orderBy: { field: "createdAt", direction: "desc" },
                },
              },
              maxDepth: 3,
              temporalMode: variant.mode,
              ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
              ...(variant.recorded ? { recordedAsOf: RECORDED_AS_OF } : {}),
            },
          });
          const statements = captured.map((fragment) =>
            toSqlWithParams(fragment, dialect),
          );
          // Both production window sources were reached: the reachability
          // CTE's ranked edge relation and the edge fetch's windowed source.
          expect(
            statements.some((statement) =>
              statement.sql.includes("typegraph_windowed_edges AS ("),
            ),
          ).toBe(true);
          expect(
            statements.some((statement) =>
              statement.sql.includes(") windowed_edge)"),
            ),
          ).toBe(true);
          expect(statements).toMatchSnapshot();
        });
      }
    }
  });

  describe("algorithm expansion (store.algorithms.reachable, one hop)", () => {
    const rootRef = { kind: "Person", id: asNodeId("person-1") } as const;
    // A separate, identity-free graph: `graph`'s `sameIdAcrossKinds: "fold"`
    // requires an atomic transactional backend at store construction, which
    // this capture backend deliberately is not (see the comment above).
    // Algorithm expansion does not touch identity reconstruction, so the
    // fixture omits it.
    const algorithmGraph = defineGraph({
      id: "compile_golden_algorithms",
      nodes: { Person: { type: Person } },
      edges: { knows: { type: knows, from: [Person], to: [Person] } },
    });

    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        it(`${variant.label} / ${dialect}`, async () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const { backend, captured } = algorithmExpansionCapture(dialect);
          const store = createStore(algorithmGraph, backend, {
            schema,
            ...(variant.recorded ?
              { recordedRead: recordedRelation({ schema }) }
            : {}),
          });
          const options = {
            edges: ["knows"],
            maxHops: 1,
            direction: "out",
          } as const;
          if (variant.recorded) {
            const view = store
              .view(variantViewCoordinate(variant))
              .asOfRecorded(RECORDED_AS_OF);
            await view.algorithms.reachable(rootRef, options);
          } else {
            await store.algorithms.reachable(rootRef, {
              ...options,
              temporalMode: variant.mode,
              ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
            });
          }
          expectReachableExpansionCaptured(captured, dialect);
          expect(
            captured.map((fragment) => toSqlWithParams(fragment, dialect)),
          ).toMatchSnapshot();
        });
      }
    }

    // The block above pins direction "out" only. Direction "both" compiles
    // to one statement per round (the two directional halves joined by
    // `UNION ALL` — see `compileDirectionUnion`), not two separate
    // statements, which is exactly the shape a direction-union refactor
    // would change.
    for (const dialect of DIALECTS) {
      it(`current, direction "both" / ${dialect}`, async () => {
        const { backend, captured } = algorithmExpansionCapture(dialect);
        const store = createStore(algorithmGraph, backend, {
          schema: DEFAULT_SQL_SCHEMA,
        });
        await store.algorithms.reachable(rootRef, {
          edges: ["knows"],
          maxHops: 1,
          direction: "both",
        });
        expectReachableExpansionCaptured(captured, dialect);
        expect(
          captured.map((fragment) => toSqlWithParams(fragment, dialect)),
        ).toMatchSnapshot();
      });
    }
  });

  describe("algorithm expansion, default working-table path (interactive transactions)", () => {
    // The block above forces the inline `VALUES`-chunked fallback via
    // `disableTransactions`. A backend with interactive transactions and
    // temporary-statement support (an ordinary `createTestBackend()`) takes
    // the DEFAULT path instead: a connection-local temp table, seeded and
    // then expanded round by round (`runIterativeGraphOperation`,
    // `findReachableNodesInWorkingTable`). The analytics cells below also
    // pin working-table statements, with canned rows. This block uses a real
    // (in-memory SQLite) database, since the working table's contents drive
    // each round's real query plan, unlike the canned-row overlay the
    // inline-path capture above uses. The temp table's name carries a
    // random per-run suffix (`typegraph_iterative_<nanoid>`), normalized to
    // a stable placeholder before snapshotting.
    //
    // Gridded over all valid-time modes × recorded on/off, as above:
    // `recordedAsOf` flows into the seed and expansion
    // statements this path builds (`iterative-graph-operation.ts`), and
    // `supportsTemporaryIteration` does not gate on the coordinate, so a
    // recorded pin genuinely reaches the working-table path in production
    // rather than being silently rerouted to the inline fallback. No
    // PostgreSQL/PGlite cell: this block uses real working-table rows to
    // check the reached nodes. The canned-row cells below cover both SQL
    // dialects for shortest-path working-table statements.
    const workingTableGraph = defineGraph({
      id: "compile_golden_algorithms_working_table",
      nodes: { Person: { type: Person } },
      edges: { knows: { type: knows, from: [Person], to: [Person] } },
    });

    for (const variant of fullMatrix()) {
      it(`${variant.label}, direction "out" / sqlite`, async () => {
        const base = createTestBackend();
        const schema = DEFAULT_SQL_SCHEMA;
        const store = createStore(workingTableGraph, base, {
          schema,
          ...(variant.recorded ? { history: true } : {}),
        });
        const validFrom = "2025-01-01T00:00:00.000Z";
        const alice = await store.nodes.Person.create(
          { name: "alice" },
          { validFrom },
        );
        const bob = await store.nodes.Person.create(
          { name: "bob" },
          { validFrom },
        );
        await store.edges.knows.create(alice, bob, {}, { validFrom });

        const captured: SqlFragment[] = [];
        const recording = deriveBackend(base, {
          ...recordingOverlayMembers(base, captured),
          transaction: <T>(
            fn: (tx: TransactionBackend) => Promise<T>,
            options?: TransactionOptions,
          ): Promise<T> =>
            base.transaction(
              (tx) =>
                fn(deriveBackend(tx, recordingOverlayMembers(tx, captured))),
              options,
            ),
        });
        const recordingStore = createStore(workingTableGraph, recording, {
          schema,
          ...(variant.recorded ? { history: true } : {}),
        });
        const options = {
          edges: ["knows"],
          maxHops: 1,
          direction: "out",
        } as const;
        // A real store mints its own allocation owner, so the anchor is
        // built from the owner it persisted rather than the fixed golden one.
        const recordedView =
          variant.recorded ?
            recordingStore
              .view(variantViewCoordinate(variant))
              .asOfRecorded(
                createRecordedInstant(
                  RECORDED_REVISION,
                  RECORDED_AT,
                  await readGraphAllocationOwner(
                    base,
                    schema,
                    workingTableGraph.id,
                  ),
                ),
              )
          : undefined;
        const reached =
          recordedView === undefined ?
            await recordingStore.algorithms.reachable(alice, {
              ...options,
              temporalMode: variant.mode,
              ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
            })
          : await recordedView.algorithms.reachable(alice, options);
        expect(reached.map((node) => node.id).toSorted()).toEqual(
          [alice.id, bob.id].toSorted(),
        );
        expectReachableExpansionCaptured(captured, "sqlite");
        expect(
          capturedAlgorithmStatements(captured, "sqlite"),
        ).toMatchSnapshot();
      });
    }
  });

  describe("algorithm degree and weighted expansion", () => {
    const algorithmGraph = defineGraph({
      id: "compile_golden_algorithm_statements",
      nodes: { Person: { type: Person } },
      edges: { knows: { type: knows, from: [Person], to: [Person] } },
    });
    const rootRef = { kind: "Person", id: asNodeId("person-1") } as const;
    const targetRef = { kind: "Person", id: asNodeId("person-2") } as const;

    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        for (const direction of ["out", "both"] as const) {
          it(`degree ${direction}, ${variant.label} / ${dialect}`, async () => {
            const { backend, captured } = algorithmStatementCapture(
              dialect,
              () => [{ count: 0 }],
            );
            const schema = DEFAULT_SQL_SCHEMA;
            const store = createStore(algorithmGraph, backend, {
              schema,
              ...(variant.recorded ?
                { recordedRead: recordedRelation({ schema }) }
              : {}),
            });
            const view = store.view(variantViewCoordinate(variant));
            const target =
              variant.recorded ? view.asOfRecorded(RECORDED_AS_OF) : view;
            await target.algorithms.degree(rootRef, {
              edges: ["knows"],
              direction,
            });
            expect(withoutOriginProbes(captured, dialect)).toHaveLength(1);
            expect(
              capturedAlgorithmStatements(captured, dialect),
            ).toMatchSnapshot();
          });
        }

        it(`weighted audit and inline expansion, ${variant.label} / ${dialect}`, async () => {
          const { backend, captured } = algorithmStatementCapture(
            dialect,
            (statement) =>
              statement.includes("SELECT n.id, n.kind") ?
                [
                  { id: "person-1", kind: "Person" },
                  { id: "person-2", kind: "Person" },
                ]
              : [],
          );
          const inlineBackend = disableTransactions(backend);
          const schema = DEFAULT_SQL_SCHEMA;
          const store = createStore(algorithmGraph, inlineBackend, {
            schema,
            ...(variant.recorded ?
              { recordedRead: recordedRelation({ schema }) }
            : {}),
          });
          const view = store.view(variantViewCoordinate(variant));
          const target =
            variant.recorded ? view.asOfRecorded(RECORDED_AS_OF) : view;
          await target.algorithms.weightedShortestPath(rootRef, targetRef, {
            edges: ["knows"],
            weightProperty: "weight",
            defaultWeight: 1,
          });
          expect(withoutOriginProbes(captured, dialect)).toHaveLength(3);
          expect(
            capturedAlgorithmStatements(captured, dialect),
          ).toMatchSnapshot();
        });

        it(`weighted working-table path, ${variant.label} / ${dialect}`, async () => {
          const { backend, captured } = algorithmStatementCapture(
            dialect,
            (statement) => {
              if (
                statement.includes("n.id =") &&
                statement.includes("LIMIT 1")
              ) {
                return [{ id: "person-2" }];
              }
              if (statement.includes("RETURNING node_id, distance")) {
                return [];
              }
              if (statement.includes("RETURNING node_id")) {
                return [{ node_id: "person-1" }];
              }
              return [];
            },
          );
          const schema = DEFAULT_SQL_SCHEMA;
          const store = createStore(algorithmGraph, backend, {
            schema,
            ...(variant.recorded ?
              { recordedRead: recordedRelation({ schema }) }
            : {}),
          });
          const view = store.view(variantViewCoordinate(variant));
          const target =
            variant.recorded ? view.asOfRecorded(RECORDED_AS_OF) : view;
          await target.algorithms.weightedShortestPath(rootRef, targetRef, {
            edges: ["knows"],
            weightProperty: "weight",
            defaultWeight: 1,
          });
          expect(
            captured.some((fragment) =>
              toSqlWithParams(fragment, dialect).sql.includes(
                "RETURNING node_id, distance",
              ),
            ),
          ).toBe(true);
          expect(
            captured.some((fragment) =>
              toSqlWithParams(fragment, dialect).sql.includes(
                "WITH RECURSIVE chain AS",
              ),
            ),
          ).toBe(true);
          expect(
            capturedAlgorithmStatements(captured, dialect),
          ).toMatchSnapshot();
        });

        for (const algorithm of ["shortestPath", "canReach"] as const) {
          it(`${algorithm} working-table path, ${variant.label} / ${dialect}`, async () => {
            let seededSides = 0;
            const { backend, captured } = algorithmStatementCapture(
              dialect,
              (statement) => {
                if (
                  statement.includes(
                    "RETURNING node_id, node_kind, meeting_depth",
                  )
                ) {
                  return [
                    {
                      node_id: "person-2",
                      node_kind: "Person",
                      meeting_depth: 0,
                    },
                  ];
                }
                if (statement.includes("RETURNING node_id, node_kind")) {
                  seededSides++;
                  return [
                    {
                      node_id: seededSides === 1 ? "person-1" : "person-2",
                      node_kind: "Person",
                    },
                  ];
                }
                if (statement.includes("SELECT side, node_id, node_kind")) {
                  return [
                    {
                      side: "forward",
                      node_id: "person-1",
                      node_kind: "Person",
                      depth: 0,
                      predecessor_id: undefined,
                      predecessor_kind: undefined,
                    },
                    {
                      side: "forward",
                      node_id: "person-2",
                      node_kind: "Person",
                      depth: 1,
                      predecessor_id: "person-1",
                      predecessor_kind: "Person",
                    },
                    {
                      side: "reverse",
                      node_id: "person-2",
                      node_kind: "Person",
                      depth: 0,
                      predecessor_id: undefined,
                      predecessor_kind: undefined,
                    },
                  ];
                }
                return [];
              },
            );
            const schema = DEFAULT_SQL_SCHEMA;
            const store = createStore(algorithmGraph, backend, {
              schema,
              ...(variant.recorded ?
                { recordedRead: recordedRelation({ schema }) }
              : {}),
            });
            const view = store.view(variantViewCoordinate(variant));
            const target =
              variant.recorded ? view.asOfRecorded(RECORDED_AS_OF) : view;
            const result = await target.algorithms[algorithm](
              rootRef,
              targetRef,
              {
                edges: ["knows"],
                maxHops: 1,
              },
            );
            expect(result).toEqual(
              algorithm === "canReach" ? true : (
                {
                  nodes: [
                    { id: "person-1", kind: "Person" },
                    { id: "person-2", kind: "Person" },
                  ],
                  depth: 1,
                }
              ),
            );
            expect(
              captured.some((fragment) =>
                toSqlWithParams(fragment, dialect).sql.includes(
                  "RETURNING node_id, node_kind, meeting_depth",
                ),
              ),
            ).toBe(true);
            expect(
              capturedAlgorithmStatements(captured, dialect),
            ).toMatchSnapshot();
          });
        }
      }
    }
  });

  describe("graph analytics iteration statements", () => {
    const algorithmGraph = defineGraph({
      id: "compile_golden_analytics",
      nodes: { Person: { type: Person } },
      edges: { knows: { type: knows, from: [Person], to: [Person] } },
    });
    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        for (const algorithm of [
          "pageRank",
          "weaklyConnectedComponents",
          "labelPropagation",
        ] as const) {
          it(`${algorithm}, ${variant.label} / ${dialect}`, async () => {
            const { backend, captured } = algorithmStatementCapture(
              dialect,
              (statement) =>
                statement.includes("SELECT COUNT(*) AS count") ?
                  [{ count: 1 }]
                : [],
            );
            const schema = DEFAULT_SQL_SCHEMA;
            const store = createStore(algorithmGraph, backend, {
              schema,
              ...(variant.recorded ?
                { recordedRead: recordedRelation({ schema }) }
              : {}),
            });
            const view = store.view(variantViewCoordinate(variant));
            const target =
              variant.recorded ? view.asOfRecorded(RECORDED_AS_OF) : view;
            await target.algorithms[algorithm]({ edges: ["knows"] });
            expect(
              captured.some((fragment) =>
                toSqlWithParams(fragment, dialect).sql.includes(
                  " AS target_id",
                ),
              ),
            ).toBe(true);
            expect(
              capturedAlgorithmStatements(captured, dialect),
            ).toMatchSnapshot();
          });
        }
      }
    }
  });

  describe("weighted and personalized PageRank iteration statements", () => {
    const weightedEdge = defineEdge("rates", {
      schema: z.object({ weight: z.number() }),
    });
    const rankGraph = defineGraph({
      id: "compile_golden_rank",
      nodes: { Person: { type: Person } },
      edges: {
        rates: { type: weightedEdge, from: [Person], to: [Person] },
      },
    });
    const runs = {
      "weighted pageRank": (target: RankTarget) =>
        target.algorithms.pageRank({
          edges: ["rates"],
          weightProperty: "weight",
          defaultWeight: 1,
        }),
      "personalized pageRank": (target: RankTarget) =>
        target.algorithms.personalizedPageRank({
          edges: ["rates"],
          seeds: [{ kind: "Person", id: "person-1" }],
        }),
      "weighted personalized pageRank, weighted seeds": (target: RankTarget) =>
        target.algorithms.personalizedPageRank({
          edges: ["rates"],
          weightProperty: "weight",
          seeds: [
            { kind: "Person", id: "person-1", weight: 3 },
            { kind: "Person", id: "person-2", weight: 1 },
          ],
        }),
    } as const;
    type RankTarget = Readonly<{
      algorithms: ReturnType<
        typeof createStore<typeof rankGraph>
      >["algorithms"];
    }>;

    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        for (const [label, run] of Object.entries(runs)) {
          it(`${label}, ${variant.label} / ${dialect}`, async () => {
            const { backend, captured } = algorithmStatementCapture(
              dialect,
              (statement) => {
                if (statement.includes("SELECT COUNT(*) AS count")) {
                  return [{ count: 1 }];
                }
                // The seed-visibility read: every seed is in the subgraph.
                if (statement.includes("AND personalization > 0")) {
                  return [
                    { node_id: "person-1", node_kind: "Person" },
                    { node_id: "person-2", node_kind: "Person" },
                  ];
                }
                return [];
              },
            );
            const schema = DEFAULT_SQL_SCHEMA;
            const store = createStore(rankGraph, backend, {
              schema,
              ...(variant.recorded ?
                { recordedRead: recordedRelation({ schema }) }
              : {}),
            });
            const view = store.view(variantViewCoordinate(variant));
            await run(
              variant.recorded ? view.asOfRecorded(RECORDED_AS_OF) : view,
            );
            expect(
              capturedAlgorithmStatements(captured, dialect),
            ).toMatchSnapshot();
          });
        }
      }
    }
  });

  describe("neighbors (createNeighborRead)", () => {
    for (const dialect of DIALECTS) {
      for (const mode of MODES) {
        // Neighbors have no recorded-read binding today — no
        // `recordedReadBinding` field reaches `buildNeighborQuery`, so
        // there is no recorded axis to grid here yet.
        it(`${mode} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const read = createNeighborRead(
            {
              graphId: graph.id,
              backend: createTestBackend(),
              schema,
              defaultTemporalMode: graph.defaults.temporalMode,
              registry,
            },
            { kind: "Person", id: asNodeId("person-1") },
            {
              edges: ["knows"],
              temporalMode: mode,
              ...(mode === "asOf" ? { asOf: AS_OF_TIMESTAMP } : {}),
            },
          );
          const item = read.compileOneStatementBatchItem();
          expect(toSqlWithParams(item.query, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("neighbors count (createNeighborCountRead)", () => {
    // The aggregate sibling of the read above (`countNeighbors`) compiles a
    // different statement — `buildNeighborQuery(..., aggregate: true)` — not
    // merely the same query with a different row mapper, so it needs its
    // own pin, gridded over the same mode axis as the neighbors read above
    // (still no recorded-read binding reaches `buildNeighborQuery`, so
    // there is no recorded axis to grid here either).
    for (const dialect of DIALECTS) {
      for (const mode of MODES) {
        it(`${mode} / ${dialect}`, () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const read = createNeighborCountRead(
            {
              graphId: graph.id,
              backend: createTestBackend(),
              schema,
              defaultTemporalMode: graph.defaults.temporalMode,
              registry,
            },
            { kind: "Person", id: asNodeId("person-1") },
            {
              edges: ["knows"],
              temporalMode: mode,
              ...(mode === "asOf" ? { asOf: AS_OF_TIMESTAMP } : {}),
            },
          );
          const item = read.compileOneStatementBatchItem();
          expect(toSqlWithParams(item.query, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("subgraph fetch statements (both membership strategies)", () => {
    for (const dialect of DIALECTS) {
      for (const variant of fullMatrix()) {
        it(`${variant.label} / ${dialect}`, async () => {
          const schema = DEFAULT_SQL_SCHEMA;
          const { backend, captured } = subgraphFetchCapture(dialect);
          await executeSubgraph({
            graph,
            graphId: graph.id,
            root: { kind: "Person", id: asNodeId<typeof Person>("person-1") },
            registry,
            backend,
            dialect: getDialect(dialect),
            schema,
            recordedReadBinding:
              variant.recorded ? createRecordedReadBinding(schema) : undefined,
            options: {
              edges: ["knows"],
              maxDepth: 3,
              temporalMode: variant.mode,
              ...(variant.asOf === undefined ? {} : { asOf: variant.asOf }),
              ...(variant.recorded ? { recordedAsOf: RECORDED_AS_OF } : {}),
            },
          });
          expect(
            captured.map((fragment) => toSqlWithParams(fragment, dialect)),
          ).toMatchSnapshot();
        });
      }
    }
  });

  describe("historical identity reconstruction", () => {
    for (const variant of fullMatrix()) {
      for (const dialect of DIALECTS) {
        it(`class reconstruction, ${variant.label} / ${dialect}`, () => {
          const schema = createSqlSchema();
          const coordinate = identitySqlCoordinate(
            variantCoordinate(variant),
            FAKE_NOW,
          );
          const fragment = historicalIdentityReconstructionCtes({
            schema,
            graphId: graph.id,
            coordinate,
            seedSource: identityNodeSnapshotSource(
              schema,
              graph.id,
              coordinate,
            ),
            sameIdAcrossKinds: "fold",
            recursiveTraversal,
          });
          expect(toSqlWithParams(fragment, dialect)).toMatchSnapshot();
        });

        it(`peer-class query, ${variant.label} / ${dialect}`, () => {
          const schema = createSqlSchema();
          const coordinate = identitySqlCoordinate(
            variantCoordinate(variant),
            FAKE_NOW,
          );
          const fragment = historicalIdentityPeerClassQuery({
            schema,
            graphId: graph.id,
            coordinate,
            sameIdAcrossKinds: "fold",
            recursiveTraversal,
          });
          expect(toSqlWithParams(fragment, dialect)).toMatchSnapshot();
        });
      }
    }
  });

  describe("separation-probe fixed fragment (identityAssertionSnapshotSource)", () => {
    for (const dialect of DIALECTS) {
      it(`current, no recorded pin / ${dialect}`, () => {
        const schema = createSqlSchema();
        const coordinate = identitySqlCoordinate(undefined, FAKE_NOW);
        const fragment = identityAssertionSnapshotSource(
          schema,
          graph.id,
          coordinate,
          "different",
        );
        expect(toSqlWithParams(fragment, dialect)).toMatchSnapshot();
      });
    }
  });

  describe("separation-probe statements (separationRebuildRequired)", () => {
    /**
     * `identityAssertionSnapshotSource` above pins the snapshot subquery in
     * isolation; it does not pin what `separationRebuildRequired` (the
     * relation's healing check, `identity/separation.ts`) actually sends —
     * the cheap any-live-different probe, and, only when that is true, the
     * exact owed-separation probe with its closure joins. Both are captured
     * here, for a graph with three identity-active kinds (Person,
     * Organization, Document), all in one chunk at this budget
     * (`maxBindParameters: 999`), exactly as `separationRebuildRequired`
     * runs in production.
     */
    for (const dialect of DIALECTS) {
      it(`current, owed separation exists / ${dialect}`, async () => {
        const captured: SqlFragment[] = [];
        const target = {
          dialect,
          capabilities: { maxBindParameters: 999 },
          execute: (query: SqlFragment) => {
            captured.push(query);
            return Promise.resolve([{ present: 1 }]);
          },
          executeStatement: () => Promise.resolve(undefined),
        };
        await separationRebuildRequired(
          target as unknown as Parameters<typeof separationRebuildRequired>[0],
          createSqlSchema(),
          graph.id,
          { relationExists: false, registry },
        );
        expect(
          captured.map((fragment) => toSqlWithParams(fragment, dialect)),
        ).toMatchSnapshot();
      });
    }
  });
});

// ============================================================
// Section C — set-based write candidate selection
// ============================================================

/**
 * `updateWhere` compiles its selectors (`where`, `candidates`, `exists`)
 * into one candidate-id relation and hands it to the backend's
 * `updateNodeSet` port. These cells run the real collection and pin the
 * relation that port receives; the capture answers the port with no
 * affected rows, so no write statement runs.
 */
function candidateSelectionCapture(
  dialect: Dialect,
): Readonly<{ backend: GraphBackend; received: SqlFragment[] }> {
  const received: SqlFragment[] = [];
  const { backend: capture } = algorithmStatementCapture(dialect, () => []);
  const updateNodeSet = (
    params: UpdateNodeSetParams,
  ): Promise<UpdateNodeSetResult> => {
    received.push(params.candidateIds);
    return Promise.resolve({ affectedCount: 0, rows: [] });
  };
  const backend = deriveBackend(capture, {
    updateNodeSet,
    transaction: <T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> =>
      capture.transaction(
        (tx) => fn(deriveBackend(tx, { updateNodeSet })),
        options,
      ),
  });
  return { backend, received };
}

describe("compile-golden: updateWhere candidate selection", () => {
  const selectors = {
    where: (store: GoldenStore) =>
      store.nodes.Person.updateWhere({
        where: (person) => person.name.eq("alice"),
        patch: { age: 30 },
      }),
    "where on $meta": (store: GoldenStore) =>
      store.nodes.Person.updateWhere({
        where: (person) => person.$meta.version.lt(3),
        patch: { age: 30 },
      }),
    "same-store candidate query": (store: GoldenStore) =>
      store.nodes.Person.updateWhere({
        candidates: store
          .query()
          .from("Person", "candidate", { expansion: "exact" })
          .traverse("worksAt", "employment")
          .to("Organization", "employer")
          .whereNode("employer", (employer) => employer.industry.eq("Tech"))
          .select((ctx) => ctx.candidate.id),
        patch: { age: 30 },
      }),
    "candidate query intersected with where": (store: GoldenStore) =>
      store.nodes.Person.updateWhere({
        candidates: store
          .query()
          .from("Person", "candidate", { expansion: "exact" })
          .select((ctx) => ctx.candidate.id),
        where: (person) => person.age.gte(18),
        patch: { age: 30 },
      }),
    "exists relation with edge and related filters": (store: GoldenStore) =>
      store.nodes.Person.updateWhere({
        exists: [
          {
            edgeKind: "worksAt",
            direction: "out",
            relatedKind: "Organization",
            whereEdge: (edge) => edge.field("role").string().eq("engineer"),
            whereRelated: (related) =>
              related.field("industry").string().eq("Tech"),
          },
        ],
        patch: { age: 30 },
      }),
    "all: true": (store: GoldenStore) =>
      store.nodes.Person.updateWhere({ all: true, patch: { age: 30 } }),
  } as const;
  type GoldenStore = ReturnType<typeof createStore<typeof graph>>;

  for (const dialect of DIALECTS) {
    for (const [label, run] of Object.entries(selectors)) {
      it(`${label} / ${dialect}`, async () => {
        const { backend, received } = candidateSelectionCapture(dialect);
        const store = createStore(graph, backend, {
          schema: DEFAULT_SQL_SCHEMA,
        });
        await expect(run(store)).resolves.toEqual({ affectedCount: 0 });
        expect(received).toHaveLength(1);
        expect(
          toSqlWithParams(requireDefined(received[0]), dialect),
        ).toMatchSnapshot();
      });
    }
  }
});

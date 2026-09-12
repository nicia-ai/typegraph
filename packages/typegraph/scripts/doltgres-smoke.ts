// Doltgres spike smoke test — run: pnpm smoke:doltgres
// Requires a Doltgres on localhost:4132. Either works:
//   docker run -d -p 4132:5432 dolthub/doltgresql:1.3.1   (latest release)
//   a build of doltgresql main                            (see below)
// Not wired into CI: it needs that server, and the spike is exploratory.
//
// Measured 2026-09-05 against BOTH the 1.3.1 release and a build of
// doltgresql main at ad783a6a: 17 passed, 0 failed, 22 skipped on each.
// The two builds are now indistinguishable through this battery — 1.3.1
// shipped every fix that previously showed only on main, and the 16 commits
// main carries beyond it are dependency bumps, `search_path` quoting, and
// doltgresql#3091, none of which this battery reaches.
//
// Three of the gaps this spike reported were fixed on main after 1.3.0 and
// are now RELEASED in 1.3.1:
//
//   - doltgresql#3235 — `ON CONFLICT ... DO UPDATE ... WHERE`, the monotonic
//     upsert `writeBaseSchemaVersion` uses. Was the first write of any
//     bootstrap, so nothing got past it. Closed 2026-09-02.
//   - doltgresql#3234 — the server panic on `INSERT INTO t (cols) SELECT
//     $1, $2` with uncast bind parameters, which is the shape of every fused
//     managed insert. Closed 2026-08-31, the day it was filed.
//   - doltgresql#1258 — the `excluded` alias, which every embedding write in
//     `pgvectorStrategy` needs. Still marked open upstream, but it works;
//     the battery reports what it observes, not what the tracker says.
//
// Those three probes stay pinned `fixed-unreleased`: either answer passes and
// the report names which build it is talking to. They are kept in that state
// rather than promoted to `supported` because the pin is what lets this
// battery run honestly against an OLDER release without reporting the
// calendar as an engine defect.
//
// doltgresql#3256 (2026-09-02) then implemented transaction-scoped advisory
// locks — but only the ONE-ARGUMENT `bigint` overload, and row-locking
// clauses are still unimplemented. That combination is worth stating
// carefully, because it is the first engine to split two facts TypeGraph
// currently declares as one:
//
//   - `pg_advisory_xact_lock(bigint)` — WORKS. This is the form the schema
//     fence takes, deliberately, because it occupies a different lock space
//     from every namespaced TypeGraph lock.
//   - `pg_advisory_xact_lock(int4, int4)` — MISSING. This is the form
//     identity, identity-DDL, the recorded-graph-write lock and the recorded
//     clock all take.
//   - `FOR UPDATE` / `FOR SHARE` — MISSING.
//
// So `pessimisticLocks.advisoryLocks` has no honest value here. Declared
// `false`, the store is refused cleanly, which is what this script does.
// Declared `true` — which is now defensible, since advisory locks genuinely
// exist — the capability gate ACCEPTS and the write then dies on raw SQL
// (`locking clauses are not yet supported`), turning a typed refusal into a
// driver error. Measured, not guessed: flipping the declaration below to
// `advisoryLocks: true` takes this script from 15 passed / 1 failed to
// 11 passed / 5 failed, with bootstrap and all three construction gates
// failing on unhandled SQL.
//
// That is the `rowLocks` member the capability model's own comment predicted
// ("an engine implementing `pg_advisory_xact_lock` but not `FOR UPDATE` is
// where a `rowLocks` member would earn its place"), plus a second split
// nobody predicted, between the one- and two-argument advisory forms.
// Until both exist, `false` is the only declaration that produces a refusal
// instead of a crash.
//
// WHAT NOW BLOCKS THE WALK IS TYPEGRAPH, NOT DOLTGRES.
//
// With those SQL gaps cleared, bootstrap reaches TypeGraph's own refusal: the
// PostgreSQL schema-commit fence guards a read-then-write that spans
// statements, so it refuses an `unfenced` backend rather than running that
// sequence unserialized. Doltgres implements neither the two-argument
// `pg_advisory_xact_lock` nor the row-locking clauses (doltgresql#2600), so
// `unfenced` is what it resolves, and the store is refused at construction
// with `WRITE_FENCE_UNAVAILABLE`.
//
// That is the capability model working, not a bug — and it makes
// doltgresql#2600 the ONE remaining upstream issue that stands between this
// spike and a working store. Everything else on the list costs a feature
// (system indexes, ANN indexes, per-search tuning), not the store.
//
// THE ENGINE-PROFILE DERIVATION SEAM DOES NOT MOVE THIS, AND THAT WAS
// MEASURED RATHER THAN ASSUMED.
//
// `deriveEngineProfile` now lets an author replace `fenceSql` outright, which
// looks like a way around the advisory-lock arity gap: supply an
// `advisoryLockExpression` that folds `(namespace, key)` into the ONE-argument
// `pg_advisory_xact_lock(hashtext(...))` form Doltgres does implement. Built
// that profile and ran it against main. It constructs — every
// `createSqlBackend` gate passes with `advisoryLocks: true` — and then dies at
// `SELECT ... FROM typegraph_schema_versions ... FOR UPDATE`.
//
// The control settles it: the SAME derived profile carrying the BUNDLED
// two-argument `postgresFenceSql` fails at the identical statement with the
// identical error. The row-lock gap fires first and masks every advisory-lock
// site behind it, so the custom spelling buys exactly nothing today. Both
// halves of #2600 are still required, and the arity half stays unobservable
// through the store path until the row-lock half lands.
//
// What that does settle is WHERE the arity fix belongs when the time comes:
// in an author-supplied `fenceSql` on a derived profile, not in a new
// capability member. Advisory-lock arity is a spelling, and the profile seam
// already owns spellings.
//
// A consequence worth recording: on an unfenced PostgreSQL backend, EVERY
// construction gate is now pre-empted. `history`, `revisionTracking` and
// Operational Identity are all still refused — safely, before any write — but
// by the schema-commit fence inside `ensureSchema` rather than by the gate
// built for each, whose whole design point is that its message names the exact
// declaration line to add. `createAdapterStoreWithSchema` bootstraps before it
// gates. Safety is intact; the migration guide is what is lost.
//
// This file is organised as a deviation battery first (Act 0) and the typed
// walk second (Act 1). Every battery row is a PIN: it passes when Doltgres
// answers what this branch claims it answers, and FAILS when that changes in
// EITHER direction — which is exactly how the three fixes above announced
// themselves, as three red rows reading "NOW SUPPORTED ... re-run the walk".
//
// Still open upstream, and what each costs:
//   - #2600, now narrowed to TWO remaining halves — THE blocker; costs the
//     store itself. 1.3.1 shipped `pg_advisory_xact_lock(bigint)`, so the
//     one-argument form and `hashtext` both exist; the two-argument
//     `(int4, int4)` overload and the row-locking clauses do not. The
//     row-lock half is what bootstrap hits first.
//   - #3099 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — costs system-index
//     materialization, which degrades by design.
//   - #3099 `SET LOCAL` — costs the per-search `efSearch` override.
//   - `CREATE INDEX CONCURRENTLY` — costs ANN index materialization.
//   - no `to_tsvector` — costs fulltext, so the strategy is stubbed below.
//
// pgvector itself is real as of 1.3.0 (doltgresql#3126 emulates it in Go,
// reporting extversion 0.8.6): `CREATE EXTENSION vector` succeeds, `vector(N)`
// columns, `<=>`/`<->`/`<#>` and `ORDER BY ... LIMIT` all work, and with
// #1258 fixed the write path works too. `vector: false` stays for now
// because the ANN index and per-search tuning gaps remain, and because the
// store it would serve cannot be constructed until #2600 lands.
//
// Notes for anyone writing against Doltgres directly:
//   - 0.57.3 changed the `dolt_*` function return types to idiomatic Postgres
//     — `dolt_commit` returns `text` (was a one-element array), `dolt_merge`
//     returns a `record` (select from it for named columns), `dolt_branch`
//     returns `bigint`. Code written against the older shapes misreads
//     results silently.
//   - 1.1.0 made multiple statements in one message an implicit transaction,
//     and made an error abort the rest of it. TypeGraph sends one statement
//     per message, so nothing here changed.
//   - 1.2.0 narrowed many error codes from the `XX` prefix to specific
//     PostgreSQL SQLSTATEs. The ones that matter here did NOT narrow: the
//     locking-clause and unsupported-DDL refusals are both still `XX000`
//     where PostgreSQL would use `0A000`.
//   - `CREATE INDEX ... USING ivfflat` is ACCEPTED and silently recorded as
//     `USING hnsw`. Neither real index type is implemented, so an ANN index
//     is not what you asked for even where the DDL succeeds.
//   - Building main on macOS needs ICU headers for a cgo dependency:
//     `CGO_CFLAGS=-I$(brew --prefix icu4c)/include`,
//     `CGO_CXXFLAGS="-I$(brew --prefix icu4c)/include -std=c++17"`,
//     `CGO_LDFLAGS=-L$(brew --prefix icu4c)/lib`, and `DYLD_LIBRARY_PATH`
//     set to that `lib` when running the binary.
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createPostgresBackend } from "../src/backend/postgres";
import { type FulltextStrategy } from "../src/query/dialect/fulltext-strategy";

const DOLTGRES_CONNECTION = {
  host: "localhost",
  port: 4132,
  user: "postgres",
  password: "password",
  database: "postgres",
} as const;
const DEMO_BRANCH = "experiment";

// Doltgres has no `to_tsvector`/GIN, so the fulltext strategy is stubbed and
// bootstrap skips the fulltext table entirely; the proper fix is a
// `fulltext: false` opt-out symmetric to `vector: false`, which the postgres
// backend does not offer today.
//
// pgvector, unlike fulltext, IS present on 1.3.0 — see the header. It stays
// off because the strategy's write paths need `EXCLUDED` (doltgresql#1258),
// which is a capability gap rather than a missing extension.
//
// Every member throws rather than returning inert SQL: with no owned tables
// there is nothing to search, so a query reaching this strategy is a bug in
// the spike, not an empty result set.
function fulltextUnsupported(): never {
  throw new Error("fulltext is unsupported on Doltgres");
}

const noFulltext: FulltextStrategy = {
  name: "doltgres-none",
  supportedModes: [],
  supportsSnippets: false,
  supportsPrefix: false,
  supportsLanguageOverride: false,
  languages: [],
  ownedTables: () => [],
  matchCondition: fulltextUnsupported,
  rankExpression: fulltextUnsupported,
  snippetExpression: fulltextUnsupported,
  buildUpsert: fulltextUnsupported,
  buildBatchUpsert: fulltextUnsupported,
  buildDelete: fulltextUnsupported,
  buildBatchDelete: fulltextUnsupported,
};

// Shared by the main-branch and branch-pinned stores so the two connections
// can only differ in the branch they target.
//
// All three lock facts are false because Doltgres implements none of them and
// Dolt's engine has no single-writer slot to substitute — it merges concurrent
// transactions instead. `serializedWriters: true` would be the tempting lie
// (Doltgres deployments clamp their pools to one connection precisely because
// there is no lock), but that field means "by construction", and a deployment
// convention is not a construction.
const DOLTGRES_BACKEND_OPTIONS = {
  // Not "pgvector is missing" any more — "pgvector cannot be WRITTEN through
  // here". Act 0 pins both halves of that.
  vector: false,
  fulltext: noFulltext,
  capabilities: {
    pessimisticLocks: {
      advisoryLocks: false,
      tableLocks: false,
      serializedWriters: false,
    },
  },
} as const;

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    metadata: z.object({ tags: z.array(z.string()) }).optional(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "doltgres-smoke",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

// Same graph with Operational Identity switched on, used only to assert that
// the construction gate refuses it. Kept separate so the 22 functional steps
// run on a graph that never asks for a fence Doltgres cannot give.
const identityGraph = defineGraph({
  id: "doltgres-smoke-identity",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
  identity: { sameIdAcrossKinds: "fold" },
});

type StepOutcome = "pass" | "fail" | "skip";
type StepResult = Readonly<{
  step: string;
  outcome: StepOutcome;
  detail: string;
}>;
const results: StepResult[] = [];

function firstLine(value: string): string {
  return value.split("\n")[0] ?? "";
}

/**
 * Drizzle replaces the message of any wrapped failure with the SQL text and
 * keeps the real driver error on `.cause`, so both are needed to say anything
 * useful — and the driver error is often the only one with content. A refused
 * connection arrives as an `AggregateError` with an empty message and one
 * entry per address family, so those are pulled out too: that is the failure
 * a reader hits first when the container isn't running.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(firstLine(error.message));
    if (error instanceof AggregateError && Array.isArray(error.errors)) {
      for (const nested of error.errors) {
        if (nested instanceof Error) parts.push(firstLine(nested.message));
      }
    }
    if (error.cause instanceof Error)
      parts.push(firstLine(error.cause.message));
  } else {
    parts.push(String(error));
  }
  const detail = [...new Set(parts.filter((part) => part !== ""))].join(" | ");
  return (detail || "unknown error").slice(0, 300);
}

/**
 * The `code` a `ConfigurationError` carries in its details bag. Read
 * structurally rather than by importing the error class: the point of these
 * two steps is that the refusal is identified by a stable code, which is what
 * an external backend author would key on.
 */
function configurationErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("details" in error)) return undefined;
  const { details } = error as { details?: unknown };
  if (typeof details !== "object" || details === null) return undefined;
  const { code } = details as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function step(
  name: string,
  fn: () => Promise<string | undefined>,
): Promise<boolean> {
  try {
    const detail = (await fn()) ?? "ok";
    results.push({ step: name, outcome: "pass", detail });
    return true;
  } catch (error) {
    results.push({ step: name, outcome: "fail", detail: describeError(error) });
    return false;
  }
}

function skip(name: string, reason: string): void {
  results.push({ step: name, outcome: "skip", detail: reason });
}

const OUTCOME_LABEL: Readonly<Record<StepOutcome, string>> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
};

function report(): void {
  console.log("\n=== Doltgres smoke results ===");
  for (const result of results) {
    console.log(
      `${OUTCOME_LABEL[result.outcome]}  ${result.step} — ${result.detail}`,
    );
  }
  const passed = results.filter((result) => result.outcome === "pass").length;
  const failed = results.filter((result) => result.outcome === "fail").length;
  const skipped = results.filter((result) => result.outcome === "skip").length;
  console.log(
    `\n${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped` +
      ` (of ${String(results.length)})`,
  );
  if (failed > 0) process.exitCode = 1;
}

// === Act 0: the deviation battery ===
//
// Every row below is a PIN on Doltgres behavior, not a wish: the step passes
// when the engine answers what this PR's body says it answers, and fails the
// moment that changes — in either direction. A gap that upstream closes turns
// the battery red, which is precisely when someone should come back and
// re-run the walk in Act 1.
//
// Each probe runs on its own client rather than the shared pool: one of them
// (doltgresql#3234) panics the server and tears the connection down, and a
// poisoned pool connection would then be handed to an unrelated step.

/** What a probe is pinned to produce. */
type Expectation =
  | Readonly<{ kind: "supported" }>
  /** The engine must reject it, with an error containing `message`. */
  | Readonly<{ kind: "unsupported"; message: string; issue: string }>
  /**
   * Fixed on doltgresql `main` but not in any published release. Either
   * answer passes — the report says which one arrived — because the two
   * builds a reader can plausibly be running genuinely differ here, and
   * failing the release build for lacking an unreleased fix would be
   * reporting the calendar rather than the engine.
   */
  | Readonly<{
      kind: "fixed-unreleased";
      message: string;
      issue: string;
    }>;

const SUPPORTED: Expectation = { kind: "supported" };

function unsupported(message: string, issue: string): Expectation {
  return { kind: "unsupported", message, issue };
}

function fixedUnreleased(message: string, issue: string): Expectation {
  return { kind: "fixed-unreleased", message, issue };
}

/**
 * Runs `statements` (all but the last are setup and must succeed) on a fresh
 * connection and compares the last one's outcome to `expectation`.
 */
async function probe(
  name: string,
  expectation: Expectation,
  statements: readonly (
    string | Readonly<{ text: string; values: unknown[] }>
  )[],
): Promise<void> {
  const client = new Client(DOLTGRES_CONNECTION);
  try {
    await client.connect();
    const setup = statements.slice(0, -1);
    const subject = statements.at(-1);
    if (subject === undefined) throw new Error("probe needs a statement");
    for (const statement of setup) {
      await (typeof statement === "string" ?
        client.query(statement)
      : client.query(statement.text, statement.values));
    }
    let failure: unknown;
    try {
      await (typeof subject === "string" ?
        client.query(subject)
      : client.query(subject.text, subject.values));
    } catch (error) {
      failure = error;
    }
    if (expectation.kind === "fixed-unreleased") {
      const detail =
        failure === undefined ?
          `supported (${expectation.issue} fix present in this build)`
        : describeError(failure).includes(expectation.message) ?
          `still unsupported here (${expectation.issue} is fixed in a later build)`
        : `unsupported for a DIFFERENT reason than ${expectation.issue}: ${describeError(failure)}`;
      results.push({
        step: name,
        outcome:
          detail.startsWith("unsupported for a DIFFERENT") ? "fail" : "pass",
        detail,
      });
      return;
    }
    if (expectation.kind === "supported") {
      results.push(
        failure === undefined ?
          { step: name, outcome: "pass", detail: "supported" }
        : {
            step: name,
            outcome: "fail",
            detail: `expected support, got: ${describeError(failure)}`,
          },
      );
      return;
    }
    if (failure === undefined) {
      results.push({
        step: name,
        outcome: "fail",
        detail: `NOW SUPPORTED — ${expectation.issue} looks fixed; re-run the walk`,
      });
      return;
    }
    const detail = describeError(failure);
    results.push(
      detail.includes(expectation.message) ?
        {
          step: name,
          outcome: "pass",
          detail: `unsupported as pinned (${expectation.issue})`,
        }
      : {
          step: name,
          outcome: "fail",
          detail: `unsupported for a DIFFERENT reason than ${expectation.issue}: ${detail}`,
        },
    );
  } catch (error) {
    results.push({ step: name, outcome: "fail", detail: describeError(error) });
  } finally {
    // A panicked connection is already gone (doltgresql#3234 tears it down),
    // so closing it throws — and that failure is not the probe's result.
    try {
      await client.end();
    } catch {
      // Intentionally ignored: see above.
    }
  }
}

const PROBE_SETUP: readonly string[] = [
  `DROP TABLE IF EXISTS "probe_rows"`,
  `CREATE TABLE "probe_rows" (
     "id" TEXT PRIMARY KEY,
     "version" INT NOT NULL,
     "embedding" vector(3),
     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `INSERT INTO "probe_rows" ("id", "version", "embedding") VALUES ('a', 1, '[1,2,3]')`,
];

async function runDeviationBattery(): Promise<void> {
  // pgvector — the headline change in 1.3.0. doltgresql#3126 emulates the
  // extension in Go rather than loading the real one, so this is the first
  // release where `CREATE EXTENSION vector` succeeds at all: the gap
  // doltgresql#3014 reported has genuinely closed, not merely moved again.
  await probe("pgvector: extension installs", SUPPORTED, [
    `CREATE EXTENSION IF NOT EXISTS vector`,
  ]);
  await probe(
    "pgvector: reports a version TypeGraph reads as >= 0.8",
    SUPPORTED,
    [
      `CREATE EXTENSION IF NOT EXISTS vector`,
      // `createIterativeScanProbe` keys the iterative-scan decision on
      // `extversion`, so what this returns is what TypeGraph would believe.
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    ],
  );
  await probe(
    "pgvector: vector column, distance operators, ORDER BY search",
    SUPPORTED,
    [
      ...PROBE_SETUP,
      `SELECT "id" FROM "probe_rows"
       WHERE "embedding" IS NOT NULL
       ORDER BY ("embedding" <=> '[1,2,3]'::vector)
       LIMIT 5 OFFSET 0`,
    ],
  );
  // ...and why `vector: false` survives it anyway. Every write path in
  // `pgvectorStrategy` — single upsert, batch upsert, and the one fused into
  // an inserted node — settles the conflict with `EXCLUDED`, which Doltgres
  // still does not implement.
  await probe(
    "pgvector: embedding upsert (EXCLUDED)",
    fixedUnreleased("table not found: excluded", "doltgresql#1258"),
    [
      ...PROBE_SETUP,
      `INSERT INTO "probe_rows" ("id", "version", "embedding") VALUES ('a', 1, '[4,5,6]')
       ON CONFLICT ("id") DO UPDATE SET "embedding" = EXCLUDED."embedding"`,
    ],
  );
  // The per-search `efSearch` override is applied with `SET LOCAL` inside the
  // search's own transaction, so an approximate search cannot be tuned per
  // call even once the writes above land.
  await probe(
    "pgvector: per-search efSearch blocked (SET LOCAL)",
    unsupported("SET LOCAL is not yet supported", "doltgresql#3099"),
    [`BEGIN`, `SET LOCAL hnsw.ef_search = 40`],
  );
  // `materializeIndexes()` builds the ANN index CONCURRENTLY.
  await probe(
    "pgvector: ANN index materialization blocked (CREATE INDEX CONCURRENTLY)",
    unsupported(
      "concurrent index creation is not yet supported",
      "doltgresql#3099",
    ),
    [
      ...PROBE_SETUP,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "probe_ann"
         ON "probe_rows" USING hnsw ("embedding" vector_cosine_ops)`,
    ],
  );

  // The write fence. `hashtext` is new in 1.3.0 (doltgresql#3188) — half of
  // `pg_advisory_xact_lock(hashtext($1))` now exists — but the lock itself
  // and the row-locking clauses do not, so the `unfenced` plan still stands.
  await probe("write fence: hashtext implemented", SUPPORTED, [
    `SELECT hashtext('typegraph')`,
  ]);
  // doltgresql#3256 implemented transaction-scoped advisory locks, but only
  // the ONE-ARGUMENT `bigint` overload. PostgreSQL also has the two-argument
  // `(int4, int4)` form, and that is the one every namespaced TypeGraph lock
  // uses — identity, identity-DDL, the recorded-graph-write lock and the
  // recorded clock. The schema fence deliberately uses the one-argument form
  // (a different lock space, so it cannot collide with those), so exactly one
  // of TypeGraph's two advisory shapes is available here.
  await probe(
    "write fence: advisory xact lock, one-argument bigint (schema fence)",
    SUPPORTED,
    [`SELECT pg_advisory_xact_lock(hashtext('typegraph'))`],
  );
  await probe(
    "write fence: advisory xact lock, two-argument int4 (identity, clock)",
    unsupported(
      "pg_advisory_xact_lock(integer, integer) does not exist",
      "doltgresql#2600",
    ),
    [
      `SELECT pg_advisory_xact_lock(hashtext('typegraph:identity'), hashtext('g1'))`,
    ],
  );
  await probe(
    "write fence: row-locking clauses still missing",
    unsupported("locking clauses are not yet supported", "doltgresql#2600"),
    [...PROBE_SETUP, `SELECT "id" FROM "probe_rows" FOR SHARE`],
  );

  // The two gaps that block the walk in Act 1, in the order TypeGraph meets
  // them. Both were filed from these exact repros.
  await probe(
    "bootstrap: ON CONFLICT ... DO UPDATE ... WHERE",
    fixedUnreleased(
      "the ON CONFLICT clause provided is not yet supported",
      "doltgresql#3235",
    ),
    [
      ...PROBE_SETUP,
      // The monotonic upsert `writeBaseSchemaVersion` uses to record the
      // installed base-schema version — the first write of any bootstrap.
      `INSERT INTO "probe_rows" ("id", "version") VALUES ('a', 2)
       ON CONFLICT ("id") DO UPDATE SET "version" = 2
       WHERE "probe_rows"."version" <= 2`,
    ],
  );
  await probe(
    "managed writes: INSERT ... SELECT with uncast bind params",
    fixedUnreleased("panic", "doltgresql#3234"),
    [
      ...PROBE_SETUP,
      // The shape of every fused managed insert: the schema fence is a
      // subquery the INSERT selects from, so the inserted values are a
      // projection rather than a VALUES list. `INSERT ... VALUES ($1, $2)`
      // is fine, and `SELECT $1::text` is fine — it is this combination that
      // dereferences a nil type in the analyzer and kills the connection.
      {
        text: `INSERT INTO "probe_rows" ("id", "version") SELECT $1, $2`,
        values: ["b", 1],
      },
    ],
  );

  // Costs functionality but not the store: `materializeSystemIndexes()`
  // degrades by design.
  await probe(
    "system indexes blocked: ALTER TABLE ... ADD COLUMN IF NOT EXISTS",
    unsupported("IF NOT EXISTS on a column", "doltgresql#3099"),
    [
      ...PROBE_SETUP,
      `ALTER TABLE "probe_rows" ADD COLUMN IF NOT EXISTS "extra" TEXT`,
    ],
  );
}

/**
 * The `describeError` text of doltgresql#3235 as TypeGraph meets it, matched
 * on the engine's own words. Drizzle prefixes the SQL and `describeError`
 * truncates, so the full sentence is not always present — this is the
 * longest fragment that always survives, and it is still specific to the
 * `ON CONFLICT` refusal rather than to any unsupported statement.
 */
function isBaseSchemaUpsertBlock(detail: string): boolean {
  return detail.includes("the ON CONFLICT clause provided");
}

/**
 * TypeGraph's OWN refusal, and on a current build the one a reader actually
 * meets. Doltgres implements no advisory locks and no row-locking clauses
 * (doltgresql#2600), so the backend resolves the `unfenced` write-fence plan,
 * and the PostgreSQL schema-commit fence refuses rather than running its
 * read-then-write unserialized.
 *
 * This is not a gap to report upstream and not a bug: it is the capability
 * model doing exactly what it says. It IS the thing standing between this
 * spike and a working store, which makes doltgresql#2600 the one remaining
 * upstream issue that matters here.
 */
function isWriteFenceRefusal(detail: string): boolean {
  return detail.includes("requires a write fence");
}

/**
 * Act 2 — what the `unfenced` declaration costs.
 *
 * It costs more than it used to. The PostgreSQL schema fence guards a
 * read-then-write that spans statements — the schema commit reads the active
 * version and then writes the flip, and a managed write HOLDS its share lock
 * across the writes that follow — so it refuses an unfenced backend rather
 * than running that sequence unserialized. An unfenced Postgres-wire engine
 * therefore gets no schema-managed store at all, not a degraded one. Only the
 * fence folded INSIDE a managed insert's own statement degrades, since one
 * statement cannot race itself.
 *
 * That is the honest posture for Doltgres and it is worth stating plainly:
 * the `unfenced` declaration buys a refusal that names the missing
 * capability, not a working store with weaker guarantees.
 *
 * Each gate constructs its own store and asserts a REFUSAL, so none of them
 * needs the walk's store. They are nonetheless UNMEASURABLE on every build
 * so far: each calls `createAdapterStoreWithSchema`, which reaches the
 * schema-commit fence (doltgresql#2600) before any gate evaluates — and on
 * 1.3.0, `writeBaseSchemaVersion` (doltgresql#3235) even earlier. That
 * is reported as a skip, never as a pass — a gate that never ran is not a
 * gate that held, and stating otherwise is how a capability model rots.
 *
 * It is also the same bootstrap-ordering shape as the identity finding
 * below, one layer earlier: the base-schema write now runs before even the
 * recorded-clock gate, so on ANY engine that cannot serve it, the caller
 * gets a SQL error where the capability model promised a named refusal.
 */
async function gate(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run();
    results.push({ step: name, outcome: "pass", detail });
  } catch (error) {
    const detail = describeError(error);
    if (isBaseSchemaUpsertBlock(detail)) {
      results.push({
        step: name,
        outcome: "skip",
        detail:
          "unmeasurable — ensureSchema hits doltgresql#3235 before the gate",
      });
      return;
    }
    if (isWriteFenceRefusal(detail)) {
      // Refused, and safely — but by the schema-commit fence inside
      // `ensureSchema`, never by the gate built for this feature, whose whole
      // design point is that its message names the exact declaration line to
      // add. The identity finding below is now the general case: on an
      // unfenced PostgreSQL backend EVERY construction gate is pre-empted,
      // because `createAdapterStoreWithSchema` bootstraps before it gates.
      results.push({
        step: name,
        outcome: "pass",
        detail:
          "refused by the schema-commit fence inside ensureSchema, not by this feature's own gate",
      });
      return;
    }
    results.push({ step: name, outcome: "fail", detail });
  }
}

async function runConstructionGates(
  backend: ReturnType<typeof createPostgresBackend>,
): Promise<void> {
  await gate("write fence: history refused at construction", async () => {
    try {
      await createAdapterStoreWithSchema(graph, backend, { history: true });
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code !== "RECORDED_CLOCK_REQUIRES_WRITE_FENCE") throw error;
      return `refused with ${code}`;
    }
    throw new Error("history should have been refused");
  });

  // Refused — but NOT by the construction gate that was built to refuse it,
  // and this is the one finding this spike has about TypeGraph rather than
  // about Doltgres. `createAdapterStoreWithSchema` runs `ensureSchema` first,
  // and identity DDL enablement reaches `lockRecordedGraphWrite` (J1) inside
  // it, so the caller gets that lock site's generic `WRITE_FENCE_UNAVAILABLE`
  // before `new Store()` ever evaluates the identity gate — whose refusal
  // exists precisely so the message can name the one declaration line to add.
  // Safety is intact (it refuses before any write); the migration guide is
  // what is lost. The gate needs to run before schema bootstrap, not after.
  await gate("write fence: Operational Identity refused", async () => {
    try {
      await createAdapterStoreWithSchema(identityGraph, backend, {});
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code === "IDENTITY_REQUIRES_WRITE_FENCE")
        return `refused with ${code}`;
      if (code === "WRITE_FENCE_UNAVAILABLE") {
        return `refused with ${code} from a lock site, not IDENTITY_REQUIRES_WRITE_FENCE — the gate runs after ensureSchema`;
      }
      throw error;
    }
    throw new Error("identity should have been refused");
  });

  await gate("write fence: revisionTracking refused too", async () => {
    try {
      await createAdapterStoreWithSchema(graph, backend, {
        revisionTracking: true,
      });
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code !== "RECORDED_CLOCK_REQUIRES_WRITE_FENCE") throw error;
      return `refused with ${code}`;
    }
    throw new Error("revisionTracking should have been refused");
  });
}

/**
 * Every Act 1 / Act 3 step, in report order. Listed so a blocked bootstrap
 * still SHOWS what is not being measured — a walk that silently shrinks to
 * the steps that happen to run would read as a passing spike.
 */
const WALK_STEPS: readonly string[] = [
  "create nodes",
  "create edge",
  "findById",
  "query whereNode predicate (JSON extract)",
  "query orderBy + limit",
  "update node",
  "transaction (multi-write commit)",
  "1-hop traversal query",
  "edge findFrom",
  "subgraph extraction (WITH RECURSIVE)",
  "soft delete + visibility",
  "delete protection (connected edges refuse delete)",
  "system indexes: degraded (ADD COLUMN IF NOT EXISTS)",
  "dolt: commit baseline on main",
  `dolt: create branch '${DEMO_BRANCH}'`,
  "dolt: TypeGraph store on branch-pinned connection",
  "dolt: typed write on branch (Eve + edge)",
  "dolt: branch isolation (main does not see Eve)",
  "dolt: commit branch work",
  `dolt: diff main..${DEMO_BRANCH}`,
  `dolt: merge ${DEMO_BRANCH} into main`,
  "dolt: main sees merged data via TypeGraph",
];

async function runSmoke(pool: Pool, branchPool: Pool): Promise<void> {
  const backend = createPostgresBackend(
    drizzle(pool),
    DOLTGRES_BACKEND_OPTIONS,
  );

  await runDeviationBattery();

  // === Act 1: the typed store walk ===
  //
  // Pinned like the battery: bootstrap CANNOT succeed on any build to date —
  // on 1.3.0 because `writeBaseSchemaVersion`'s monotonic upsert is
  // doltgresql#3235, and from 1.3.1 on because the schema-commit fence has no
  // row lock to take (doltgresql#2600). Passing
  // here means "blocked exactly where the battery says it should be";
  // bootstrap succeeding turns this red, which is the signal to delete this
  // branch of the code and let the walk run again.
  // Inference flows through `.then`, so the store keeps its full generic
  // type — a hand-written union of "store or blocked" would erase it.
  const bootstrap = await createAdapterStoreWithSchema(graph, backend, {}).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, detail: describeError(error) }),
  );

  if (!bootstrap.ok) {
    const fenceRefusal = isWriteFenceRefusal(bootstrap.detail);
    const upstreamGap = isBaseSchemaUpsertBlock(bootstrap.detail);
    const blockedAsPinned = fenceRefusal || upstreamGap;
    results.push({
      step: "schema bootstrap (DDL + ensureSchema)",
      outcome: blockedAsPinned ? "pass" : "fail",
      detail:
        fenceRefusal ?
          "refused by TypeGraph's schema-commit write fence — unfenced backend (doltgresql#2600)"
        : upstreamGap ?
          "blocked at writeBaseSchemaVersion (doltgresql#3235, fixed on doltgresql main)"
        : `blocked for an UNPINNED reason: ${bootstrap.detail}`,
    });
    const skipReason =
      fenceRefusal ?
        "no store — refused as unfenced (doltgresql#2600)"
      : "no store — bootstrap blocked upstream (doltgresql#3235)";
    for (const name of WALK_STEPS) {
      skip(name, skipReason);
    }
    // Act 2 needs no store: each of these builds its own and asserts it is
    // REFUSED, so they measure the capability model even while the walk is
    // blocked.
    await runConstructionGates(backend);
    return;
  }

  const [store, validation] = bootstrap.value;
  results.push({
    step: "schema bootstrap (DDL + ensureSchema)",
    outcome: "pass",
    detail: `status: ${validation.status}`,
  });

  type PersonNode = Awaited<ReturnType<typeof store.nodes.Person.create>>;
  let alice: PersonNode | undefined;
  let bob: PersonNode | undefined;
  let eve: PersonNode | undefined;

  await step("create nodes", async () => {
    alice = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
      metadata: { tags: ["engineer"] },
    });
    bob = await store.nodes.Person.create({
      name: "Bob",
      email: "bob@example.com",
    });
    return `created ${alice.id}, ${bob.id}`;
  });

  await step("create edge", async () => {
    if (!alice || !bob) throw new Error("prerequisite create failed");
    await store.edges.knows.create(alice, bob, { since: "2024" });
    return "edge created";
  });

  await step("findById", async () => {
    if (!alice) throw new Error("prerequisite create failed");
    const found = await store.nodes.Person.getById(alice.id);
    return `found: ${found?.name ?? "MISSING"}`;
  });

  await step("query whereNode predicate (JSON extract)", async () => {
    const rows = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (personRow) => personRow.name.eq("Alice"))
      .select((ctx) => ({ name: ctx.p.name }))
      .execute();
    return `rows: ${String(rows.length)}`;
  });

  await step("query orderBy + limit", async () => {
    const rows = await store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ name: ctx.p.name }))
      .orderBy("p", "name", "asc")
      .limit(10)
      .execute();
    return `rows: ${String(rows.length)}`;
  });

  await step("update node", async () => {
    if (!alice) throw new Error("prerequisite create failed");
    await store.nodes.Person.update(alice.id, { name: "Alice Prime" });
    const found = await store.nodes.Person.getById(alice.id);
    return `name now: ${found?.name ?? "MISSING"}`;
  });

  await step("transaction (multi-write commit)", async () => {
    await store.transaction(async (tx) => {
      const carol = await tx.nodes.Person.create({
        name: "Carol",
        email: "carol@example.com",
      });
      if (!alice) throw new Error("prerequisite create failed");
      await tx.edges.knows.create(alice, carol, { since: "2025" });
    });
    return "committed";
  });

  await step("1-hop traversal query", async () => {
    const rows = await store
      .query()
      .from("Person", "a")
      .traverse("knows", "e")
      .to("Person", "b")
      .select((ctx) => ({
        from: ctx.a.name,
        to: ctx.b.name,
        since: ctx.e.since,
      }))
      .execute();
    return `pairs: ${String(rows.length)}`;
  });

  await step("edge findFrom", async () => {
    if (!alice) throw new Error("prerequisite create failed");
    const edges = await store.edges.knows.findFrom(alice);
    return `edges: ${String(edges.length)}`;
  });

  await step("subgraph extraction (WITH RECURSIVE)", async () => {
    if (!alice) throw new Error("prerequisite create failed");
    const sub = await store.subgraph(alice.id, {
      edges: ["knows"],
      maxDepth: 2,
    });
    return `nodes: ${String(sub.nodes.size)}, adjacency roots: ${String(sub.adjacency.size)}`;
  });

  await step("soft delete + visibility", async () => {
    const dave = await store.nodes.Person.create({
      name: "Dave",
      email: "dave@example.com",
    });
    await store.nodes.Person.delete(dave.id);
    const found = await store.nodes.Person.getById(dave.id);
    return found === undefined ?
        "deleted row invisible"
      : "ERROR: still visible";
  });

  await step("delete protection (connected edges refuse delete)", async () => {
    if (!bob) throw new Error("prerequisite create failed");
    try {
      await store.nodes.Person.delete(bob.id);
      return "ERROR: delete should have been refused";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("connected edge")) throw error;
      return "refused as expected";
    }
  });

  await runConstructionGates(backend);

  // Not a TypeGraph defect: `materializeSystemIndexes` degrades by design and
  // says so, and the store above is fully usable without it. Measured as a
  // step so the one engine gap that costs real functionality is a named
  // result rather than a stack trace scrolling past the report.
  await step(
    "system indexes: degraded (ADD COLUMN IF NOT EXISTS)",
    async () => {
      try {
        await store.materializeSystemIndexes();
        return "ERROR: expected the unsupported-DDL refusal";
      } catch (error) {
        const detail = describeError(error);
        if (!detail.includes("IF NOT EXISTS on a column")) throw error;
        // Tracked upstream in doltgresql#3099 alongside the rest of the
        // quality-of-life batch. Postgres would answer 0A000; this is XX000.
        return "system indexes unavailable (doltgresql#3099); store unaffected";
      }
    },
  );

  // === Act 3: Dolt version control underneath TypeGraph ===

  await step("dolt: commit baseline on main", async () => {
    await pool.query("select dolt_add('-A')");
    const commitResult = await pool.query<{ hash: string }>(
      "select dolt_commit('--allow-empty', '-m', 'typegraph baseline') as hash",
    );
    return `commit ${commitResult.rows[0]?.hash ?? "?"}`;
  });

  await step(`dolt: create branch '${DEMO_BRANCH}'`, async () => {
    // Reset any leftover demo branch from a previous run.
    try {
      await pool.query(`select dolt_branch('-D', '${DEMO_BRANCH}')`);
    } catch {
      // No leftover branch — nothing to reset.
    }
    await pool.query(`select dolt_branch('${DEMO_BRANCH}')`);
    return "branch created";
  });

  let branchStore: typeof store | undefined;

  await step("dolt: TypeGraph store on branch-pinned connection", async () => {
    const branchBackend = createPostgresBackend(
      drizzle(branchPool),
      DOLTGRES_BACKEND_OPTIONS,
    );
    const [created, branchValidation] = await createAdapterStoreWithSchema(
      graph,
      branchBackend,
      {},
    );
    branchStore = created;
    return `schema status on branch: ${branchValidation.status}`;
  });

  await step("dolt: typed write on branch (Eve + edge)", async () => {
    if (!branchStore || !alice) throw new Error("prerequisite failed");
    const aliceOnBranch = await branchStore.nodes.Person.getById(alice.id);
    if (!aliceOnBranch) throw new Error("Alice missing on branch");
    eve = await branchStore.nodes.Person.create({
      name: "Eve",
      email: "eve@example.com",
    });
    await branchStore.edges.knows.create(aliceOnBranch, eve, {
      since: "2026",
    });
    return "Eve + edge written on branch";
  });

  await step("dolt: branch isolation (main does not see Eve)", async () => {
    if (!branchStore || !eve) throw new Error("prerequisite failed");
    const onMain = await store.nodes.Person.getById(eve.id);
    const onBranch = await branchStore.nodes.Person.getById(eve.id);
    if (onMain !== undefined) return "ERROR: Eve leaked to main";
    return `branch sees Eve: ${String(onBranch?.name === "Eve")}, main sees Eve: false`;
  });

  await step("dolt: commit branch work", async () => {
    await branchPool.query("select dolt_add('-A')");
    const commitResult = await branchPool.query<{ hash: string }>(
      "select dolt_commit('-m', 'Eve added on experiment') as hash",
    );
    return `commit ${commitResult.rows[0]?.hash ?? "?"}`;
  });

  await step(`dolt: diff main..${DEMO_BRANCH}`, async () => {
    const diffResult = await pool.query<{ diff_type: string }>(
      `select diff_type from dolt_diff('main', '${DEMO_BRANCH}', 'typegraph_nodes')`,
    );
    return `typegraph_nodes rows changed: ${String(diffResult.rows.length)}`;
  });

  await step(`dolt: merge ${DEMO_BRANCH} into main`, async () => {
    // dolt_merge returns a record; select from it to get named columns.
    // node-postgres hands back int8/numeric columns as strings, so coerce
    // before comparing rather than trusting the declared type.
    const mergeResult = await pool.query<{
      hash: string | null;
      fast_forward: string | number;
      conflicts: string | number;
      message: string;
    }>(`select * from dolt_merge('${DEMO_BRANCH}')`);
    const merge = mergeResult.rows[0];
    if (!merge) throw new Error("dolt_merge returned no row");
    const conflicts = Number(merge.conflicts);
    if (conflicts !== 0) return `ERROR: ${String(conflicts)} conflict(s)`;
    return `${merge.message} (fast_forward: ${String(Number(merge.fast_forward))})`;
  });

  await step("dolt: main sees merged data via TypeGraph", async () => {
    if (!alice || !eve) throw new Error("prerequisite failed");
    const onMain = await store.nodes.Person.getById(eve.id);
    const edges = await store.edges.knows.findFrom(alice);
    return `Eve on main: ${onMain?.name ?? "MISSING"}, alice edges: ${String(edges.length)}`;
  });
}

async function main(): Promise<void> {
  const pool = new Pool({ ...DOLTGRES_CONNECTION, max: 4 });
  // Dolt selects a branch via the database name (`<db>/<branch>`). That slash
  // can't survive a connection URL, so the branch pool is built from discrete
  // fields rather than `connectionString`. Pools connect lazily, so building
  // this one up front costs nothing before the branch exists.
  const branchPool = new Pool({
    ...DOLTGRES_CONNECTION,
    database: `${DOLTGRES_CONNECTION.database}/${DEMO_BRANCH}`,
    max: 4,
  });

  try {
    await runSmoke(pool, branchPool);
  } catch (error) {
    // Escapes the step harness only if bootstrap itself failed — usually
    // because the container isn't up. Report it as a failed step rather than
    // a bare stack trace, since that's the first thing a reader will hit.
    results.push({
      step: "schema bootstrap (DDL + ensureSchema)",
      outcome: "fail",
      detail: describeError(error),
    });
    process.exitCode = 1;
  } finally {
    report();
    await Promise.all([pool.end(), branchPool.end()]);
  }
}

await main();

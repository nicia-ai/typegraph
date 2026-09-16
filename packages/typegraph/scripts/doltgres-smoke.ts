// Doltgres spike smoke test — run: pnpm smoke:doltgres
// Requires a Doltgres on localhost:4132. Either works:
//   docker run -d -p 4132:5432 -e POSTGRES_PASSWORD=password dolthub/doltgresql:1.3.3   (latest release)
//   a build of doltgresql main                                                           (see below)
// Not wired into CI: it needs that server, and the spike is exploratory.
//
// Measured 2026-09-16 against BOTH the 1.3.3 release and a build of doltgresql main at
// 734e58b. For the first time the two builds DIVERGE through this battery, and the
// divergence is the story: everything the latest release fixed is released, but the one
// remaining blocker for the typed walk is fixed only on main.
//
// TypeGraph main itself moved under this spike, and moved far. The write-fence model is
// no longer the `pessimisticLocks` triple this file used to declare. It is now
// `capabilities.writeFence`, a single declaration whose `mechanism` is one of
// `"advisory"` (a keyed `pg_advisory_xact_lock`), `"row"` (TypeGraph's own keyed
// exclusion against a fences relation — the mechanism added precisely for an engine with
// no advisory-lock primitive), `"engine-serialized"` (SQLite), or `"caller-serialized"`
// (a deployment promise: this process serializes every write unit it issues and no other
// client writes to the database while the backend is open). `fulltext: false` now exists
// too, so the hand-rolled stub strategy this file used to carry is gone.
//
// THE HEADLINE: 1.3.3 IS BLOCKED AT THE FIRST EDGE WRITE, MAIN IS NOT.
//
// With 1.3.3, the walk bootstraps (1.3.1's fixes for `ON CONFLICT ... DO UPDATE ...
// WHERE` and `INSERT ... SELECT $1` are published, and the capability model now offers a
// fence that a store can construct under), and then dies on the first edge insert:
//
//   operator does not exist: boolean = text
//
// That is doltgresql#3324, and TypeGraph's own DDL triggers it. The bundled Postgres
// schema carries a match-identity CHECK constraint, spelled with explicit grouping:
//
//   CHECK (("match_identity_name" IS NULL) = ("match_identity_key" IS NULL))
//
// Doltgres parses `a IS NULL = b IS NULL` with the wrong precedence, reading the `=` first
// and comparing a `boolean` to `text`. The bracket-dropping defect means even the
// parenthesized form is stored without its grouping, so the CHECK refuses every row on
// 1.3.3. `(a IS NULL AND b IS NULL) OR (a IS NOT NULL AND b IS NOT NULL)` works, but that
// is TypeGraph's DDL to change, not this spike's.
//
// doltgresql#3324 was filed 2026-09-11 and closed 2026-09-16T09:06:54Z by PR #3348 —
// after 1.3.3 was cut. Built main at 734e58b and the constraint round-trips intact:
// `CHECK ("a" IS NULL) = ("b" IS NULL)` is stored with its brackets, and the inserts
// behave. With that, `createAdapterStoreWithSchema` bootstraps and the full typed walk
// runs — schema, CRUD, transactions, JSON predicates, traversal, WITH RECURSIVE subgraph
// extraction, soft delete, system indexes, then commit, branch, branch-pinned writes,
// branch isolation, dolt_diff and dolt_merge back to main, all through the typed API.
// This is the first build on which any of that executes. Two steps are still skipped for
// engine gaps the walk surfaces for the first time (see below): ascending `ORDER BY` and
// the connected-edge delete diagnosis.
//
// BUT A RUNNING STORE IS NOT A FENCED STORE, AND THE DIFFERENCE IS PINNED.
//
// The walk runs under `writeFence: { mechanism: "row", drain: "none", conflict: "wait" }`
// because it is the mechanism TypeGraph added for an engine without advisory locks. Its
// keyed exclusion is an UPSERT against the fences relation:
//
//   INSERT INTO typegraph_fences (key, generation) VALUES ($1, 1)
//   ON CONFLICT (key) DO UPDATE SET generation = typegraph_fences.generation + 1
//   RETURNING generation
//
// Doltgres ACCEPTS that statement and does not enforce it. Two concurrent acquirers of
// the same key both return generation `1` and the final row reads `1`: Dolt's engine
// merges concurrent transactions rather than serializing them, and `ON CONFLICT DO
// UPDATE` neither waits (so `conflict: "wait"` is a false claim) nor fails the loser at
// commit (so `conflict: "commit-time"` is false too — nothing is ever detected to retry).
// The battery's race probe is a PIN on that: it passes while Doltgres provides no
// exclusion, and turns red the day upstream implements one.
//
// So the honest posture is unchanged from the last revision, only sharper: TypeGraph now
// RUNS on Doltgres, but the engine still cannot FENCE it. `caller-serialized` is the one
// declaration whose exclusion TypeGraph actually enforces (an in-process queue), and it
// too is a promise about the deployment, not a fact about Doltgres — a promise this
// battery's branch-pinned second backend would itself violate if both wrote at once.
//
// THE DECLARATION MATRIX (Act 1) measures every posture. On main:
//
//   - omitted (bundled advisory + table-lock) — dies at `SELECT ... FOR UPDATE`
//   - `writeFence: undefined`                 — refused at construction, typed code
//   - `advisory`                              — dies at `SELECT ... FOR UPDATE`
//   - `row` / `"wait"` or `"commit-time"`     — constructs and walks, UNSOUND
//   - `caller-serialized`                     — constructs and walks, sound in-process
//
// On 1.3.3 the three constructible postures all die at the edge write above; the two
// advisory postures die at `FOR UPDATE` first. That is the build divergence.
//
// WHAT STILL BLOCKS A HONEST STORE IS doltgresql#2600.
//
// `FOR UPDATE` / `FOR SHARE`, `LOCK TABLE`, and the two-argument
// `pg_advisory_xact_lock(int4, int4)` are all still missing. #2600 remains open, narrowed
// by 1.3.1's `pg_advisory_xact_lock(bigint)` to exactly those. The schema-commit fence
// takes the row lock first, so the advisory arity gap stays unobservable through the
// store path until the row-lock half lands.
//
// Identity is a separate casualty of the same gap: constructing an identity graph under
// `row`/`drain: "none"` refuses with `WRITE_FENCE_UNAVAILABLE` ("identity enablement drain
// requires a table lock"), because identity DDL is a table-lock drain site — and
// `drain: "table-lock"` would only get as far as the `LOCK TABLE` that Doltgres cannot
// parse. `history` and `revisionTracking` construct and run, since a keyed lock is all
// they need.
//
// WHAT ELSE 1.3.3 CHANGED, AND WHAT DID NOT.
//
// Newly released since the last revision:
//   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` WORKS. It was the last named system-index
//     gap; `store.materializeSystemIndexes()` now succeeds, and the battery pins it.
//   - `ON CONFLICT ... DO UPDATE ... WHERE` (#3235), `INSERT ... SELECT` with uncast bind
//     params (#3234) and the `excluded` alias (#1258) are all published in 1.3.1 and hold
//     in 1.3.3 — all three previously pinned `fixed-unreleased`.
//
// Still missing, and what each costs:
//   - #2600 — THE blocker; costs a sound store. Row locks, `LOCK TABLE`, and the
//     two-argument advisory form.
//   - #3335 — `to_tsvector`/`to_tsquery` and `@@`: costs fulltext.
//   - #3099 — `SET LOCAL`: costs the per-search `efSearch` override.
//   - `CREATE INDEX CONCURRENTLY` (#3099): costs ANN index materialization. Worth knowing
//     separately: `CREATE INDEX ... USING ivfflat` is accepted and silently recorded as
//     `USING hnsw`; neither real index type is implemented, so an ANN index is not what
//     you asked for even where the DDL would succeed.
//
// Two more gaps turn up only once the walk runs, both unfiled upstream at the time of
// writing, and both pinned by the walk as SKIP rather than PASS:
//
//   - `ORDER BY ... ASC NULLS LAST` is rejected with "at or near \"last\": syntax error:
//     unimplemented". `DESC NULLS LAST` and bare `NULLS FIRST` both parse; only the
//     explicit-`ASC` form is broken. TypeGraph emits it for every ascending order, so no
//     ordered query runs.
//   - SQLSTATE 23502 omits the `table`, `column` and `constraint` protocol fields. The
//     guarded delete fires correctly — it is the raw NOT NULL sentinel that refuses the
//     write — but `isNotNullColumnViolation` keys on those fields, so it cannot classify
//     the refusal and the raw engine error surfaces instead of the typed connected-edge
//     refusal. Correctness is intact; the diagnosis is what is lost.
//
// A run on main therefore reports 48 passed, 0 failed, 2 skipped; on 1.3.3, 27 passed,
// 0 failed, 23 skipped (the walk is reported step-by-step as skipped, never dropped).
//
// pgvector is real and read-side works: `CREATE EXTENSION vector` reports extversion
// 0.8.6, `vector(N)` columns, `<=>`/`<->`/`<#>` and `ORDER BY <distance> LIMIT` all work,
// and with #1258 fixed the embedding upsert works too. `vector: false` stays for the two
// capability reasons above, not for the extension.
//
// Notes for anyone writing against Doltgres directly:
//   - 0.57.3 changed the `dolt_*` function return types to idiomatic Postgres —
//     `dolt_commit` returns `text`, `dolt_merge` returns a `record`, `dolt_branch`
//     returns `bigint`. Code written against the older array shapes misreads results.
//   - 1.1.0 made multiple statements in one message an implicit transaction and made an
//     error abort the rest of it. TypeGraph sends one statement per message, so nothing
//     here changed.
//   - 1.2.0 narrowed many error codes off the `XX` prefix. The ones that matter here did
//     NOT narrow: the locking-clause and unsupported-DDL refusals are both still `XX000`
//     where PostgreSQL would use `0A000`.
//   - Building main on macOS needs ICU headers for a cgo dependency:
//     `CGO_CFLAGS=-I$(brew --prefix icu4c)/include`,
//     `CGO_CXXFLAGS="-I$(brew --prefix icu4c)/include -std=c++17"`,
//     `CGO_LDFLAGS=-L$(brew --prefix icu4c)/lib`, and `DYLD_LIBRARY_PATH` set to that
//     `lib` when running the binary.
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { type WriteFenceDeclaration } from "../src/backend";
import { createPostgresBackend } from "../src/backend/postgres";

const DOLTGRES_CONNECTION = {
  host: "localhost",
  port: 4132,
  user: "postgres",
  password: "password",
  database: "postgres",
} as const;
const DEMO_BRANCH = "experiment";

// The walk's declaration. `row` is TypeGraph's mechanism for an engine with no advisory
// lock, so it is the honest thing to reach for here — but see the header and the race
// probe: Doltgres accepts the fence-row UPSERT and does not enforce it. `caller-serialized`
// is the only declaration whose exclusion TypeGraph actually enforces; it is measured in
// the matrix rather than run here because the branch-pinned second backend would violate
// its promise.
const DOLTGRES_BACKEND_OPTIONS = {
  vector: false,
  // No `to_tsvector` and no GIN (doltgresql#3335), so fulltext is off. `fulltext: false`
  // is now a bundled option, symmetric to `vector: false`.
  fulltext: false,
  capabilities: {
    writeFence: {
      mechanism: "row",
      drain: "none",
      conflict: "wait",
    },
  },
} as const satisfies Parameters<typeof createPostgresBackend>[1];

// The declarations the matrix measures, in the order it reports them. `writeFence:
// undefined` is a deliberate own-property that overwrites the bundled factory's advisory
// default, producing the "declares no usable write fence" refusal; `{}` leaves the default
// in place. `undefined` is typed explicitly because the override bag is `Partial`.
type Posture = Readonly<{
  label: string;
  capabilities: {
    writeFence?: WriteFenceDeclaration | undefined;
  };
}>;

const POSTURES: readonly Posture[] = [
  {
    label: "omitted (bundled advisory + table-lock)",
    capabilities: {},
  },
  {
    label: "writeFence: undefined",
    capabilities: { writeFence: undefined },
  },
  {
    label: 'advisory / drain "none"',
    capabilities: { writeFence: { mechanism: "advisory", drain: "none" } },
  },
  {
    label: 'row / drain "none" / conflict "wait"',
    capabilities: {
      writeFence: { mechanism: "row", drain: "none", conflict: "wait" },
    },
  },
  {
    label: 'row / drain "none" / conflict "commit-time"',
    capabilities: {
      writeFence: {
        mechanism: "row",
        drain: "none",
        conflict: "commit-time",
      },
    },
  },
  {
    label: "caller-serialized",
    capabilities: { writeFence: { mechanism: "caller-serialized" } },
  },
];

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

// Same graph with Operational Identity switched on, used only to measure the drain gap:
// identity enablement is a table-lock site, so it refuses under `row`/`drain: "none"`.
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
 * Drizzle replaces the message of any wrapped failure with the SQL text and keeps the
 * real driver error on `.cause`, so both are needed to say anything useful — and the
 * driver error is often the only one with content. A refused connection arrives as an
 * `AggregateError` with an empty message and one entry per address family, so those are
 * pulled out too: that is the failure a reader hits first when the container isn't
 * running.
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
 * The `code` a `ConfigurationError` carries in its details bag. Read structurally rather
 * than by importing the error class: the point of these steps is that the refusal is
 * identified by a stable code, which is what an external backend author would key on.
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

/**
 * A `step` for a walk operation that TypeGraph emits correctly but that a currently
 * missing Doltgres feature rejects. `pinnedGap` maps the observed failure to a reason when
 * it is the known engine gap, in which case the step is reported as SKIP — a blocked step
 * is not a broken store — and returns `undefined` for any other failure, which stays a
 * FAIL.
 */
async function stepAllowingPinnedGap(
  name: string,
  fn: () => Promise<string>,
  pinnedGap: (detail: string) => string | undefined,
): Promise<void> {
  try {
    const detail = await fn();
    results.push({ step: name, outcome: "pass", detail });
  } catch (error) {
    const detail = describeError(error);
    const gap = pinnedGap(detail);
    if (gap !== undefined) {
      results.push({ step: name, outcome: "skip", detail: gap });
      return;
    }
    results.push({ step: name, outcome: "fail", detail });
  }
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
// Every row below is a PIN on Doltgres behavior, not a wish: the step passes when the
// engine answers what this PR's body says it answers, and fails the moment that changes —
// in either direction. A gap that upstream closes turns the battery red, which is
// precisely when someone should come back and re-run the walk in Act 1.
//
// Each probe runs on its own client rather than the shared pool: one of them
// (doltgresql#3234) used to panic the server and tear the connection down, and a poisoned
// pool connection would then be handed to an unrelated step.

/** What a probe is pinned to produce. */
type Expectation =
  | Readonly<{ kind: "supported" }>
  /** The engine must reject it, with an error containing `message`. */
  | Readonly<{ kind: "unsupported"; message: string; issue: string }>;

const SUPPORTED: Expectation = { kind: "supported" };

function unsupported(message: string, issue: string): Expectation {
  return { kind: "unsupported", message, issue };
}

/**
 * Runs `statements` (all but the last are setup and must succeed) on a fresh connection
 * and compares the last one's outcome to `expectation`.
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
    // A panicked connection is already gone, so closing it throws — and that failure is
    // not the probe's result.
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

/**
 * Whether this build round-trips the grouping in a saved CHECK expression — TypeGraph's
 * own match-identity constraint, reduced to its two columns. `true` on a build carrying
 * the doltgresql#3324 fix (merged to main after 1.3.3); `false` on 1.3.3, where every edge
 * write refuses. Sets the build flag the walk's bootstrap reads.
 */
let matchIdentityCheckParses = false;

async function probeMatchIdentityCheck(): Promise<void> {
  const name =
    "managed writes: match-identity CHECK (brackets in saved expressions)";
  const client = new Client(DOLTGRES_CONNECTION);
  try {
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS "probe_check"`);
    await client.query(
      `CREATE TABLE "probe_check" (
         "a" TEXT,
         "b" TEXT,
         CONSTRAINT "probe_check_pair" CHECK (("a" IS NULL) = ("b" IS NULL))
       )`,
    );
    const saved = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'probe_check'::regclass`,
    );
    const definition = saved.rows[0]?.def ?? "";
    try {
      await client.query(
        `INSERT INTO "probe_check" ("a", "b") VALUES (NULL, NULL)`,
      );
    } catch (error) {
      matchIdentityCheckParses = false;
      results.push({
        step: name,
        outcome: "pass",
        detail:
          `unsupported as pinned — the engine parses the saved ` +
          `"a IS NULL = b IS NULL" as boolean = text ` +
          `(doltgresql#3324, fixed on main after 1.3.3): ${describeError(error)}`,
      });
      return;
    }
    matchIdentityCheckParses = true;
    results.push({
      step: name,
      outcome: "pass",
      detail: `supported (doltgresql#3324 fix present in this build; saved as ${definition})`,
    });
  } catch (error) {
    results.push({ step: name, outcome: "fail", detail: describeError(error) });
  } finally {
    try {
      await client.end();
    } catch {
      // Intentionally ignored: see the probe comment above.
    }
  }
}

/**
 * A PIN on Doltgres's conflict semantics for one fence row. Two clients each open a
 * transaction and run the `row` mechanism's acquisition (`INSERT ... ON CONFLICT (key) DO
 * UPDATE ... RETURNING generation`). The step passes while the engine provides NO
 * exclusion — the second writer completes and both see generation `1` — and turns red the
 * day upstream makes it wait or detect a conflict, which is the signal to revisit the
 * `row` declaration's `conflict` value.
 */
async function probeFenceRowRace(): Promise<void> {
  const name = "write fence: fence-row acquisition is not an exclusion";
  const first = new Client(DOLTGRES_CONNECTION);
  const second = new Client(DOLTGRES_CONNECTION);
  const upsert = `INSERT INTO "probe_race" ("key", "generation") VALUES ('k', 1)
    ON CONFLICT ("key") DO UPDATE SET "generation" = "probe_race"."generation" + 1
    RETURNING "generation"`;
  try {
    await first.connect();
    await second.connect();
    await first.query(`DROP TABLE IF EXISTS "probe_race"`);
    await first.query(
      `CREATE TABLE "probe_race" ("key" TEXT PRIMARY KEY, "generation" BIGINT NOT NULL)`,
    );
    await first.query(`BEGIN`);
    const firstResult = await first.query<{ generation: string }>(upsert);
    await second.query(`BEGIN`);
    let secondCompleted = false;
    let secondGeneration: string | undefined;
    try {
      const secondResult = await Promise.race([
        second.query<{ generation: string }>(upsert),
        new Promise<undefined>((resolve) =>
          setTimeout(() => { resolve(undefined); }, 1500),
        ),
      ]);
      if (secondResult !== undefined) {
        secondCompleted = true;
        secondGeneration = secondResult.rows[0]?.generation;
      }
    } catch (error) {
      results.push({
        step: name,
        outcome: "fail",
        detail: describeError(error),
      });
      return;
    }
    await Promise.allSettled([
      first.query(`COMMIT`),
      second.query(`COMMIT`),
    ]);
    const final = await first.query<{ generation: string }>(
      `SELECT "generation" FROM "probe_race" WHERE "key" = 'k'`,
    );
    const finalGeneration = final.rows[0]?.generation;
    if (!secondCompleted) {
      results.push({
        step: name,
        outcome: "fail",
        detail:
          "NOW AN EXCLUSION — the second writer blocked; re-run the declaration matrix",
      });
      return;
    }
    results.push({
      step: name,
      outcome: "pass",
      detail:
        `not enforced as pinned (doltgresql#2600): both acquirers returned ` +
        `generation ${String(firstResult.rows[0]?.generation)}/${String(secondGeneration)}, ` +
        `final ${String(finalGeneration)} — a lost update, so conflict "wait" and ` +
        `"commit-time" are both false here`,
    });
  } catch (error) {
    results.push({ step: name, outcome: "fail", detail: describeError(error) });
  } finally {
    for (const client of [first, second]) {
      try {
        await client.end();
      } catch {
        // Intentionally ignored: a torn-down connection is not the probe's result.
      }
    }
  }
}

async function runDeviationBattery(): Promise<void> {
  // pgvector — emulated in Go since 1.3.0 (doltgresql#3126). `CREATE EXTENSION vector`
  // succeeds and reports 0.8.6, which is what `createIterativeScanProbe` keys the
  // iterative-scan decision on.
  await probe("pgvector: extension installs", SUPPORTED, [
    `CREATE EXTENSION IF NOT EXISTS vector`,
  ]);
  await probe(
    "pgvector: reports a version TypeGraph reads as >= 0.8",
    SUPPORTED,
    [
      `CREATE EXTENSION IF NOT EXISTS vector`,
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
  // The write path works too: `EXCLUDED` (doltgresql#1258) is published.
  await probe("pgvector: embedding upsert (EXCLUDED)", SUPPORTED, [
    ...PROBE_SETUP,
    `INSERT INTO "probe_rows" ("id", "version", "embedding") VALUES ('a', 1, '[4,5,6]')
     ON CONFLICT ("id") DO UPDATE SET "embedding" = EXCLUDED."embedding"`,
  ]);
  // The per-search `efSearch` override is applied with `SET LOCAL` inside the search's own
  // transaction, so an approximate search cannot be tuned per call.
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

  // The write fence. `hashtext` (doltgresql#3188) and the one-argument
  // `pg_advisory_xact_lock(bigint)` (doltgresql#3256) are published in 1.3.1; the
  // two-argument form every namespaced TypeGraph lock takes, and every row-locking clause,
  // are not.
  await probe("write fence: hashtext implemented", SUPPORTED, [
    `SELECT hashtext('typegraph')`,
  ]);
  await probe(
    "write fence: advisory xact lock, one-argument bigint",
    SUPPORTED,
    [`SELECT pg_advisory_xact_lock(hashtext('typegraph'))`],
  );
  await probe(
    "write fence: advisory xact lock, two-argument int4",
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
  await probe(
    "write fence: LOCK TABLE still missing",
    unsupported('at or near "lock": syntax error', "doltgresql#2600"),
    [...PROBE_SETUP, `BEGIN`, `LOCK TABLE "probe_rows" IN SHARE MODE`],
  );
  await probeFenceRowRace();

  // The two bootstrap writes this spike filed, now fixed and released in 1.3.1.
  await probe("bootstrap: ON CONFLICT ... DO UPDATE ... WHERE", SUPPORTED, [
    ...PROBE_SETUP,
    `INSERT INTO "probe_rows" ("id", "version") VALUES ('a', 2)
       ON CONFLICT ("id") DO UPDATE SET "version" = 2
       WHERE "probe_rows"."version" <= 2`,
  ]);
  await probe(
    "managed writes: INSERT ... SELECT with uncast bind params",
    SUPPORTED,
    [
      ...PROBE_SETUP,
      {
        text: `INSERT INTO "probe_rows" ("id", "version") SELECT $1, $2`,
        values: ["b", 1],
      },
    ],
  );

  // The system-index gap closed in 1.3.3: `materializeSystemIndexes()` now works, so
  // TypeGraph no longer degrades here.
  await probe(
    "system indexes: ALTER TABLE ... ADD COLUMN IF NOT EXISTS",
    SUPPORTED,
    [
      ...PROBE_SETUP,
      `ALTER TABLE "probe_rows" ADD COLUMN IF NOT EXISTS "extra" TEXT`,
    ],
  );

  // fulltext: both halves missing (doltgresql#3335).
  await probe(
    "fulltext: to_tsvector missing",
    unsupported("function: 'to_tsvector' not found", "doltgresql#3335"),
    [`SELECT to_tsvector('english', 'hello world')`],
  );
  await probe(
    "fulltext: @@ missing",
    unsupported("@@ is not yet supported", "doltgresql#3335"),
    [
      `SELECT to_tsvector('english', 'hello world') @@ to_tsquery('english', 'hello')`,
    ],
  );

  // The blocker for the typed walk on 1.3.3, and the build divergence. Fixed on main.
  await probeMatchIdentityCheck();
}

/**
 * Act 1a — the declaration matrix.
 *
 * Each `capabilities.writeFence` posture gets its own backend and a mini-walk, so the
 * report says how far EACH gets rather than how far the one this file happened to pick
 * gets. It is the honest way to answer "can TypeGraph run on Doltgres": the answer depends
 * on the declaration, and two of the six that construct are unsound.
 */
async function runDeclarationMatrix(pool: Pool): Promise<void> {
  for (const [index, posture] of POSTURES.entries()) {
    const name = `declaration: ${posture.label}`;
    const postureGraph = defineGraph({
      id: `doltgres-matrix-${String(index)}`,
      nodes: { Person: { type: Person } },
      edges: { knows: { type: knows, from: [Person], to: [Person] } },
    });
    let backend: ReturnType<typeof createPostgresBackend>;
    try {
      backend = createPostgresBackend(drizzle(pool), {
        vector: false,
        fulltext: false,
        capabilities: posture.capabilities,
      });
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code === "ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION") {
        results.push({
          step: name,
          outcome: "pass",
          detail: `refused at construction with ${code}`,
        });
        continue;
      }
      results.push({
        step: name,
        outcome: "fail",
        detail: describeError(error),
      });
      continue;
    }
    try {
      const [store, validation] = await createAdapterStoreWithSchema(
        postureGraph,
        backend,
        {},
      );
      const source = await store.nodes.Person.create({
        name: "Alice",
        email: "alice@example.com",
      });
      const target = await store.nodes.Person.create({
        name: "Bob",
        email: "bob@example.com",
      });
      await store.edges.knows.create(source, target, { since: "2024" });
      await store.transaction(async (tx) => {
        await tx.nodes.Person.create({
          name: "Carol",
          email: "carol@example.com",
        });
      });
      const rows = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();
      results.push({
        step: name,
        outcome: "pass",
        detail: `constructs and walks (schema ${validation.status}; ${String(rows.length)} rows)`,
      });
    } catch (error) {
      const detail = describeError(error);
      // The two recognized build-dependent blockers are expected states, not failures: a
      // `FOR UPDATE` refusal is the row-lock half of #2600, and the boolean/text parse is
      // #3324 on a build without its fix.
      const expected =
        detail.includes("locking clauses are not yet supported") ||
        detail.includes("pg_advisory_xact_lock(integer, integer)") ||
        (detail.includes("boolean = text") && !matchIdentityCheckParses);
      results.push({
        step: name,
        outcome: expected ? "pass" : "fail",
        detail: expected ? `blocked as pinned: ${detail}` : detail,
      });
    }
  }
}

// === Act 1b: the typed store walk ===
//
// The walk's 22 steps and the three posture gates, in report order. Listed so a blocked
// walk still SHOWS what is not being measured — a run that silently shrinks to the steps
// that happen to execute would read as a passing spike.
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
  "system indexes: materialized (ADD COLUMN IF NOT EXISTS)",
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

/**
 * Act 2 — the posture gates.
 *
 * These are about TypeGraph's capability model rather than Doltgres's SQL, and they are
 * the reason the walk above is legible: they show which declarations the model ACCEPTS and
 * which it refuses, and that the refusals are typed and happen before any write.
 */
async function runPostureGates(
  backend: ReturnType<typeof createPostgresBackend>,
): Promise<void> {
  await step("history constructs under row (keyed fence only)", async () => {
    const [, validation] = await createAdapterStoreWithSchema(graph, backend, {
      history: true,
    });
    return `schema ${validation.status}`;
  });

  await step("revisionTracking constructs under row", async () => {
    const [, validation] = await createAdapterStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
    return `schema ${validation.status}`;
  });

  await step("identity graph refused (table-lock drain)", async () => {
    try {
      await createAdapterStoreWithSchema(identityGraph, backend, {});
    } catch (error) {
      const code = configurationErrorCode(error);
      const detail = describeError(error);
      if (code === "WRITE_FENCE_UNAVAILABLE" && detail.includes("table lock")) {
        // Identity enablement is a table-lock drain site, and `LOCK TABLE` is the missing
        // half of doltgresql#2600. `drain: "table-lock"` would only reach the syntax error.
        return `${code}: identity enablement needs a table lock (doltgresql#2600)`;
      }
      throw error;
    }
    throw new Error("identity should have been refused under drain: none");
  });
}

async function runSmoke(pool: Pool, branchPool: Pool): Promise<void> {
  const backend = createPostgresBackend(
    drizzle(pool),
    DOLTGRES_BACKEND_OPTIONS,
  );

  await runDeviationBattery();
  await runDeclarationMatrix(pool);

  // === The typed store walk ===
  //
  // The walk now RUNS on a build carrying the doltgresql#3324 fix, and is skipped with a
  // named reason on one that does not. It is not pinned to "blocked": a build where it
  // passes is the desired end state, and a build where it fails on the match-identity CHECK
  // says exactly which upstream issue stands in the way.
  if (!matchIdentityCheckParses) {
    const reason =
      "not measured: 1.3.3 lacks the doltgresql#3324 bracket fix, so every edge write " +
      "fails on the match-identity CHECK (the declaration matrix above records the block; " +
      "the store does construct and node writes do run)";
    results.push({
      step: "schema bootstrap (DDL + ensureSchema)",
      outcome: "skip",
      detail: reason,
    });
    for (const name of WALK_STEPS) {
      skip(name, reason);
    }
    // Act 2 needs no typed writes: history/revisionTracking construct, and identity is
    // refused, on both builds.
    await runPostureGates(backend);
    return;
  }

  const bootstrap = await createAdapterStoreWithSchema(graph, backend, {}).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, detail: describeError(error) }),
  );

  if (!bootstrap.ok) {
    results.push({
      step: "schema bootstrap (DDL + ensureSchema)",
      outcome: "fail",
      detail: `blocked for an UNPINNED reason: ${bootstrap.detail}`,
    });
    for (const name of WALK_STEPS) {
      skip(name, "no store — bootstrap failed");
    }
    await runPostureGates(backend);
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

  await stepAllowingPinnedGap(
    "query orderBy + limit",
    async () => {
      const rows = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name }))
        .orderBy("p", "name", "asc")
        .limit(10)
        .execute();
      return `rows: ${String(rows.length)}`;
    },
    (detail) =>
      detail.includes('at or near "last"') ?
        "blocked: Doltgres rejects `ORDER BY ... ASC NULLS LAST` (explicit ASC + NULLS LAST) " +
        "with a syntax error; DESC NULLS LAST and bare NULLS FIRST both parse, so only the " +
        "ASC form is missing. Every ordered TypeGraph query emits it."
      : undefined,
  );

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

  await stepAllowingPinnedGap(
    "delete protection (connected edges refuse delete)",
    async () => {
      if (!bob) throw new Error("prerequisite create failed");
      try {
        await store.nodes.Person.delete(bob.id);
        return "ERROR: delete should have been refused";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("connected edge")) return "refused as expected";
        throw error;
      }
    },
    (detail) =>
      detail.includes("is non-nullable but attempted to set a value of null") ?
        "blocked: Doltgres emits SQLSTATE 23502 for TypeGraph's guarded-delete NOT NULL " +
        "sentinel but omits the `table`/`column`/`constraint` protocol fields, so " +
        "isNotNullColumnViolation cannot classify it and the raw error surfaces instead of " +
        "the connected-edge refusal. The guard itself fired; only the diagnosis is lost."
      : undefined,
  );

  // 1.3.3 closed the system-index gap: `ADD COLUMN IF NOT EXISTS` works, so this now
  // materializes rather than degrading.
  await step(
    "system indexes: materialized (ADD COLUMN IF NOT EXISTS)",
    async () => {
      await store.materializeSystemIndexes();
      return "system indexes materialized";
    },
  );

  await runPostureGates(backend);

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
    // dolt_merge returns a record; select from it to get named columns. node-postgres
    // hands back int8/numeric columns as strings, so coerce before comparing rather than
    // trusting the declared type.
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
  // Dolt selects a branch via the database name (`<db>/<branch>`). That slash can't
  // survive a connection URL, so the branch pool is built from discrete fields rather than
  // `connectionString`. Pools connect lazily, so building this one up front costs nothing
  // before the branch exists.
  const branchPool = new Pool({
    ...DOLTGRES_CONNECTION,
    database: `${DOLTGRES_CONNECTION.database}/${DEMO_BRANCH}`,
    max: 4,
  });

  try {
    await runSmoke(pool, branchPool);
  } catch (error) {
    // Escapes the step harness only if something outside it failed — usually because the
    // container isn't up. Report it as a failed step rather than a bare stack trace, since
    // that's the first thing a reader will hit.
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

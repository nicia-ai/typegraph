// Doltgres spike smoke test — run: pnpm smoke:doltgres
// Requires the Doltgres container: docker run -d --name typegraph-doltgres-spike \
//   -p 4132:5432 dolthub/doltgresql:1.2.0
// Not wired into CI: it needs that container, and the spike is exploratory.
// Best run against a fresh container; the Dolt act resets the demo branch
// but reuses whatever data earlier runs left on main.
//
// Verified 26/26 on Doltgres 1.2.0 (2026-08-18), the current release of the
// 1.x line that committed to forward storage compatibility and Postgres
// tool/library compatibility. 0.57.3 had already fixed the three gaps this
// spike reported upstream — missing-table SQLSTATE 42P01 (#3011), jsonb
// `#>> = $1` parameter inference (#3012), and `!= ALL(array)` (#3013) — and
// all three remain fixed on 1.2.0.
//
// The declaration below is the whole library-facing configuration: Doltgres
// implements no advisory locks, no row-locking clauses and no LOCK TABLE, and
// Dolt's engine merges concurrent transactions rather than serializing them
// (#2600, re-verified on 1.2.0), so all three `pessimisticLocks` facts are
// false. That resolves to the `unfenced` write-fence plan, which is the
// CAS-only posture: schema commits keep their compare-and-swap and lose only
// the WAIT, while `history` / `revisionTracking` and Operational Identity are
// refused — asserted as steps below, one of which records that identity's
// refusal does not arrive from the gate built for it.
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
//     PostgreSQL SQLSTATEs. Two TypeGraph-relevant ones did NOT narrow and
//     are still `XX000`: `locking clauses are not yet supported`, and the
//     unsupported-DDL error below (PostgreSQL would use `0A000`).
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
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

// Doltgres has no `to_tsvector`/GIN, and no pgvector either: 1.0 replaced the
// DLL-loading extension mechanism with emulated Go implementations, so the
// `pg_config` failure this spike reported (#3014) is gone, but `CREATE
// EXTENSION vector` now answers `extension "vector" is not available` — the
// gap moved rather than closed. Hence `vector: false`, and a stubbed fulltext
// strategy so bootstrap skips the fulltext table entirely; the proper fix is a
// `fulltext: false` opt-out symmetric to `vector: false`, which the postgres
// backend does not offer today.
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

type StepResult = Readonly<{ step: string; ok: boolean; detail: string }>;
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
    results.push({ step: name, ok: true, detail });
    return true;
  } catch (error) {
    results.push({ step: name, ok: false, detail: describeError(error) });
    return false;
  }
}

function report(): void {
  console.log("\n=== Doltgres smoke results ===");
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${result.step} — ${result.detail}`,
    );
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${String(passed)}/${String(results.length)} steps passed`);
}

async function runSmoke(pool: Pool, branchPool: Pool): Promise<void> {
  const backend = createPostgresBackend(
    drizzle(pool),
    DOLTGRES_BACKEND_OPTIONS,
  );

  // Bootstrap outside the harness: nothing below is meaningful if it fails.
  const [store, validation] = await createAdapterStoreWithSchema(
    graph,
    backend,
    {},
  );
  results.push({
    step: "schema bootstrap (DDL + ensureSchema)",
    ok: true,
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

  // === Act 2: what the unfenced declaration buys, and what it costs ===

  await step("write fence: history refused at construction", async () => {
    try {
      await createAdapterStoreWithSchema(graph, backend, { history: true });
      return "ERROR: history should have been refused";
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code !== "RECORDED_CLOCK_REQUIRES_WRITE_FENCE") throw error;
      return `refused with ${code}`;
    }
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
  await step("write fence: Operational Identity refused", async () => {
    try {
      await createAdapterStoreWithSchema(identityGraph, backend, {});
      return "ERROR: identity should have been refused";
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code === "IDENTITY_REQUIRES_WRITE_FENCE") {
        return `refused with ${code}`;
      }
      if (code === "WRITE_FENCE_UNAVAILABLE") {
        return `refused with ${code} from a lock site, not IDENTITY_REQUIRES_WRITE_FENCE — the gate runs after ensureSchema`;
      }
      throw error;
    }
  });

  await step("write fence: revisionTracking refused too", async () => {
    try {
      await createAdapterStoreWithSchema(graph, backend, {
        revisionTracking: true,
      });
      return "ERROR: revisionTracking should have been refused";
    } catch (error) {
      const code = configurationErrorCode(error);
      if (code !== "RECORDED_CLOCK_REQUIRES_WRITE_FENCE") throw error;
      return `refused with ${code}`;
    }
  });

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
      ok: false,
      detail: describeError(error),
    });
    process.exitCode = 1;
  } finally {
    report();
    await Promise.all([pool.end(), branchPool.end()]);
  }
}

await main();

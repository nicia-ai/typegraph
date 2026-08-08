/**
 * The lock scope around `store.rebuildContribution("fulltext")`'s teardown
 * verdict, on a REAL Postgres engine (PGlite, in-process, no Docker).
 *
 * The rebuild decides whether it may `DROP TABLE` the shared fulltext table by
 * probing it for another graph's rows. Ordinary fulltext DML takes no advisory
 * lock, so the constant-keyed contribution lock excludes other REBUILDS and
 * nothing else: a neighbouring graph's INSERT committing between an unlocked
 * probe and the drop would be destroyed by a verdict computed before it
 * existed. What must hold is that the drop is only ever authorized by a probe
 * evaluated while `ACCESS EXCLUSIVE` is held on that table.
 *
 * That is an ORDERING and a COST, not an outcome, and PGlite is
 * single-connection and serial so a genuine two-writer race is not
 * constructible here — `tests/backends/postgres/concurrent-fulltext-rebuild.
 * test.ts` is the other half, on server Postgres, asserting the outcome. These
 * assertions are about the lock's presence, its placement relative to the probe
 * it protects and the drop that probe authorizes, and — just as load-bearing —
 * its ABSENCE on the graph-scoped path, so the fix cannot be "lock everything":
 * a rebuild that removes only its own rows must not freeze every other graph's
 * fulltext writers for the length of its refill.
 *
 * Statements are captured with drizzle's `logger`, matching
 * `tests/constraint-write-fence.test.ts`: it sees every statement, including
 * the raw DDL a backend-method Proxy would miss.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type GraphBackend } from "../src/backend/types";

const CONTRIBUTION_DDL_LOCK_KEY = "typegraph:contribution-ddl";
const FULLTEXT_TABLE = "typegraph_node_fulltext";

type LoggedStatement = Readonly<{ query: string; params: readonly unknown[] }>;

const Article = defineNode("Article", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const Note = defineNode("Note", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});

const alphaGraph = defineGraph({
  id: "rebuild-lock-alpha",
  nodes: { Article: { type: Article } },
  edges: {},
});
/** A second graph whose rows live in the SAME physical fulltext table. */
const betaGraph = defineGraph({
  id: "rebuild-lock-beta",
  nodes: { Note: { type: Note } },
  edges: {},
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.toReversed()) await cleanup();
});

async function createLoggedBackend(): Promise<
  Readonly<{
    backend: GraphBackend;
    statements: LoggedStatement[];
    reset: () => void;
  }>
> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  await client.exec(generatePostgresDDL().join("\n\n"));

  const statements: LoggedStatement[] = [];
  const backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(query: string, params: unknown[]): void {
          statements.push({ query, params });
        },
      },
    }),
    { vector: false },
  );

  return { backend, statements, reset: () => statements.splice(0) };
}

function indicesMatching(
  statements: readonly LoggedStatement[],
  predicate: (statement: LoggedStatement) => boolean,
): readonly number[] {
  return statements.flatMap((statement, index) =>
    predicate(statement) ? [index] : [],
  );
}

/** The constant-keyed advisory lock on the contribution itself. */
function contributionLockIndices(
  statements: readonly LoggedStatement[],
): readonly number[] {
  return indicesMatching(
    statements,
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === CONTRIBUTION_DDL_LOCK_KEY,
  );
}

/** `LOCK TABLE typegraph_node_fulltext IN ACCESS EXCLUSIVE MODE`. */
function tableLockIndices(
  statements: readonly LoggedStatement[],
): readonly number[] {
  return indicesMatching(
    statements,
    (statement) =>
      statement.query.includes("LOCK TABLE") &&
      statement.query.includes("ACCESS EXCLUSIVE") &&
      statement.query.includes(FULLTEXT_TABLE),
  );
}

/** The foreign-row probe whose verdict authorizes (or forbids) the drop. */
function foreignProbeIndices(
  statements: readonly LoggedStatement[],
): readonly number[] {
  return indicesMatching(statements, (statement) =>
    statement.query.includes('SELECT DISTINCT "graph_id"'),
  );
}

function dropIndices(
  statements: readonly LoggedStatement[],
): readonly number[] {
  return indicesMatching(
    statements,
    (statement) =>
      statement.query.includes("DROP TABLE") &&
      statement.query.includes(FULLTEXT_TABLE),
  );
}

/** The graph-scoped teardown: `DELETE FROM <fulltext> WHERE graph_id = $1`. */
function graphDeleteIndices(
  statements: readonly LoggedStatement[],
): readonly number[] {
  return indicesMatching(
    statements,
    (statement) =>
      statement.query.includes("DELETE FROM") &&
      statement.query.includes(FULLTEXT_TABLE) &&
      statement.query.includes('"graph_id" = ') &&
      statement.params.includes(alphaGraph.id),
  );
}

describe("the fulltext rebuild's teardown verdict is computed under the lock it needs", () => {
  it("takes ACCESS EXCLUSIVE before the probe that authorizes the drop, and after the contribution lock", async () => {
    const { backend, statements, reset } = await createLoggedBackend();
    const [alpha] = await createStoreWithSchema(alphaGraph, backend);
    await alpha.nodes.Article.create({ title: "Alpha content" });

    reset();
    await alpha.rebuildContribution("fulltext");

    const contributionLocks = contributionLockIndices(statements);
    const tableLocks = tableLockIndices(statements);
    const probes = foreignProbeIndices(statements);
    const drops = dropIndices(statements);

    // The rebuild took the recreate path: no other graph has rows here.
    expect(drops).toHaveLength(1);
    expect(contributionLocks).toHaveLength(1);
    expect(tableLocks).toHaveLength(1);

    // Two probes: one unlocked (cheap, keeps the graph-scoped path off the
    // relation lock) and one under ACCESS EXCLUSIVE. Only the second may
    // authorize a drop, so the drop must sit after BOTH the lock and the
    // probe that followed it.
    expect(probes).toHaveLength(2);
    const [firstProbe, lockedProbe] = probes as [number, number];
    const [contributionLock] = contributionLocks as [number];
    const [tableLock] = tableLocks as [number];
    const [drop] = drops as [number];

    expect(contributionLock).toBeLessThan(firstProbe);
    // ORDER: the constant advisory key before the relation lock, on the one
    // path that takes both.
    expect(contributionLock).toBeLessThan(tableLock);
    expect(tableLock).toBeGreaterThan(firstProbe);
    expect(lockedProbe).toBeGreaterThan(tableLock);
    expect(drop).toBeGreaterThan(lockedProbe);
  });

  it("takes no table lock and drops nothing when another graph's rows share the table", async () => {
    const { backend, statements, reset } = await createLoggedBackend();
    const [alpha] = await createStoreWithSchema(alphaGraph, backend);
    const [beta] = await createStoreWithSchema(betaGraph, backend);
    await alpha.nodes.Article.create({ title: "Alpha content" });
    await beta.nodes.Note.create({ body: "Beta content" });

    reset();
    await alpha.rebuildContribution("fulltext");

    // The graph-scoped path: the DELETE is transactional and touches only
    // this graph's rows, so making every other graph's writers wait for the
    // refill would be a cost with nothing to buy.
    expect(tableLockIndices(statements)).toHaveLength(0);
    expect(dropIndices(statements)).toHaveLength(0);
    expect(foreignProbeIndices(statements)).toHaveLength(1);
    expect(graphDeleteIndices(statements)).toHaveLength(1);
    // The contribution lock is still taken: two rebuilds racing the shared
    // table's DDL are serialized whichever path each of them takes.
    expect(contributionLockIndices(statements)).toHaveLength(1);

    // Beta's content is intact, which is the property the ordering protects.
    const hits = await beta.search.fulltext("Note", {
      query: "Beta",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
  });
});

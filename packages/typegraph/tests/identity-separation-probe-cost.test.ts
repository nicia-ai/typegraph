/**
 * What the separation probe costs, counted rather than claimed.
 *
 * The read it replaced resolved both identity classes and then loaded every
 * current `different` assertion touching the first one — a scan whose statement
 * count grows with class size, because the endpoint list is chunked to fit the
 * backend's bind budget. The probe is one equality lookup on the relation's
 * primary key, so the ledger is not read at all and the count does not move
 * when the class grows.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  type GraphBackend,
  renderPostgres,
  type TransactionBackend,
} from "../src";
import { separationRebuildRequired } from "../src/identity/separation";
import { MAX_REFERENCE_CHUNK_SIZE } from "../src/identity/sql-target";
import { type GraphData, importGraph } from "../src/interchange";
import { createSqlSchema } from "../src/query/compiler/schema";
import { type SqlFragment } from "../src/query/sql-fragment";
import { buildKindRegistry } from "../src/registry";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity_probe_cost",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

interface RelationCounts {
  assertionStatements: number;
  separationStatements: number;
  /**
   * Statements issued by the unfilled-storage guard specifically — the ledger
   * probes it runs when the relation holds no row for the graph. Identified by
   * the alias the guard wraps its snapshot source in, which no other identity
   * statement uses.
   */
  readinessProofStatements: number;
}

// Table names arrive as identifier chunks, not literal SQL text.
function fragmentText(compiled: SqlFragment): string {
  return compiled.chunks
    .map((chunk) =>
      chunk.kind === "text" || chunk.kind === "identifier" ? chunk.value : "",
    )
    .join(" ");
}

function relationCountingBackend(): Readonly<{
  backend: GraphBackend;
  counts: RelationCounts;
  reset: () => void;
}> {
  const base = createTestBackend();
  const tables = createSqlSchema(base.tableNames).tables;
  const counts = {
    assertionStatements: 0,
    separationStatements: 0,
    readinessProofStatements: 0,
  };

  function count(compiled: SqlFragment): void {
    const text = fragmentText(compiled);
    // The separation table name contains the assertions table name in neither
    // direction, so a plain substring test attributes each statement once.
    if (text.includes(tables.identityAssertions)) {
      counts.assertionStatements += 1;
    }
    if (text.includes(tables.identitySeparation)) {
      counts.separationStatements += 1;
    }
    if (text.includes("live_different")) {
      counts.readinessProofStatements += 1;
    }
  }

  // A Proxy rather than a spread: transaction targets carry methods on a
  // prototype that spreading would drop.
  function countStatements<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    return new Proxy(target, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property !== "execute" && property !== "executeStatement") {
          return value;
        }
        return (...args: unknown[]) => {
          count(args[0] as SqlFragment);
          return method.apply(source, args);
        };
      },
    });
  }

  const backend: GraphBackend = countStatements({
    ...base,
    transaction: (fn, options) =>
      base.transaction((tx) => fn(countStatements(tx)), options),
  } satisfies GraphBackend);

  return {
    backend,
    counts,
    reset: () => {
      counts.assertionStatements = 0;
      counts.separationStatements = 0;
      counts.readinessProofStatements = 0;
    },
  };
}

describe("cost of a current different-ness read", () => {
  it("probes the relation once and never reads the ledger, whatever the class size", async () => {
    const { backend, counts, reset } = relationCountingBackend();
    const store = await createInitializedStore(graph, backend);

    // One class large enough that the replaced ledger scan could not have named
    // its members in a single statement, and a peer held apart from it.
    const memberCount = MAX_REFERENCE_CHUNK_SIZE + 50;
    const members = [];
    for (let index = 0; index < memberCount; index += 1) {
      members.push(
        await store.nodes.Person.create(
          { name: `member-${index}` },
          { id: `member-${String(index).padStart(4, "0")}` },
        ),
      );
    }
    const peer = await store.nodes.Person.create({ name: "Peer" });
    const anchor = requireDefined(members[0]);
    await store.identity.bulkAssertSame(
      members.slice(1).map((member) => ({ a: anchor, b: member })),
    );
    await store.identity.assertDifferent(anchor, peer);
    expect(await store.identity.membersOf(anchor)).toHaveLength(memberCount);

    reset();
    expect(await store.identity.areDifferent(anchor, peer)).toBe(true);
    expect(counts).toEqual({
      assertionStatements: 0,
      separationStatements: 1,
      readinessProofStatements: 0,
    });

    // The negative answer costs the same probe, and so does the answer for a
    // singleton class: the cost is a property of the relation's index, not of
    // how much identity state the classes carry.
    const stranger = await store.nodes.Person.create({ name: "Stranger" });
    reset();
    expect(await store.identity.areDifferent(anchor, stranger)).toBe(false);
    expect(counts).toEqual({
      assertionStatements: 0,
      separationStatements: 1,
      readinessProofStatements: 0,
    });
  });

  it("pays one bounded ledger probe only where an empty answer could be an unfilled relation", async () => {
    const { backend, counts, reset } = relationCountingBackend();
    const store = await createInitializedStore(graph, backend);
    const first = await store.nodes.Person.create({ name: "First" });
    const second = await store.nodes.Person.create({ name: "Second" });

    // This graph holds NO separation row, so "no row for this pair" cannot be
    // told from "this graph's fill never ran" by the relation alone. The
    // decision costs one `LIMIT 1` against the ledger — bounded, and unrelated
    // to class size — and it is the only state that pays it: the case above,
    // where the graph does have rows, still reads the ledger zero times.
    reset();
    expect(await store.identity.areDifferent(first, second)).toBe(false);
    expect(counts).toEqual({
      assertionStatements: 1,
      separationStatements: 1,
      readinessProofStatements: 1,
    });

    // ONCE, not once per read. The proof settles a property of the graph, not
    // of the pair, and the ledger has no index that could answer it cheaply —
    // so a per-read proof is what made a `same`-only workload pay for a guard
    // whose answer never changes. The pair probe itself still runs every time.
    reset();
    expect(await store.identity.areDifferent(first, second)).toBe(false);
    expect(counts).toEqual({
      assertionStatements: 0,
      separationStatements: 1,
      readinessProofStatements: 0,
    });
  });
});

/**
 * The workload class the guard's first shape mispriced: a graph holding ONLY
 * `same` assertions never has a separation row, so "zero rows" is not a corner
 * case there — it is the steady state, and every validated pair landed on the
 * guard's ledger probe. Counted rather than timed, so the claim is structural:
 * the proof is per HANDLE, and the count must not move when the batch does.
 *
 * The review's workload: an interchange import whose identity section is all
 * `same`. Every assertion in it runs the same per-pair validation a single
 * `assertSame` does, so the import is where a per-pair proof multiplies.
 */
function sameOnlyImport(run: string, count: number): GraphData {
  const now = new Date().toISOString();
  const ids = Array.from({ length: count }, (_, index) => `${run}-${index}`);
  return {
    formatVersion: "2.0",
    exportedAt: now,
    source: { type: "external", description: "guard cost" },
    nodes: ids.flatMap((id) => [
      { kind: "Person", id: `a-${id}`, properties: { name: id } },
      { kind: "Person", id: `b-${id}`, properties: { name: id } },
    ]),
    edges: [],
    identity: {
      profile: "typegraph-identity-v1",
      mode: "state",
      assertions: ids.map((id) => ({
        id: `assertion-${id}`,
        relation: "same" as const,
        a: { kind: "Person", id: `a-${id}` },
        b: { kind: "Person", id: `b-${id}` },
        validFrom: now,
      })),
    },
  };
}

describe("cost of the unfilled-storage guard under same-only batches", () => {
  it("proves readiness once per import, not once per assertion", async () => {
    const { backend, counts, reset } = relationCountingBackend();
    const store = await createInitializedStore(graph, backend);

    reset();
    const fiftyResult = await importGraph(store, sameOnlyImport("fifty", 50), {
      onConflict: "error",
      refreshStatistics: false,
    });
    expect(fiftyResult.success).toBe(true);
    const fifty = counts.readinessProofStatements;

    reset();
    const twoHundredResult = await importGraph(
      store,
      sameOnlyImport("twoHundred", 200),
      { onConflict: "error", refreshStatistics: false },
    );
    expect(twoHundredResult.success).toBe(true);
    const twoHundred = counts.readinessProofStatements;

    // ONE proof for the first import — no live `different` exists, so the cheap
    // half of the probe settles it in a single statement — and NONE for the
    // second, which reuses the first's proof because the same handle asked.
    // Proving per pair reads 50 and 200 instead, which is what the review
    // measured as +23% and +32% on these two imports.
    expect(fifty).toBe(1);
    expect(twoHundred).toBe(0);
  });
});

describe("owed-separation probe bind budget", () => {
  /**
   * A graph with three identity-active kinds, so the kind list is chunked
   * rather than emitted whole at the budget below.
   */
  const Alpha = defineNode("Alpha", { schema: z.object({ name: z.string() }) });
  const Beta = defineNode("Beta", { schema: z.object({ name: z.string() }) });
  const Gamma = defineNode("Gamma", { schema: z.object({ name: z.string() }) });
  const threeKindGraph = defineGraph({
    id: "identity_probe_bind_budget",
    nodes: {
      Alpha: { type: Alpha },
      Beta: { type: Beta },
      Gamma: { type: Gamma },
    },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });

  /**
   * The exact ceiling the correctly-budgeted probe fits in: six fixed binds
   * (the snapshot subquery's four plus the two closure joins' `graph_id`) and
   * one chunk of two kinds, each bound on both endpoints.
   *
   * Chosen to be the boundary. Under-counting the fixed binds by the two join
   * binds computes a chunk of all three kinds, which needs twelve — so the
   * assertion below is what tells a wrong constant from a right one.
   */
  const BIND_BUDGET = 10;

  it("keeps every probe statement inside the backend's bind ceiling", async () => {
    const captured: number[] = [];
    // Stub, not a real backend: the probe's chunk math reads only
    // `capabilities.maxBindParameters`, and what is under test is how wide the
    // statement it builds is — not what the database answers. The first probe
    // reports a live `different` so the exact probe actually runs.
    const target = {
      dialect: "sqlite" as const,
      capabilities: { maxBindParameters: BIND_BUDGET },
      execute: (compiled: SqlFragment) => {
        captured.push(renderPostgres(compiled).params.length);
        return Promise.resolve([{ present: 1 }]);
      },
      executeStatement: () => Promise.resolve(undefined),
    };

    const registry = buildKindRegistry(threeKindGraph);
    await separationRebuildRequired(
      target as unknown as Parameters<typeof separationRebuildRequired>[0],
      createSqlSchema(createTestBackend().tableNames),
      threeKindGraph.id,
      { relationExists: false, registry },
    );

    expect(captured.length).toBeGreaterThan(1);
    for (const parameterCount of captured) {
      expect(parameterCount).toBeLessThanOrEqual(BIND_BUDGET);
    }
    // The widest statement really did reach the ceiling, so the bound above is
    // a boundary rather than slack.
    expect(Math.max(...captured)).toBe(BIND_BUDGET);
  });
});

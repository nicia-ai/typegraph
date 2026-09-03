/**
 * On-graph provenance persistence — the sidecar provenance graph (open-item #5).
 *
 * With `persistProvenance: true`, the merge upserts one `{branch, sourceId}` row
 * per contribution into a sidecar graph on the SAME backend, queryable AFTER the
 * merge via `openProvenanceStore` / `readProvenance`. Asserted on BOTH backends:
 *
 *   1. the persisted rows match the in-memory `report.provenance.byBranch` index;
 *   2. a resolved canonical carries provenance from BOTH contributing branches
 *      (with the original fork-local `sourceId`s);
 *   3. edges are tagged too (`role: "edge"`);
 *   4. re-persisting is idempotent (deterministic ids → upsert, no duplicates);
 *   5. it is OFF by default (no `provenancePersisted`, no rows);
 *   6. a contribution the pipeline observes SEVERAL times (an edge id staged by two
 *      branches, an inherited edge modification seen by both delete/modify and the
 *      repoint fold — with two contributing branches or just one) is persisted and
 *      counted ONCE per distinct `(role, canonical, branch, source)` — while every
 *      genuinely distinct contributing branch is still credited;
 *   7. `persistProvenanceRecords` collapses hash-identical records for callers that
 *      reach it without going through a merge.
 *
 * A second group covers OWNERSHIP of the sidecar graph id — which occupant
 * `openProvenanceStore` may write to, and which refusal it names. The boundary is
 * the ownership MARKER, written FIRST (inside the claim's fence, before the
 * sidecar schema): a schema-less application graph (rows but no schema row) and an
 * exact-schema one are refused untouched, an unmarked graph carrying the CURRENT
 * sidecar schema is refused whatever its contents — empty and
 * verifiably-provenance-shaped included — and an empty or unverifiable pre-marker
 * sidecar is refused with drop-this-id remediation. Only two states admit a write:
 * a completely free id, and a pre-marker (legacy) sidecar whose every row verifies.
 * Occupancy is asserted in every shape it can take — `Provenance`-kind node rows,
 * edge rows alone, a registered but EMPTY graph of a third schema — because each is
 * a row this module's own probes could mistake for its own. Recognition of a
 * pre-marker row is asserted on each of its three independent grounds (live, valid
 * for THIS target, stored under its recomputed id), and is verified EXHAUSTIVELY: a
 * sidecar spanning more than one read page must have every page checked.
 *
 * A third group covers the ORDERING and ATOMICITY of the ownership claim and the
 * one row state that counts as this module's marker:
 *
 *   - a free id is claimed inside ONE `schemaWriteTransaction` fence and the schema
 *     is registered only afterwards;
 *   - a row landing BETWEEN the unfenced preflight and the fenced claim makes the
 *     open refuse having written NOTHING — no schema row, no marker, no provenance
 *     row — on a fresh id and on a pre-marker one alike, and a valid MARKER landing
 *     in that same window makes the claim write nothing at all;
 *   - a crash between the two writes leaves marker-without-schema, which a reopen
 *     RESUMES (the marker is the proof of ownership, and it is what committed
 *     first);
 *   - an application row written into the sidecar AFTER the claim does not revoke
 *     ownership: it landed in a graph that was already visibly marked;
 *   - a `ProvenanceOwner` row this module cannot verify — tombstoned, malformed,
 *     claiming another target, or under a non-canonical id — is foreign occupancy:
 *     the open refuses and the row is never overwritten or resurrected;
 *   - a backend with no transactional schema fence is refused outright rather than
 *     claimed with a check-then-write a concurrent writer can slip through.
 *
 * A final backend-independent block pins the row identity itself: the literal id a
 * contribution hashes to, and that no identifying field is missing from the key
 * every collapse is keyed on.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  deriveBackend,
  projectBackendWithout,
} from "../../src/backend/derive-backend";
import type { NodeRow } from "../../src/backend/types";
import { asEdgeId } from "../../src/core/types";
import { branch } from "../../src/graph-merge/branch";
import { parseRowProps } from "../../src/graph-merge/canonical-props";
import { merge } from "../../src/graph-merge/merge";
import type { ProvenanceNode } from "../../src/graph-merge/provenance-store";
import {
  contributionKey,
  openProvenanceStore,
  persistProvenanceRecords,
  provenanceGraphId,
  provenanceNodeId,
} from "../../src/graph-merge/provenance-store";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { createSqlSchema } from "../../src/query/compiler/schema";
import { sql } from "../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../src/query/sql-intent";
import { requireDefined } from "../../src/utils/presence";
import { createPgliteFixturePool } from "./pglite-fixture-pool";
import { backendMatrix, getBackendProperty } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});
const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

// Deliberately mirrors the internal sidecar schema. Schema equality is not an
// ownership claim: an application is allowed to define these exact kinds at
// the conventional sidecar graph id.
const ApplicationProvenance = defineNode("Provenance", {
  schema: z.object({
    targetGraphId: z.string(),
    role: z.enum(["node", "edge"]),
    canonicalId: z.string(),
    canonicalKind: z.string(),
    branchId: z.string(),
    sourceId: z.string(),
  }),
});
const ApplicationProvenanceOwner = defineNode("ProvenanceOwner", {
  schema: z.object({
    owner: z.literal("@nicia-ai/typegraph/merge-provenance"),
    version: z.literal(1),
    targetGraphId: z.string(),
  }),
});

/** The row id the sidecar's durable ownership marker is stored under. */
const PROVENANCE_OWNER_ROW_ID = "merge-provenance-owner";

/**
 * Mirrors the module's internal sidecar read-page size — the only boundary the
 * paginated contents verification has, and therefore the only place a loop that
 * reads one page and stops can hide an unverified row.
 */
const SIDECAR_PAGE_SIZE = 500;
const PROVENANCE_OWNER = "@nicia-ai/typegraph/merge-provenance";

const careGraph = defineGraph({
  id: "provenance-test-care",
  nodes: { Patient: { type: Patient }, Encounter: { type: Encounter } },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});
type CareGraph = typeof careGraph;

const BRANCH_A = asBranchId("provider-a");
const BRANCH_B = asBranchId("provider-b");

/**
 * The graph a caller would define to sit at the sidecar id with the CURRENT
 * (owner-marker-bearing) sidecar shape. Its serialized schema — and therefore
 * its hash — is the one `openProvenanceStore` computes for its own graph, which
 * is what makes it usable both as the "creation crashed after the schema commit"
 * fixture and as the exact-schema application-graph fixture.
 */
function sidecarShapedGraph() {
  return defineGraph({
    id: provenanceGraphId(careGraph.id),
    nodes: {
      Provenance: { type: ApplicationProvenance },
      ProvenanceOwner: { type: ApplicationProvenanceOwner },
    },
    edges: {},
  });
}

/** The pre-marker (legacy) sidecar shape: the `Provenance` kind alone. */
function legacyShapedGraph() {
  return defineGraph({
    id: provenanceGraphId(careGraph.id),
    nodes: { Provenance: { type: ApplicationProvenance } },
    edges: {},
  });
}

/** Timestamp the raw identity-assertion fixture is stamped with. */
const ASSERTION_INSTANT = "2024-01-01T00:00:00.000Z";

/**
 * The physical identity-assertion table this backend uses — read off the same
 * `tableNames` port the module's own probe resolves, so a backend with custom
 * names is addressed correctly rather than by a hard-coded default.
 */
function identityAssertionsTable(backend: GraphBackend): string {
  return createSqlSchema(backend.tableNames).tables.identityAssertions;
}

/** Reads the durable ownership marker row straight from the backend. */
async function readOwnerMarker(
  backend: GraphBackend,
): Promise<NodeRow | undefined> {
  return backend.getNode(
    provenanceGraphId(careGraph.id),
    "ProvenanceOwner",
    PROVENANCE_OWNER_ROW_ID,
  );
}

/** The props of the ONE `ProvenanceOwner` row state that means "ours". */
const OWNER_MARKER_PROPS = {
  owner: PROVENANCE_OWNER,
  version: 1,
  targetGraphId: careGraph.id,
} as const;

/**
 * A backend whose schema fence counts the transactions it opens.
 *
 * The count is the observable proof that the ownership claim is FENCED: a claim
 * that re-verified the contents and wrote the marker outside a
 * `schemaWriteTransaction` — the check-then-write a concurrent application writer
 * can land between — would open none.
 */
function countingFenceBackend(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  fenceCount: () => number;
}> {
  const fence = requireDefined(backend.schemaWriteTransaction);
  let opened = 0;
  const counting: NonNullable<GraphBackend["schemaWriteTransaction"]> = (
    graphId,
    fn,
  ) => {
    opened += 1;
    return fence(graphId, fn);
  };
  return {
    backend: deriveBackend(backend, { schemaWriteTransaction: counting }),
    fenceCount: () => opened,
  };
}

/**
 * A backend that runs `injection` exactly once, immediately before the first
 * schema fence the caller opens.
 *
 * That is the TOCTOU window under test, driven deterministically rather than by
 * timing: `openProvenanceStore` inspects the id unfenced and then — before any
 * write of its own, the schema registration included — opens the fence that
 * re-verifies and claims. Anything `injection` writes therefore lands strictly
 * after the preflight inspection and strictly before the claim's own
 * verification.
 */
function backendRacingTheClaim(
  backend: GraphBackend,
  injection: () => Promise<void>,
): GraphBackend {
  const fence = requireDefined(backend.schemaWriteTransaction);
  let injected = false;
  const racing: NonNullable<GraphBackend["schemaWriteTransaction"]> = (
    graphId,
    fn,
  ) => {
    if (injected) return fence(graphId, fn);
    injected = true;
    return injection().then(() => fence(graphId, fn));
  };
  return deriveBackend(backend, { schemaWriteTransaction: racing });
}

/**
 * Records, in order, the SQL every statement and row query the CLAIM's fenced
 * transaction issues — the only way to see the relation lock, which produces no
 * rows and no observable state of its own.
 *
 * The transaction is proxied, not the top-level backend: the drain and the
 * re-inspection both run against the fenced transaction, and their ORDER inside
 * it is the property under test.
 */
function backendRecordingFencedSql(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  statements: () => readonly string[];
}> {
  const fence = requireDefined(backend.schemaWriteTransaction);
  const compile = requireDefined(backend.compileSql);
  const recorded: string[] = [];
  const recording: NonNullable<GraphBackend["schemaWriteTransaction"]> = (
    graphId,
    fn,
  ) =>
    fence(graphId, async (tx) =>
      fn(
        new Proxy(tx, {
          get(target, property, _receiver) {
            if (property === "executeStatement" || property === "execute") {
              const original = getBackendProperty(
                target as unknown as GraphBackend,
                property,
              ) as (query: never) => Promise<unknown>;
              return (query: never) => {
                recorded.push(compile(query).sql);
                return original(query);
              };
            }
            return getBackendProperty(
              target as unknown as GraphBackend,
              property,
            );
          },
        }),
      ),
    );
  return {
    backend: deriveBackend(backend, { schemaWriteTransaction: recording }),
    statements: () => [...recorded],
  };
}

/** What the injected schema-registration crash throws. */
const SCHEMA_COMMIT_CRASH = "injected schema-commit crash";

/**
 * A backend whose FIRST schema-version commit fails.
 *
 * That is the crash the new write order can leave behind: the fenced ownership
 * claim has committed and the schema registration that follows it has not. Every
 * commit primitive a schema registration can reach is intercepted, so the
 * injection cannot be routed around.
 */
function backendFailingSchemaCommit(backend: GraphBackend): GraphBackend {
  let crashed = false;
  function failOnce<T>(commit: () => Promise<T>): Promise<T> {
    if (crashed) return commit();
    crashed = true;
    return Promise.reject(new Error(SCHEMA_COMMIT_CRASH));
  }
  const withPreflight = backend.commitSchemaVersionWithPreflight;
  const ifKindsEmpty = backend.commitSchemaVersionIfKindsEmpty;
  return deriveBackend(backend, {
    commitSchemaVersion: (params) =>
      failOnce(() => backend.commitSchemaVersion(params)),
    ...(withPreflight === undefined ?
      {}
    : {
        commitSchemaVersionWithPreflight: (
          params: Parameters<typeof withPreflight>[0],
          preflight: Parameters<typeof withPreflight>[1],
        ) => failOnce(() => withPreflight(params, preflight)),
      }),
    ...(ifKindsEmpty === undefined ?
      {}
    : {
        commitSchemaVersionIfKindsEmpty: (
          params: Parameters<typeof ifKindsEmpty>[0],
          probes: Parameters<typeof ifKindsEmpty>[1],
        ) => failOnce(() => ifKindsEmpty(params, probes)),
      }),
  });
}

/** What the injected post-commit sidecar row-read failure throws. */
const SIDECAR_ROW_READ_FAILURE = "sidecar row read boom";

/**
 * A backend whose row reads for ONE graph id fail, transaction-scoped reads
 * included.
 *
 * The wrapper re-applies itself to every transaction the backend hands out,
 * because the write path under test reads through the transaction it opens, not
 * through the top-level backend. Scoping the failure to a single graph id is what
 * makes it a faithful transient fault: the merge's own commit, against the target
 * graph, is untouched.
 */
function backendFailingRowReadsFor(
  backend: GraphBackend,
  failingGraphId: string,
): GraphBackend {
  function targetsFailingGraph(args: readonly unknown[]): boolean {
    const [first] = args;
    return (
      first === failingGraphId ||
      (typeof first === "object" &&
        first !== null &&
        (first as Readonly<{ graphId?: unknown }>).graphId === failingGraphId)
    );
  }
  // The wrapper is applied to transaction-scoped backends too, which are not
  // `GraphBackend`s, so member lookup goes through one erased accessor.
  function memberOf(target: object, property: PropertyKey): unknown {
    return getBackendProperty(target as GraphBackend, property);
  }
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(inner, property, _receiver) {
        if (property === "getNode" || property === "getNodes") {
          const original = memberOf(inner, property) as
            ((...args: readonly unknown[]) => unknown) | undefined;
          if (original === undefined) return original;
          return (...args: readonly unknown[]) =>
            targetsFailingGraph(args) ?
              Promise.reject(new Error(SIDECAR_ROW_READ_FAILURE))
            : original(...args);
        }
        if (property === "transaction") {
          const original = memberOf(inner, property) as (
            fn: (tx: object) => Promise<unknown>,
            options?: unknown,
          ) => Promise<unknown>;
          return (fn: (tx: object) => Promise<unknown>, options?: unknown) =>
            original((tx) => fn(wrap(tx)), options);
        }
        return memberOf(inner, property);
      },
    });
  }
  return wrap(backend);
}

/** The same backend with its transactional schema fence withheld. */
function backendWithoutSchemaFence(backend: GraphBackend): GraphBackend {
  return projectBackendWithout(backend, ["schemaWriteTransaction"]);
}

/** One pre-marker `Provenance` row as a bulk-create input. */
type SidecarRowInput = Readonly<{
  id: string;
  props: Readonly<{
    targetGraphId: string;
    role: "node" | "edge";
    canonicalId: string;
    canonicalKind: string;
    branchId: string;
    sourceId: string;
  }>;
}>;

/** A contribution the sidecar can hold, plus its deterministic row id. */
const SIDECAR_RECORD = {
  role: "node",
  canonicalId: "canonical-resumed",
  canonicalKind: "Patient",
  branchId: BRANCH_A,
  sourceId: "source-resumed",
} as const;

/** Committed endpoints both branches fork with, so their edges share an identity. */
const COMMITTED_PATIENT = "pat-committed";
const COMMITTED_ENCOUNTER = "enc-committed";
const COMMITTED_BIRTH_DATE = "1961-11-02";
const SHARED_EDGE = "edge-shared";
const SHARED_EDGE_ID = asEdgeId<typeof hadEncounter>(SHARED_EDGE);

/**
 * The contribution identity a persisted row stands for — the exact tuple
 * {@link provenanceNodeId} hashes into the row's id. Two rows agreeing on it are
 * the same contribution, so a duplicate is what an over-count is MADE of.
 */
function contributionOf(node: ProvenanceNode): string {
  return JSON.stringify([
    node.role,
    node.canonicalKind,
    node.canonicalId,
    node.branchId,
    node.sourceId,
  ]);
}

/** Edge contributions in a stable, readable order (persisted ids are hashes). */
function edgeContributions(
  nodes: readonly ProvenanceNode[],
): readonly Readonly<{
  branchId: string;
  canonicalId: string;
  sourceId: string;
}>[] {
  return nodes
    .filter((node) => node.role === "edge")
    .map((node) => ({
      branchId: node.branchId,
      canonicalId: node.canonicalId,
      sourceId: node.sourceId,
    }))
    .sort((left, right) => left.branchId.localeCompare(right.branchId));
}

/** Fulltext name match (no embedder): "Anna Rivera" ~ "Ana Rivera" clears 0.85. */
function provMergeOptions(persistProvenance: boolean): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { birthDate?: string }).birthDate,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
    persistProvenance,
  };
}

type Fixture = Readonly<{
  backend: GraphBackend;
  base: Store<CareGraph>;
  branches: readonly GraphBranch<CareGraph>[];
}>;

const pglitePool = createPgliteFixturePool();
afterAll(async () => {
  await pglitePool.dispose();
});

describe.each(backendMatrix())("provenance persistence [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture =
      entry.name === "PGlite" ?
        await pglitePool.makeFixture()
      : await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  /**
   * Base + two branches: each adds a near-duplicate Patient (same birthDate) plus
   * its own Encounter joined by a hadEncounter edge. The merge resolves the two
   * Patients into one canonical and repoints both edges onto it.
   */
  async function materialize(): Promise<Fixture> {
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );

    await branchA.store.nodes.Patient.bulkCreate([
      {
        id: "pat-anna",
        props: { name: "Anna Rivera", birthDate: "1974-03-09" },
      },
    ]);
    await branchA.store.nodes.Encounter.bulkCreate([
      { id: "enc-a", props: { reason: "checkup" } },
    ]);
    await branchA.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-a",
        from: { kind: "Patient", id: "pat-anna" },
        to: { kind: "Encounter", id: "enc-a" },
        props: { on: "1974-03-09" },
      },
    ]);

    await branchB.store.nodes.Patient.bulkCreate([
      { id: "pat-ana", props: { name: "Ana Rivera", birthDate: "1974-03-09" } },
    ]);
    await branchB.store.nodes.Encounter.bulkCreate([
      { id: "enc-b", props: { reason: "referral" } },
    ]);
    await branchB.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-b",
        from: { kind: "Patient", id: "pat-ana" },
        to: { kind: "Encounter", id: "enc-b" },
        props: { on: "1974-03-09" },
      },
    ]);

    return { backend, base, branches: [branchA, branchB] };
  }

  /**
   * A base holding the Patient and Encounter both branches fork with, so every
   * `hadEncounter` edge they stage lands on the SAME committed endpoints and
   * therefore in one repoint fold set. With `withEdge` the joining edge is
   * committed too, so both branches INHERIT it instead of authoring it.
   */
  async function materializeSharedEndpoints(
    withEdge: boolean,
  ): Promise<Fixture> {
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    await base.nodes.Patient.bulkCreate([
      {
        id: COMMITTED_PATIENT,
        props: { name: "Nadia Okonkwo", birthDate: COMMITTED_BIRTH_DATE },
      },
    ]);
    await base.nodes.Encounter.bulkCreate([
      { id: COMMITTED_ENCOUNTER, props: { reason: "intake" } },
    ]);
    if (withEdge) {
      await base.edges.hadEncounter.bulkCreate([
        {
          id: SHARED_EDGE,
          from: { kind: "Patient", id: COMMITTED_PATIENT },
          to: { kind: "Encounter", id: COMMITTED_ENCOUNTER },
          props: { on: "2024-01-01" },
        },
      ]);
    }
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );
    return { backend, base, branches: [branchA, branchB] };
  }

  it("counts an edge id staged by two branches once per branch, not once per staged copy", async () => {
    cleanups = [];
    const { base, branches } = await materializeSharedEndpoints(false);
    const [branchA, branchB] = branches;

    // Both branches author the SAME caller-chosen edge id between the same
    // committed endpoints, so the fold set holds one member per branch and its
    // `mergedIds` names that id TWICE. Each member re-offers the id's full branch
    // set, so the recording loop sees all FOUR (branch, source) pairs though only
    // two contributions exist.
    for (const [contributor, on] of [
      [requireDefined(branchA), "2024-02-01"],
      [requireDefined(branchB), "2024-02-02"],
    ] as const) {
      await contributor.store.edges.hadEncounter.bulkCreate([
        {
          id: SHARED_EDGE,
          from: { kind: "Patient", id: COMMITTED_PATIENT },
          to: { kind: "Encounter", id: COMMITTED_ENCOUNTER },
          props: { on },
        },
      ]);
    }

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(true)),
    );
    expect(report.warnings).toEqual([]);

    // Read the sidecar back — the count is only meaningful against the rows that
    // actually landed, never against the report's own arithmetic.
    const persisted = await (
      await openProvenanceStore(base)
    ).nodes.Provenance.find();
    expect(new Set(persisted.map((node) => contributionOf(node))).size).toBe(
      persisted.length,
    );
    expect(report.provenancePersisted?.count).toBe(persisted.length);

    // Both branches are still credited: the collapse drops re-observations of one
    // contribution, never a second contributor.
    expect(edgeContributions(persisted)).toEqual([
      {
        branchId: BRANCH_A,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
      {
        branchId: BRANCH_B,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
    ]);
  });

  it("counts an inherited edge modified by two branches once per branch", async () => {
    cleanups = [];
    const { base, branches } = await materializeSharedEndpoints(true);
    const [branchA, branchB] = branches;

    // An inherited edge modification is observed TWICE: once as a surviving
    // delete/modify contribution (per branch) and again as the repoint fold's
    // source (for the branch reconcile kept). The reconcile winner is therefore
    // offered to the recording loop twice.
    await requireDefined(branchA).store.edges.hadEncounter.update(
      SHARED_EDGE_ID,
      {
        on: "2024-03-01",
      },
    );
    await requireDefined(branchB).store.edges.hadEncounter.update(
      SHARED_EDGE_ID,
      {
        on: "2024-03-02",
      },
    );

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(true)),
    );
    expect(report.warnings).toEqual([]);

    const persisted = await (
      await openProvenanceStore(base)
    ).nodes.Provenance.find();
    expect(new Set(persisted.map((node) => contributionOf(node))).size).toBe(
      persisted.length,
    );
    expect(report.provenancePersisted?.count).toBe(persisted.length);
    expect(edgeContributions(persisted)).toEqual([
      {
        branchId: BRANCH_A,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
      {
        branchId: BRANCH_B,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
    ]);
  });

  it("credits a lone branch's inherited-edge modification once, seen by two phases", async () => {
    cleanups = [];
    const { base, branches } = await materializeSharedEndpoints(true);
    const onlyBranch = requireDefined(branches[0]);

    // The MINIMAL trigger, and the one a single-contributor merge hits in ordinary
    // use: no second branch is needed for the same contribution to be observed
    // twice — delete/modify credits the modification, then the repoint fold reads
    // it as a source. One contribution, so one row and a count of one.
    await onlyBranch.store.edges.hadEncounter.update(SHARED_EDGE_ID, {
      on: "2024-04-04",
    });

    const report = unwrap(
      await merge<CareGraph>(base, [onlyBranch], provMergeOptions(true)),
    );
    expect(report.warnings).toEqual([]);

    const persisted = await (
      await openProvenanceStore(base)
    ).nodes.Provenance.find();
    expect(new Set(persisted.map((node) => contributionOf(node))).size).toBe(
      persisted.length,
    );
    expect(report.provenancePersisted?.count).toBe(persisted.length);
    expect(edgeContributions(persisted)).toEqual([
      {
        branchId: BRANCH_A,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
    ]);
  });

  it("collapses hash-identical records offered to persistProvenanceRecords directly", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    const provStore = await openProvenanceStore(base);

    // The exported helper takes ANY record list, so a caller reaching it without
    // going through a merge can offer one contribution twice as two objects. They
    // hash to a single id, and a `bulkUpsertById` batch cannot CREATE the same id
    // twice — so the helper must collapse them into the one row it reports rather
    // than throw on a sidecar that does not hold the row yet.
    const record = {
      role: "node",
      canonicalId: COMMITTED_PATIENT,
      canonicalKind: "Patient",
      branchId: BRANCH_A,
      sourceId: "pat-fork-local",
    } as const;
    const written = await persistProvenanceRecords(provStore, base.graphId, [
      record,
      { ...record },
    ]);

    expect(written).toBe(1);
    expect(await provStore.nodes.Provenance.find()).toHaveLength(1);
  });

  it("opens from a backend and graph id without the target GraphDef", async () => {
    cleanups = [];
    const { backend, base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const provStore = await openProvenanceStore(backend, base.graphId);
    expect(await provStore.nodes.Provenance.find()).not.toHaveLength(0);
  });

  it("persists {branch, sourceId} rows that match the report index", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const result = await merge<CareGraph>(
      base,
      branches,
      provMergeOptions(true),
    );
    expect(isOk(result)).toBe(true);
    const report = unwrap(result);

    // The report announces the sidecar graph + the row count.
    expect(report.provenancePersisted?.graphId).toBe(
      provenanceGraphId(base.graphId),
    );
    expect(report.provenancePersisted?.count).toBeGreaterThan(0);
    expect(report.warnings).toEqual([]);

    const provStore = await openProvenanceStore(base);

    // Every node id the in-memory index credits to a branch is persisted for it.
    for (const branchId of [BRANCH_A, BRANCH_B]) {
      const reported = report.provenance.byBranch(branchId);
      const persisted = await provStore.nodes.Provenance.find();
      const persistedNodeIds = new Set(
        persisted
          .filter((p) => p.branchId === branchId && p.role === "node")
          .map((p) => p.canonicalId),
      );
      for (const nodeId of reported.nodeIds) {
        expect(persistedNodeIds.has(nodeId)).toBe(true);
      }
    }
  });

  it("tags the resolved canonical with BOTH branches and keeps each source id", async () => {
    cleanups = [];
    const { base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const patients = await base.nodes.Patient.find();
    expect(patients).toHaveLength(1);
    const canonicalId = requireDefined(patients[0]).id;

    const provStore = await openProvenanceStore(base);
    const forCanonical = (await provStore.nodes.Provenance.find()).filter(
      (p) => p.canonicalId === canonicalId,
    );

    // Two contributions — one per branch — each keeping the fork-local source id.
    expect(new Set(forCanonical.map((p) => p.branchId))).toEqual(
      new Set([BRANCH_A, BRANCH_B]),
    );
    expect(new Set(forCanonical.map((p) => p.sourceId))).toEqual(
      new Set(["pat-anna", "pat-ana"]),
    );

    // Edges are tagged too.
    const edges = (await provStore.nodes.Provenance.find()).filter(
      (p) => p.role === "edge",
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent: re-persisting the same records upserts (no duplicates)", async () => {
    cleanups = [];
    const { base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const provStore = await openProvenanceStore(base);
    const firstCount = (await provStore.nodes.Provenance.find()).length;

    // Re-persist the SAME records (as a re-run would): deterministic ids → upsert.
    const records = (await provStore.nodes.Provenance.find()).map((p) => ({
      role: p.role,
      canonicalId: p.canonicalId,
      canonicalKind: p.canonicalKind,
      branchId: asBranchId(p.branchId),
      sourceId: p.sourceId,
    }));
    await persistProvenanceRecords(provStore, base.graphId, records);

    const secondCount = (await provStore.nodes.Provenance.find()).length;
    expect(secondCount).toBe(firstCount);
  });

  it("refuses a persistProvenance merge BEFORE committing when the sidecar id is occupied", async () => {
    cleanups = [];
    const { backend, base, branches } = await materialize();
    // The occupant is settled configuration: it is as true before the merge as
    // after it, and nothing the merge does changes it. Persisting provenance is
    // therefore an option this merge cannot honor, and the caller must learn
    // that instead of receiving a committed graph plus a warning that the
    // option it stated was quietly dropped.
    const applicationStore = createStore(
      defineGraph({
        id: provenanceGraphId(careGraph.id),
        nodes: { Patient: { type: Patient } },
        edges: {},
      }),
      backend,
    );
    await applicationStore.nodes.Patient.create(
      { name: "Existing", birthDate: "1970-01-01" },
      { id: "existing" },
    );

    const result = await merge<CareGraph>(
      base,
      branches,
      provMergeOptions(true),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.name).toBe("InvalidMergeOptionsError");
      expect(result.error.details).toMatchObject({
        option: "persistProvenance",
        graphId: provenanceGraphId(careGraph.id),
        provenanceErrorCode: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
      });
      expect(result.error.cause).toMatchObject({
        name: "ConfigurationError",
        details: { reason: "application-graph" },
      });
    }

    // Pre-commit: the target still holds nothing the branches staged, and the
    // occupant is untouched.
    expect(await base.nodes.Patient.find()).toHaveLength(0);
    expect(await base.nodes.Encounter.find()).toHaveLength(0);
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      applicationStore.nodes.Patient.getById("existing" as never),
    ).resolves.toMatchObject({ id: "existing" });
  });

  it("warns instead of failing when the post-commit provenance write fails", async () => {
    cleanups = [];
    const { backend, base, branches } = await materialize();
    const sidecarId = provenanceGraphId(careGraph.id);
    // Own the sidecar first, so the merge's PRE-COMMIT open takes the
    // already-owned path (reads only) and the only thing left to fail is the
    // row write itself.
    await openProvenanceStore(base);

    // A transient backend failure scoped to the sidecar's own row reads — the
    // class the post-commit path still tolerates by design: the graph is already
    // committed, provenance is derived and re-runnable, so this is a warning and
    // not a merge failure. Its counterpart, a CONFIGURATION verdict, can no
    // longer reach this branch: it was taken before the commit.
    const failing = backendFailingRowReadsFor(backend, sidecarId);
    const [guardedBase] = await createStoreWithSchema(careGraph, failing);

    const report = unwrap(
      await merge<CareGraph>(guardedBase, branches, provMergeOptions(true)),
    );

    // Committed: the merge itself is unaffected.
    expect(await guardedBase.nodes.Patient.find()).not.toHaveLength(0);
    expect(report.provenancePersisted).toBeUndefined();
    expect(
      report.warnings.some((warning) =>
        warning.startsWith("provenance persistence failed"),
      ),
    ).toBe(true);
    await expect(
      backend.countNodesByKind({ graphId: sidecarId, kind: "Provenance" }),
    ).resolves.toBe(0);
  });

  it("is OFF by default: no provenancePersisted, no rows", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(false)),
    );
    expect(report.provenancePersisted).toBeUndefined();

    const provStore = await openProvenanceStore(base);
    expect(await provStore.nodes.Provenance.find()).toHaveLength(0);
  });

  it("refuses an existing application graph at the sidecar id without modifying it", async () => {
    const backend = await makeBackend();
    const applicationGraph = defineGraph({
      id: provenanceGraphId(careGraph.id),
      nodes: { Patient: { type: Patient } },
      edges: {},
    });
    const [applicationStore] = await createStoreWithSchema(
      applicationGraph,
      backend,
    );
    await applicationStore.nodes.Patient.create(
      { name: "Existing", birthDate: "1970-01-01" },
      { id: "existing" },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION" },
    });
    await expect(
      applicationStore.nodes.Patient.getById("existing" as never),
    ).resolves.toMatchObject({ id: "existing", name: "Existing" });
  });

  it("refuses a SCHEMA-LESS application graph at the sidecar id without touching it", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const applicationGraph = defineGraph({
      id: provenanceGraphId(careGraph.id),
      nodes: { Patient: { type: Patient } },
      edges: {},
    });
    // Plain `createStore` — documented basic usage — registers NO schema row, so
    // the sidecar id reads as unregistered while holding application data. An
    // ownership decision keyed only on the active schema would register the
    // sidecar schema OVER this graph and write into its namespace.
    const applicationStore = createStore(applicationGraph, backend);
    await applicationStore.nodes.Patient.create(
      { name: "Existing", birthDate: "1970-01-01" },
      { id: "existing" },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });

    // Refused BEFORE any modification: no sidecar schema over the application's
    // graph id, no ownership marker, and its row untouched.
    await expect(
      backend.getActiveSchema(provenanceGraphId(careGraph.id)),
    ).resolves.toBeUndefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      applicationStore.nodes.Patient.getById("existing" as never),
    ).resolves.toMatchObject({ id: "existing", name: "Existing" });
  });

  it("refuses an unregistered id whose only rows are Provenance-kind", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // The one occupant a "rows this module could not have written" probe would
    // excuse. Freeness of an UNREGISTERED id is decided on ANY row, not on
    // foreign-looking ones: a plain `createStore` application holding
    // `Provenance` nodes at the sidecar id is still that application's graph,
    // even when its rows are byte-identical to ones this module would write.
    const applicationStore = createStore(legacyShapedGraph(), backend);
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await applicationStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: rowId },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });
    // Refused by the unfenced preflight, so nothing is registered and nothing
    // is claimed — the id is never adopted on the strength of its contents.
    await expect(
      backend.getActiveSchema(provenanceGraphId(careGraph.id)),
    ).resolves.toBeUndefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("refuses an unregistered id whose only rows are EDGE rows", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    // The sidecar graph declares no edges at all, so an edge row under its id
    // can only be an application's — and it is occupancy on its own, with no
    // node row beside it to make the id look taken.
    await backend.insertEdge({
      graphId: sidecarId,
      kind: "hadEncounter",
      id: "application-edge",
      fromKind: "Patient",
      fromId: "pat-application",
      toKind: "Encounter",
      toId: "enc-application",
      props: { on: "2024-02-02" },
    });

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });
    await expect(backend.getActiveSchema(sidecarId)).resolves.toBeUndefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      backend.getEdge(sidecarId, "application-edge"),
    ).resolves.toMatchObject({ id: "application-edge" });
  });

  it("refuses an unregistered id whose only rows are IDENTITY assertions", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    // Occupancy that lives in NEITHER entity table. Identity assertions — like
    // the recorded-time relations, the revision clock and origins, fulltext and
    // unique keys — carry a `graph_id` of their own, so an id can be an
    // application's while `typegraph_nodes` and `typegraph_edges` hold nothing
    // for it. A probe that looks only at those two reads this id as FREE and
    // claims it out from under the application that asserted the identity.
    // Written raw because the typed path would also register a schema, which is
    // a different (already covered) refusal.
    await requireDefined(backend.executeStatement)(
      asCompiledStatementSql(
        sql`
          INSERT INTO ${sql.identifier(identityAssertionsTable(backend))}
                        (graph_id, id, rel, a_kind, a_id, b_kind, b_id, valid_from, created_at, updated_at)
                      VALUES (${sidecarId}, ${"assertion-application"}, ${"sameAs"}, ${"Patient"}, ${"pat-left"}, ${"Patient"}, ${"pat-right"}, ${ASSERTION_INSTANT}, ${ASSERTION_INSTANT}, ${ASSERTION_INSTANT})
        `,
      ),
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });
    await expect(backend.getActiveSchema(sidecarId)).resolves.toBeUndefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      backend.execute(
        asCompiledRowsSql(
          sql`SELECT id FROM ${sql.identifier(identityAssertionsTable(backend))} WHERE graph_id = ${sidecarId}`,
        ),
      ),
    ).resolves.toHaveLength(1);
  });

  it("refuses an EMPTY application graph carrying neither sidecar schema", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // Registered, no rows, and a schema hash matching neither the owned nor the
    // pre-marker sidecar shape. Emptiness is evidence only for an id already
    // known to be sidecar-shaped; this one must read as an application graph
    // rather than fall through to the legacy sidecar's contents rules, whose
    // remediation ("drop this id, nothing is lost") would be wrong advice.
    await createStoreWithSchema(
      defineGraph({
        id: provenanceGraphId(careGraph.id),
        nodes: { Patient: { type: Patient } },
        edges: {},
      }),
      backend,
    );

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });
    expect((refusal as { suggestion?: string }).suggestion).toContain("Rename");
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("refuses an EMPTY exact-schema graph that carries no ownership marker", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // The state marker-first ordering makes UNREACHABLE for this module: the
    // current sidecar schema with no marker beside it. It used to be adopted as
    // "an interrupted creation, and empty anyway" — the admission path an
    // application graph walked straight through, because emptiness proves
    // nothing about authorship and an application Store already open on the id
    // keeps writing after the claim commits. The marker is now the first write,
    // so nothing this module does produces this state.
    await createStoreWithSchema(sidecarShapedGraph(), backend);

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unowned-exact-schema-graph",
      },
    });
    expect((refusal as { suggestion?: string }).suggestion).toContain(
      `Drop graph id "${provenanceGraphId(careGraph.id)}"`,
    );
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("refuses an exact-schema graph whose rows VERIFY but carry no marker", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // The other half of the old adoption rule, and the harder one: a row that
    // passes every contents proof this module has — live, valid for THIS target,
    // stored under the id its own props hash to. It is still not evidence of
    // authorship (any application can write it), so with no marker beside it the
    // id is refused rather than colonized.
    const [staged] = await createStoreWithSchema(sidecarShapedGraph(), backend);
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await staged.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: rowId },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unowned-exact-schema-graph",
      },
    });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      staged.nodes.Provenance.getById(rowId as never),
    ).resolves.toMatchObject({ id: rowId });
  });

  it("resumes a claim whose schema registration never committed", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);

    // The ONE interrupted-creation state the new ordering can leave: the fenced
    // claim committed the marker, and the schema registration that follows it
    // crashed. Manufactured through the real code path, not staged by hand, so
    // it also pins WHICH write goes first.
    await expect(
      openProvenanceStore(backendFailingSchemaCommit(backend), careGraph.id),
    ).rejects.toThrow(SCHEMA_COMMIT_CRASH);
    await expect(readOwnerMarker(backend)).resolves.toMatchObject({
      id: PROVENANCE_OWNER_ROW_ID,
    });
    await expect(backend.getActiveSchema(sidecarId)).resolves.toBeUndefined();

    // A valid live marker for this target IS the proof of ownership, so the
    // reopen finishes the creation instead of refusing a half-built sidecar.
    const resumed = await openProvenanceStore(backend, careGraph.id);
    await expect(backend.getActiveSchema(sidecarId)).resolves.toBeDefined();
    expect(
      await persistProvenanceRecords(resumed, careGraph.id, [SIDECAR_RECORD]),
    ).toBe(1);
    const reopened = await openProvenanceStore(backend, careGraph.id);
    expect(await reopened.nodes.Provenance.find()).toHaveLength(1);
  });

  it("resumes a legacy upgrade whose schema migration never committed", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: rowId },
    );
    const legacySchema = requireDefined(
      await backend.getActiveSchema(sidecarId),
    );

    // The upgrade has the same two-write window as a creation, in the same
    // order: the marker is claimed inside the fence that verified every
    // pre-marker row, and the migration to the current schema runs after it.
    await expect(
      openProvenanceStore(backendFailingSchemaCommit(backend), careGraph.id),
    ).rejects.toThrow(SCHEMA_COMMIT_CRASH);
    await expect(readOwnerMarker(backend)).resolves.toMatchObject({
      id: PROVENANCE_OWNER_ROW_ID,
    });
    await expect(backend.getActiveSchema(sidecarId)).resolves.toMatchObject({
      schema_hash: legacySchema.schema_hash,
    });

    const resumed = await openProvenanceStore(backend, careGraph.id);
    await expect(
      resumed.nodes.Provenance.getById(rowId as never),
    ).resolves.toMatchObject({ id: rowId, canonicalId: "canonical-resumed" });
    await expect(backend.getActiveSchema(sidecarId)).resolves.not.toMatchObject(
      {
        schema_hash: legacySchema.schema_hash,
      },
    );
  });

  it("keeps ownership when an application writes into the sidecar AFTER the claim", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    // The colonization the old adopt path allowed, replayed against the new
    // ordering. Before: an unmarked exact-schema graph whose contents verified
    // was adopted, so an application Store already open on that id went on
    // writing into a sidecar this module had claimed out from under it — and
    // every later open short-circuited on the marker and never re-litigated the
    // contents. Now the marker is committed BEFORE anything else, so a row that
    // lands afterwards was written into a graph that was already visibly owned:
    // the application is the intruder, ownership stands, and the operator has
    // one row — the marker — that says who the graph belongs to.
    await openProvenanceStore(backend, careGraph.id);
    await backend.insertNode({
      graphId: sidecarId,
      kind: "Provenance",
      id: "application-authored-row",
      props: {
        targetGraphId: careGraph.id,
        role: "node",
        canonicalId: "application-canonical",
        canonicalKind: "Patient",
        branchId: "application-branch",
        sourceId: "application-source",
      },
    });

    const reopened = await openProvenanceStore(backend, careGraph.id);
    expect(
      (await reopened.nodes.Provenance.find()).map((node) => node.id),
    ).toContain("application-authored-row");
    await expect(readOwnerMarker(backend)).resolves.toMatchObject({
      id: PROVENANCE_OWNER_ROW_ID,
    });
  });

  it("refuses an EMPTY pre-marker sidecar and says to drop that graph id", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // A real fleet state: the old persist path created the sidecar before
    // writing records, so a zero-record merge left an empty legacy sidecar.
    await createStoreWithSchema(legacyShapedGraph(), backend);

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "empty-legacy-sidecar",
      },
    });
    // The remediation must name dropping this id — renaming an application
    // graph is advice for a state this is not.
    expect((refusal as { suggestion?: string }).suggestion).toContain(
      `Drop graph id "${provenanceGraphId(careGraph.id)}"`,
    );
  });

  it("refuses a pre-marker sidecar whose rows do not recompute to their ids", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    // A row an older release could have written under an ambiguous id: valid
    // provenance props, but not the id the tuple hashes to today.
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: "prov_ambiguous-legacy-id" },
    );

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unupgradeable-legacy-sidecar",
      },
    });
    expect((refusal as { suggestion?: string }).suggestion).toContain(
      "drop it",
    );
    // Fail-closed: the unupgradeable sidecar is left exactly as it was.
    await expect(
      legacyStore.nodes.Provenance.getById("prov_ambiguous-legacy-id" as never),
    ).resolves.toMatchObject({ id: "prov_ambiguous-legacy-id" });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("refuses a pre-marker row that claims a DIFFERENT target under our id", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    // Everything about this row verifies EXCEPT whose provenance it is: it sits
    // under the exact id this target's own tuple hashes to, so the recomputed-id
    // proof alone would accept it and only the target check separates it from
    // one of ours.
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: "some-other-target", ...SIDECAR_RECORD },
      { id: rowId },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unupgradeable-legacy-sidecar",
      },
    });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      legacyStore.nodes.Provenance.getById(rowId as never),
    ).resolves.toMatchObject({ targetGraphId: "some-other-target" });
  });

  it("refuses a pre-marker sidecar whose only row is a TOMBSTONE", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: rowId },
    );
    await backend.deleteNode({
      graphId: sidecarId,
      kind: "Provenance",
      id: rowId,
    });

    // A soft-deleted row is not "no row". Upgrading around it would adopt a
    // sidecar holding a row the upgrade never verified, and the next
    // deterministic upsert would silently resurrect somebody's delete.
    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unupgradeable-legacy-sidecar",
      },
    });
    const tombstone = requireDefined(
      await backend.getNode(sidecarId, "Provenance", rowId),
    );
    expect(tombstone.deleted_at).toBeDefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("verifies EVERY page of a sidecar larger than one read page", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );

    // Two full read pages plus one row, with the single unverifiable row placed
    // so that no first page can contain it under ANY ordering the read might
    // use: its id is the median of the verified ids (out of reach of an id-ASC
    // and an id-DESC first page alike) and it is written in the middle of the
    // batch (out of reach of a created_at ordering). A loop that stops after one
    // page — or that drops its cursor and re-reads page one forever — therefore
    // never sees it, and would upgrade a sidecar it did not verify.
    const verified = await Promise.all(
      Array.from(
        { length: 2 * SIDECAR_PAGE_SIZE },
        async (_unused, index): Promise<SidecarRowInput> => {
          const record = { ...SIDECAR_RECORD, sourceId: `source-${index}` };
          return {
            id: await provenanceNodeId(careGraph.id, record),
            props: { targetGraphId: careGraph.id, ...record },
          };
        },
      ),
    );
    const sortedIds = verified
      .map((row) => row.id)
      .sort((left, right) =>
        left < right ? -1
        : left > right ? 1
        : 0,
      );
    // Same character set, one character longer: sorts immediately after the last
    // id of the first page and immediately before the first id of the second.
    const unverifiableId = `${requireDefined(sortedIds[SIDECAR_PAGE_SIZE - 1])}0`;
    const rows: SidecarRowInput[] = [...verified];
    rows.splice(SIDECAR_PAGE_SIZE, 0, {
      id: unverifiableId,
      props: { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
    });
    await legacyStore.nodes.Provenance.bulkCreate(rows);

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unupgradeable-legacy-sidecar",
      },
    });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  }, 30_000);

  it("refuses an exact-schema application graph without the internal owner marker", async () => {
    const backend = await makeBackend();
    const applicationGraph = sidecarShapedGraph();
    const [applicationStore] = await createStoreWithSchema(
      applicationGraph,
      backend,
    );
    await applicationStore.nodes.Provenance.create(
      {
        targetGraphId: careGraph.id,
        role: "node",
        canonicalId: "application-canonical",
        canonicalKind: "Patient",
        branchId: "application-branch",
        sourceId: "application-source",
      },
      { id: "application-owned-row" },
    );

    // `unowned-exact-schema-graph` is reachable ONLY on the branch where the
    // active schema hash EQUALS the sidecar's and the marker is missing, so the
    // discriminant pins this test to the missing-marker branch rather than to
    // any hash mismatch. Rows this library plainly did not write are the
    // OBVIOUS case; the empty and the verifying ones above are the same refusal
    // reached without any help from the contents.
    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unowned-exact-schema-graph",
      },
    });
    await expect(
      applicationStore.nodes.Provenance.getById(
        "application-owned-row" as never,
      ),
    ).resolves.toMatchObject({ id: "application-owned-row" });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("upgrades a populated legacy sidecar and preserves its contributions", async () => {
    const backend = await makeBackend();
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    const legacyRecord = {
      role: "node",
      canonicalId: "legacy-canonical",
      canonicalKind: "Patient",
      branchId: BRANCH_A,
      sourceId: "legacy-source",
    } as const;
    const legacyId = await provenanceNodeId(careGraph.id, legacyRecord);
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...legacyRecord },
      { id: legacyId },
    );

    const upgraded = await openProvenanceStore(backend, careGraph.id);
    await expect(
      upgraded.nodes.Provenance.getById(legacyId as never),
    ).resolves.toMatchObject({
      id: legacyId,
      canonicalId: "legacy-canonical",
      sourceId: "legacy-source",
    });

    // A second open must use the durable marker written by the upgrade rather
    // than falling back to the legacy schema/content recognition path.
    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).resolves.toBeDefined();
  });

  it("claims a FREE id inside the schema fence, before registering the schema", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    const counted = countingFenceBackend(backend);

    await expect(
      openProvenanceStore(counted.backend, careGraph.id),
    ).resolves.toBeDefined();

    // One fence, holding the freeness re-check and the marker write together —
    // the only reason claiming an id read as free a moment earlier is sound.
    expect(counted.fenceCount()).toBe(1);
    const marker = requireDefined(await readOwnerMarker(backend));
    expect(marker.deleted_at).toBeUndefined();
    // The fenced claim writes through the backend's insert primitive, so the row
    // must still be exactly what a Store write would have produced.
    expect(parseRowProps(marker.props)).toEqual(OWNER_MARKER_PROPS);
    // The schema lands after the marker, on an id the marker already owns.
    await expect(backend.getActiveSchema(sidecarId)).resolves.toBeDefined();
  });

  it("drains unfenced row writers inside the claim, before its re-inspection", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const recording = backendRecordingFencedSql(backend);

    await expect(
      openProvenanceStore(recording.backend, careGraph.id),
    ).resolves.toBeDefined();

    const statements = recording.statements();
    const lockIndex = statements.findIndex((statement) =>
      statement.includes("LOCK TABLE"),
    );
    const probeIndex = statements.findIndex((statement) =>
      statement.includes("present"),
    );
    expect(probeIndex).toBeGreaterThanOrEqual(0);
    if (backend.dialect === "postgres") {
      // The one exclusion that reaches a writer taking NEITHER the per-graph
      // advisory lock nor the schema row — a schema-less raw `createStore`
      // insert. It must precede the probe: a drain after the read it authorizes
      // protects nothing.
      expect(lockIndex).toBeGreaterThanOrEqual(0);
      expect(lockIndex).toBeLessThan(probeIndex);
      const lockStatement = requireDefined(statements[lockIndex]);
      // SELF-exclusive by design: plain SHARE would let two concurrent claims
      // both hold it and then deadlock upgrading to ROW EXCLUSIVE for their own
      // marker INSERT.
      expect(lockStatement).toContain("IN SHARE ROW EXCLUSIVE MODE");
      expect(lockStatement).toContain(
        createSqlSchema(backend.tableNames).tables.nodes,
      );
      expect(lockStatement).toContain(
        createSqlSchema(backend.tableNames).tables.edges,
      );
    } else {
      // SQLite takes no relation lock: `BEGIN IMMEDIATE` already owns the
      // engine's single writer slot, so the drain is complete before the fence's
      // callback runs.
      expect(lockIndex).toBe(-1);
    }

    // And not at all on the common path: an already-owned sidecar opens with no
    // fence, so no writer anywhere is ever blocked by a routine open.
    const reopened = backendRecordingFencedSql(backend);
    await expect(
      openProvenanceStore(reopened.backend, careGraph.id),
    ).resolves.toBeDefined();
    expect(reopened.statements()).toEqual([]);
  });

  it("refuses and writes NOTHING when a row lands between the preflight and the claim", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    const racing = backendRacingTheClaim(backend, async () => {
      await backend.insertNode({
        graphId: sidecarId,
        kind: "Patient",
        id: "app-row-mid-claim",
        props: { name: "Late Arrival", birthDate: "1980-05-05" },
      });
    });

    // The preflight saw a free id and would have claimed it. The claim
    // re-verifies inside its fence, sees the row that arrived, and refuses.
    await expect(
      openProvenanceStore(racing, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });

    // The residue this test used to document is GONE, which is the point of the
    // ordering: because the claim is the open's FIRST write, a lost race leaves
    // the occupant byte-identical — no sidecar schema registered over its graph
    // id, no ownership marker, no provenance row — instead of leaving the
    // sidecar schema ACTIVE on a graph this module does not own.
    await expect(backend.getActiveSchema(sidecarId)).resolves.toBeUndefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      backend.countNodesByKind({ graphId: sidecarId, kind: "Provenance" }),
    ).resolves.toBe(0);
    await expect(
      backend.getNode(sidecarId, "Patient", "app-row-mid-claim"),
    ).resolves.toMatchObject({ id: "app-row-mid-claim" });
  });

  it("writes no second marker when a racing opener claims the id first", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    // The one state the FENCED re-inspection can reach that is neither a refusal
    // nor an unclaimed id: a concurrent opener committed a valid marker between
    // this open's preflight (which saw a free id) and its fence. That marker is
    // the same durable claim this open would have made, so the claim must write
    // nothing at all — a second insert under the canonical marker id is either a
    // constraint violation or an overwrite of a row this open did not author.
    const racing = backendRacingTheClaim(backend, async () => {
      await backend.insertNode({
        graphId: sidecarId,
        kind: "ProvenanceOwner",
        id: PROVENANCE_OWNER_ROW_ID,
        props: { ...OWNER_MARKER_PROPS },
      });
    });

    await expect(
      openProvenanceStore(racing, careGraph.id),
    ).resolves.toBeDefined();

    const marker = requireDefined(await readOwnerMarker(backend));
    expect(parseRowProps(marker.props)).toEqual(OWNER_MARKER_PROPS);
    // Untouched: still the racer's row, at its insert version and timestamp.
    expect(marker.version).toBe(1);
    expect(marker.updated_at).toBe(marker.created_at);
    await expect(
      backend.countNodesByKind({ graphId: sidecarId, kind: "ProvenanceOwner" }),
    ).resolves.toBe(1);
  });

  it("refuses a TOMBSTONED ownership marker instead of resurrecting it", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [staged] = await createStoreWithSchema(sidecarShapedGraph(), backend);
    await staged.nodes.ProvenanceOwner.create(OWNER_MARKER_PROPS, {
      id: PROVENANCE_OWNER_ROW_ID,
    });
    await backend.deleteNode({
      graphId: provenanceGraphId(careGraph.id),
      kind: "ProvenanceOwner",
      id: PROVENANCE_OWNER_ROW_ID,
    });
    const tombstone = requireDefined(await readOwnerMarker(backend));
    expect(tombstone.deleted_at).toBeDefined();

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "corrupt-ownership-marker",
      },
    });
    // A corrupt marker is not a colliding application graph, so the remediation
    // must not tell the operator to rename one.
    expect((refusal as { suggestion?: string }).suggestion).not.toContain(
      "Rename",
    );

    // Unchanged: not resurrected (`deleted_at` intact) and not rewritten.
    const after = requireDefined(await readOwnerMarker(backend));
    expect(after.deleted_at).toBe(tombstone.deleted_at);
    expect(after.version).toBe(tombstone.version);
    expect(after.updated_at).toBe(tombstone.updated_at);
  });

  it("refuses an ownership marker that claims a DIFFERENT target graph", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [staged] = await createStoreWithSchema(sidecarShapedGraph(), backend);
    // Valid marker shape, wrong claim: it says the sidecar belongs to another
    // target's provenance, so this target may not write into it.
    await staged.nodes.ProvenanceOwner.create(
      { ...OWNER_MARKER_PROPS, targetGraphId: "some-other-target" },
      { id: PROVENANCE_OWNER_ROW_ID },
    );
    const before = requireDefined(await readOwnerMarker(backend));

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "corrupt-ownership-marker",
      },
    });
    const after = requireDefined(await readOwnerMarker(backend));
    expect(parseRowProps(after.props)).toEqual({
      ...OWNER_MARKER_PROPS,
      targetGraphId: "some-other-target",
    });
    expect(after.version).toBe(before.version);
  });

  it("refuses a MALFORMED ownership marker instead of overwriting it", async () => {
    cleanups = [];
    const backend = await makeBackend();
    await createStoreWithSchema(sidecarShapedGraph(), backend);
    // Written through the raw seam because no typed Store write can produce it:
    // the marker id occupied by props that do not validate as a claim at all.
    await backend.insertNode({
      graphId: provenanceGraphId(careGraph.id),
      kind: "ProvenanceOwner",
      id: PROVENANCE_OWNER_ROW_ID,
      props: { owner: "someone-elses-library", version: 99 },
    });
    const before = requireDefined(await readOwnerMarker(backend));

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "corrupt-ownership-marker",
      },
    });
    const after = requireDefined(await readOwnerMarker(backend));
    expect(parseRowProps(after.props)).toEqual({
      owner: "someone-elses-library",
      version: 99,
    });
    expect(after.version).toBe(before.version);
  });

  it("refuses an EXTRA owner row under a non-canonical id", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [staged] = await createStoreWithSchema(sidecarShapedGraph(), backend);
    await staged.nodes.ProvenanceOwner.create(OWNER_MARKER_PROPS, {
      id: PROVENANCE_OWNER_ROW_ID,
    });
    // A second claim row this module never writes. Ownership is the ONE canonical
    // row and nothing beside it: an unaccounted-for owner row is occupancy even
    // when the canonical marker beside it verifies.
    await backend.insertNode({
      graphId: provenanceGraphId(careGraph.id),
      kind: "ProvenanceOwner",
      id: "rogue-owner",
      props: OWNER_MARKER_PROPS,
    });

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "corrupt-ownership-marker",
      },
    });
    await expect(
      backend.getNode(
        provenanceGraphId(careGraph.id),
        "ProvenanceOwner",
        "rogue-owner",
      ),
    ).resolves.toMatchObject({ id: "rogue-owner" });
  });

  it("refuses to claim an unclaimed sidecar on a backend with no schema fence", async () => {
    cleanups = [];
    const backend = await makeBackend();

    // The claim cannot be made atomic here, so it is refused rather than run as
    // a check-then-write. The refusal names the missing capability, not a
    // collision: the graph id itself is free.
    await expect(
      openProvenanceStore(backendWithoutSchemaFence(backend), careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED" },
    });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    // The refusal costs the id nothing either: the claim comes before the schema
    // registration, so a backend that cannot fence it registers no schema.
    await expect(
      backend.getActiveSchema(provenanceGraphId(careGraph.id)),
    ).resolves.toBeUndefined();

    // An ALREADY-owned sidecar needs no claim, so it still opens unfenced.
    await openProvenanceStore(backend, careGraph.id);
    await expect(
      openProvenanceStore(backendWithoutSchemaFence(backend), careGraph.id),
    ).resolves.toBeDefined();
  });

  it("leaves a pre-marker sidecar unmigrated and unmarked when its upgrade loses the race", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const sidecarId = provenanceGraphId(careGraph.id);
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: rowId },
    );
    const before = requireDefined(await backend.getActiveSchema(sidecarId));
    const racing = backendRacingTheClaim(backend, async () => {
      await backend.insertNode({
        graphId: sidecarId,
        kind: "Patient",
        id: "app-row-mid-upgrade",
        props: { name: "Late Arrival", birthDate: "1980-05-05" },
      });
    });

    await expect(
      openProvenanceStore(racing, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });

    // The legacy upgrade is a claim like any other, and it is ordered the same
    // way: the marker commits inside the fence that verified the pre-marker
    // rows, and the migration to the current schema runs only afterwards. A lost
    // upgrade race therefore leaves the occupant exactly as it was — still on
    // the pre-marker schema version, unmarked, its rows untouched.
    const after = requireDefined(await backend.getActiveSchema(sidecarId));
    expect(after.schema_hash).toBe(before.schema_hash);
    expect(after.version).toBe(before.version);
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      legacyStore.nodes.Provenance.getById(rowId as never),
    ).resolves.toMatchObject({ id: rowId });
  });
});

describe("provenance row identity", () => {
  const record = {
    role: "node",
    canonicalId: "pat-canonical",
    canonicalKind: "Patient",
    branchId: BRANCH_A,
    sourceId: "pat-fork",
  } as const;

  it("preserves application graph ids that predate the sidecar convention", () => {
    expect(
      defineGraph({
        id: provenanceGraphId("care-graph"),
        nodes: { Patient: { type: Patient } },
        edges: {},
      }).id,
    ).toBe("care-graph::merge-provenance");
  });

  it("hashes a contribution to a stable id across versions", async () => {
    // Pinned as a literal because the id is a CROSS-VERSION contract: rows in a
    // sidecar written by an earlier release are re-upserted rather than orphaned
    // and duplicated only while the same contribution keeps hashing to this id.
    expect(await provenanceNodeId("care-graph", record)).toBe(
      "prov_4d724f22030e40e5603682bd44f6ca0d",
    );
  });

  it("keeps every identifying field in the key collapses are keyed on", () => {
    // A key NARROWER than the row identity would silently merge two genuinely
    // distinct contributions, which is the one way a collapse can lose data.
    const keys = new Set([
      contributionKey(record),
      contributionKey({ ...record, role: "edge" }),
      contributionKey({ ...record, canonicalKind: "Encounter" }),
      contributionKey({ ...record, canonicalId: "other-canonical" }),
      contributionKey({ ...record, branchId: BRANCH_B }),
      contributionKey({ ...record, sourceId: "other-fork" }),
    ]);
    expect(keys.size).toBe(6);
  });

  it("does not collapse contributions when a NUL moves between fields", async () => {
    const left = {
      ...record,
      canonicalId: "canonical\0branch",
      branchId: asBranchId("source"),
    };
    const right = {
      ...record,
      canonicalId: "canonical",
      branchId: asBranchId("branch\0source"),
    };

    expect(contributionKey(left)).not.toBe(contributionKey(right));
    expect(await provenanceNodeId("care-graph", left)).not.toBe(
      await provenanceNodeId("care-graph", right),
    );
  });
});

/**
 * The per-graph write fence around constrained writes, on a REAL Postgres
 * engine (PGlite, in-process, no Docker).
 *
 * What is under test is an ORDERING and a COST, not an outcome: every
 * constraint here is already enforced correctly by a single writer, so a
 * functional assertion cannot tell a fenced write from an unfenced one. What
 * distinguishes them is whether `pg_advisory_xact_lock('typegraph:
 * recorded-graph-write', graph)` is taken inside the write transaction BEFORE
 * the probe it protects — which is exactly what a default PostgreSQL store did
 * not do, leaving cardinality, shared-scope uniqueness, disjointness, and
 * `getOrCreateByEndpoints` convergence as probes two writers could both pass.
 *
 * PGlite is single-connection and serial, so a genuine two-writer race is NOT
 * constructible here (see `tests/backends/postgres/schema-write-fence-race.
 * test.ts`, which needs server Postgres for the same reason). These assertions
 * are therefore about the fence's presence, its placement relative to the probe,
 * and — just as load-bearing — its ABSENCE on writes that declare no constraint,
 * so the fix cannot be "lock everything".
 *
 * Statements are captured through the shared `tests/statement-recorder.ts`
 * harness (drizzle's `logger`, matching
 * `backends/postgres/recorded-lock-churn.test.ts`): it sees every statement,
 * including ones a backend-method Proxy would miss.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  subClassOf,
} from "../src";
import { buildKindRegistry } from "../src/registry";
import {
  CONSTRAINT_FENCE_BACKING,
  CONSTRAINT_FENCE_REASONS,
} from "../src/store/claims/backing";
import { nodeClaimSites } from "../src/store/claims/sites";
import { nodeWriteNeedsConstraintFence } from "../src/store/constraints";
import {
  createRecordedPostgresStore,
  type LoggedStatement,
} from "./statement-recorder";

const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

/**
 * A hierarchy with a SHARED-SCOPE unique: the probe walks root + descendants
 * while `insertUnique` reserves one row under the node's own kind, so sibling
 * kinds are distinct primary-key rows that can never collide (#436 item 1).
 */
const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string(), name: z.string() }),
});

/** A same-kind unique: the uniques primary key IS the fence, so none is taken. */
const Account = defineNode("Account", {
  schema: z.object({ email: z.string() }),
});

const Team = defineNode("Team", {
  schema: z.object({ name: z.string() }),
});

/** Cardinality `many`: declares nothing, so its create probes nothing. */
const knows = defineEdge("knows", { schema: z.object({}) });
/** Cardinality `one`: an application count probe no database key repeats. */
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const SHARED_SCOPE_UNIQUE = {
  name: "shared_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const graph = defineGraph({
  id: "constraint_write_fence",
  nodes: {
    Person: { type: Person },
    Team: { type: Team },
    Worker: { type: Worker, unique: [SHARED_SCOPE_UNIQUE] },
    Employee: { type: Employee, unique: [SHARED_SCOPE_UNIQUE] },
    Contractor: { type: Contractor, unique: [SHARED_SCOPE_UNIQUE] },
    Account: {
      type: Account,
      unique: [
        {
          name: "own_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    reportsTo: {
      type: reportsTo,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(Employee, Worker),
    subClassOf(Contractor, Worker),
    disjointWith(Person, Team),
  ],
});

function createLoggedStore(): ReturnType<
  typeof createRecordedPostgresStore<typeof graph>
> {
  return createRecordedPostgresStore(graph);
}

function graphWriteLockIndex(statements: readonly LoggedStatement[]): number {
  return statements.findIndex(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === GRAPH_WRITE_NAMESPACE,
  );
}

function graphWriteLockCount(statements: readonly LoggedStatement[]): number {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === GRAPH_WRITE_NAMESPACE,
  ).length;
}

function claimIndexes(statements: readonly LoggedStatement[]): number[] {
  return statements.flatMap((statement, index) =>
    /insert into "typegraph_node_uniques"/iu.test(statement.query) ?
      [index]
    : [],
  );
}

function nodeInsertIndex(statements: readonly LoggedStatement[]): number {
  return statements.findIndex((statement) =>
    /insert into "typegraph_nodes"/iu.test(statement.query),
  );
}

function firstIndexMatching(
  statements: readonly LoggedStatement[],
  needle: string,
): number {
  return statements.findIndex((statement) => statement.query.includes(needle));
}

describe("constrained writes take the per-graph write fence", () => {
  it("fences a constrained edge create and orders the lock before its guarded claim", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    reset();
    await store.edges.reportsTo.create(alice, bob, {});

    expect(graphWriteLockCount(statements)).toBe(1);
    // The guarded claim and edge insert now share one statement. That fused
    // statement must sit after the lock, or its verdict was computed outside
    // the exclusion it depends on.
    const lockIndex = graphWriteLockIndex(statements);
    const claimIndex = firstIndexMatching(
      statements,
      'INSERT INTO "typegraph_edge_claims"',
    );
    const insertIndex = firstIndexMatching(
      statements,
      'INSERT INTO "typegraph_edges"',
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBe(claimIndex);
  });

  it("does NOT fence an edge create with cardinality many", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    reset();
    await store.edges.knows.create(alice, bob, {});

    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("fences getOrCreateByEndpoints even at cardinality many, because it converges on a match key", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    reset();
    const created = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      {},
    );
    expect(created.action).toBe("created");
    expect(graphWriteLockCount(statements)).toBe(1);

    // The found fast path performs no write, so it must not pay for the fence.
    reset();
    const found = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      {},
    );
    expect(found.action).toBe("found");
    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("fences bulkGetOrCreateByEndpoints once for the whole batch", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const carol = await store.nodes.Person.create({ name: "Carol" });

    reset();
    const results = await store.edges.knows.bulkGetOrCreateByEndpoints([
      { from: alice, to: bob, props: {} },
      { from: alice, to: carol, props: {} },
    ]);

    expect(results.map((result) => result.action)).toEqual([
      "created",
      "created",
    ]);
    // One transaction, one lock: the nested create batch must not re-acquire
    // what the enclosing frame already holds.
    expect(graphWriteLockCount(statements)).toBe(1);
  });

  it("fences a node create whose uniqueness scope spans sibling kinds", async () => {
    const { store, statements, reset } = await createLoggedStore();

    reset();
    await store.nodes.Employee.create({ email: "x@example.com", name: "E" });

    expect(graphWriteLockCount(statements)).toBe(1);
    const lockIndex = graphWriteLockIndex(statements);
    const probeIndex = firstIndexMatching(statements, "typegraph_node_uniques");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(lockIndex);
  });

  it("does NOT fence a node create whose unique is scoped to its own kind", async () => {
    const { store, statements, reset } = await createLoggedStore();

    reset();
    await store.nodes.Account.create({ email: "own@example.com" });

    // The probe reads exactly the `(graph, kind, constraint, key)` row the
    // insert then reserves, so the uniques primary key is the fence.
    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("fences a node create whose kind participates in a disjointness axiom", async () => {
    const { store, statements, reset } = await createLoggedStore();

    reset();
    await store.nodes.Person.create({ name: "Alice" }, { id: "shared-id" });

    expect(graphWriteLockCount(statements)).toBe(1);
    // Ordered against the PROBE, not just the INSERT — as in the two sibling
    // cases above. A fence taken after the cross-kind probe would still precede
    // the INSERT while leaving the verdict computed outside the exclusion it
    // depends on, which is the whole defect; asserting only INSERT ordering
    // would let that mutation live.
    const lockIndex = graphWriteLockIndex(statements);
    const probeIndex = firstIndexMatching(statements, "typegraph_nodes");
    const insertIndex = firstIndexMatching(statements, "INSERT INTO");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(probeIndex);
  });

  it("fences a shared-scope node UPDATE but not a delete", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const employee = await store.nodes.Employee.create({
      email: "u@example.com",
      name: "E",
    });

    reset();
    await store.nodes.Employee.update(employee.id, {
      email: "u2@example.com",
    });
    expect(graphWriteLockCount(statements)).toBe(1);

    // A delete RELEASES uniqueness entries; it re-derives no cross-kind verdict
    // and so declares no fence.
    reset();
    await store.nodes.Employee.delete(employee.id);
    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("still refuses the sibling-kind duplicate the fence exists to serialize", async () => {
    const { store } = await createLoggedStore();
    await store.nodes.Employee.create({ email: "dup@example.com", name: "E" });

    await expect(
      store.nodes.Contractor.create({ email: "dup@example.com", name: "C" }),
    ).rejects.toThrow(/Uniqueness/u);
  });

  it("still refuses the disjoint-kind duplicate id the fence exists to serialize", async () => {
    const { store } = await createLoggedStore();
    await store.nodes.Person.create({ name: "Alice" }, { id: "shared-id" });

    await expect(
      store.nodes.Team.create({ name: "Team" }, { id: "shared-id" }),
    ).rejects.toThrow(/[Dd]isjoint/u);
  });

  it("still refuses the second cardinality-one edge the fence exists to serialize", async () => {
    const { store } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const carol = await store.nodes.Person.create({ name: "Carol" });

    await store.edges.reportsTo.create(alice, bob, {});
    await expect(
      store.edges.reportsTo.create(alice, carol, {}),
    ).rejects.toThrow(/[Cc]ardinality/u);
  });
});

/**
 * The lock's trigger set is a PROJECTION of the claim sites now, so the
 * classification it reads is the same one the claim seam writes from. That
 * makes a table over the kind shapes the ratchet: if the projection ever
 * reports a different class — or reports one for a shape that took no lock —
 * the change is visible here rather than in whichever write path noticed first.
 */
describe("the lock reason survives its re-derivation from the claim sites", () => {
  const OWN_EMAIL_UNIQUE = {
    name: "own_email",
    fields: ["email"],
    scope: "kind",
    collation: "binary",
  } as const;

  const Plain = defineNode("Plain", { schema: z.object({ name: z.string() }) });
  const Solo = defineNode("Solo", { schema: z.object({ email: z.string() }) });
  const Partner = defineNode("Partner", {
    schema: z.object({ name: z.string() }),
  });
  const Rival = defineNode("Rival", { schema: z.object({ name: z.string() }) });
  const Staff = defineNode("Staff", {
    schema: z.object({ email: z.string() }),
  });
  const Crew = defineNode("Crew", { schema: z.object({ email: z.string() }) });
  const Guild = defineNode("Guild", {
    schema: z.object({ email: z.string() }),
  });
  const Rider = defineNode("Rider", {
    schema: z.object({ email: z.string() }),
  });
  const Nomad = defineNode("Nomad", { schema: z.object({ name: z.string() }) });

  const shapeGraph = defineGraph({
    id: "constraint_fence_reason_shapes",
    nodes: {
      // No constraints at all.
      Plain: { type: Plain },
      // Only a `scope: "kind"` unique — its own key is the fence.
      Solo: { type: Solo, unique: [OWN_EMAIL_UNIQUE] },
      // A disjoint partner and nothing else.
      Partner: { type: Partner },
      Rival: { type: Rival },
      // A scope spanning sibling kinds.
      Staff: { type: Staff, unique: [SHARED_SCOPE_UNIQUE] },
      Crew: { type: Crew, unique: [SHARED_SCOPE_UNIQUE] },
      Guild: { type: Guild, unique: [SHARED_SCOPE_UNIQUE] },
      // Both at once: the shape that decides which class is reported.
      Rider: { type: Rider, unique: [SHARED_SCOPE_UNIQUE] },
      Nomad: { type: Nomad },
    },
    edges: {},
    ontology: [
      subClassOf(Crew, Staff),
      subClassOf(Guild, Staff),
      subClassOf(Rider, Staff),
      disjointWith(Partner, Rival),
      disjointWith(Rider, Nomad),
    ],
  });

  const shapeRegistry = buildKindRegistry(shapeGraph);

  const SHAPES = [
    {
      kind: "Plain",
      unique: [],
      create: undefined,
      update: undefined,
      createPlacements: [],
      updatePlacements: [],
    },
    {
      kind: "Solo",
      unique: [OWN_EMAIL_UNIQUE],
      create: undefined,
      update: undefined,
      // The pair the non-transactional refusal turns on: its create claim
      // follows the row, its update claim precedes one.
      createPlacements: ["uniqueness:post-insert"],
      updatePlacements: ["uniqueness:pre-insert"],
    },
    {
      kind: "Partner",
      unique: [],
      create: "nodeDisjointness",
      update: undefined,
      // A disjoint create owes a claim although its kind declares no constraint
      // of its own: the nodes primary key is `(graph_id, kind, id)`, so nothing
      // but that claim can refuse a namesake under the partner kind. Its update
      // owes none — an in-place update cannot change a node's kind.
      createPlacements: ["disjointness:pre-insert"],
      updatePlacements: [],
    },
    {
      kind: "Crew",
      unique: [SHARED_SCOPE_UNIQUE],
      create: "nodeUniquenessScope",
      update: "nodeUniquenessScope",
      createPlacements: ["uniqueness:pre-insert"],
      updatePlacements: ["uniqueness:pre-insert"],
    },
    // Disjointness is scanned FIRST, so a kind qualifying on both counts keeps
    // naming the class the refusal payload names today — and its create owes
    // TWO claims, one per family, both ahead of the row.
    {
      kind: "Rider",
      unique: [SHARED_SCOPE_UNIQUE],
      create: "nodeDisjointness",
      update: "nodeUniquenessScope",
      createPlacements: ["disjointness:pre-insert", "uniqueness:pre-insert"],
      updatePlacements: ["uniqueness:pre-insert"],
    },
  ] as const;

  function reasonFor(
    shape: (typeof SHAPES)[number],
    operation: "create" | "update",
  ) {
    return nodeWriteNeedsConstraintFence(
      shapeRegistry,
      shape.kind,
      shape.unique,
      operation,
    );
  }

  function placementsFor(
    shape: (typeof SHAPES)[number],
    operation: "create" | "update",
  ) {
    // The FAMILY is in the reading too, so the table pins which site is which
    // and in what order they are scanned — not merely how many there are.
    return nodeClaimSites(
      shapeRegistry,
      shape.kind,
      shape.unique,
      operation,
    ).map((site) => `${site.refusal.kind}:${site.placement}`);
  }

  for (const shape of SHAPES) {
    it(`reports ${shape.create ?? "no"} fence for a ${shape.kind} create and ${shape.update ?? "no"} fence for its update`, () => {
      expect(reasonFor(shape, "create")).toBe(shape.create);
      expect(reasonFor(shape, "update")).toBe(shape.update);
    });

    // The two readings of the one cross-kind fact, pinned side by side: a
    // change to either is visible in one diff, and a future family that breaks
    // their coincidence has to say which one it moved.
    it(`places a ${shape.kind} create's claims ${shape.createPlacements.join(", ") || "nowhere"} and its update's ${shape.updatePlacements.join(", ") || "nowhere"}`, () => {
      expect(placementsFor(shape, "create")).toEqual(shape.createPlacements);
      expect(placementsFor(shape, "update")).toEqual(shape.updatePlacements);
    });
  }

  it("only ever names a fence class the backing table knows, and never the claim-only one", () => {
    for (const shape of SHAPES) {
      for (const operation of ["create", "update"] as const) {
        const reason = reasonFor(shape, operation);
        if (reason === undefined) continue;
        expect(CONSTRAINT_FENCE_REASONS).toContain(reason);
        expect(CONSTRAINT_FENCE_BACKING[reason]).toBeDefined();
        // The ratchet on the split: `nodeUniquenessClaim` exists for the
        // non-transactional refusal only. Returning it here would silently
        // widen the set of writes that take the per-graph lock, which is the
        // one thing this workstream promises not to move.
        expect(reason).not.toBe("nodeUniquenessClaim");
      }
    }
  });

  it("declares a backing for every fence class, with each family naming its own relation", () => {
    for (const reason of CONSTRAINT_FENCE_REASONS) {
      expect(CONSTRAINT_FENCE_BACKING[reason]).toBeDefined();
    }
    expect(CONSTRAINT_FENCE_BACKING.nodeUniquenessScope).toBe("uniques");
    // Disjointness reserves in the same relation, at the declared PAIR's axis
    // with the node's id as the key — so it is no longer fenced by the
    // per-graph lock alone, and the table has to say so or a reader infers the
    // opposite from the one place this is written down.
    expect(CONSTRAINT_FENCE_BACKING.nodeDisjointness).toBe("uniques");
    // Edge cardinality reserves in its OWN relation, keyed on
    // `(<cardinality>:<edgeKind>, endpoint identity)` — the axis the
    // declaration spans and the one the edges primary key cannot fence. Left at
    // `lockOnly` a reader would conclude from the one place this is written
    // down that a lock-free import writes constrained edges unfenced.
    expect(CONSTRAINT_FENCE_BACKING.edgeCardinality).toBe("edgeClaims");
    // The convergence key can include `matchOn` prop values, so no relation can
    // key it: still the lock alone, and stated as such.
    expect(CONSTRAINT_FENCE_BACKING.edgeMatchKeyConvergence).toBe("lockOnly");
  });

  it("takes no lock for a kind-scoped node UPDATE either, not just its create", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const account = await store.nodes.Account.create({
      email: "solo@example.com",
    });

    reset();
    await store.nodes.Account.update(account.id, {
      email: "solo2@example.com",
    });

    expect(graphWriteLockCount(statements)).toBe(0);
  });
});

/**
 * WHERE each claim statement sits relative to the row it gates, recorded rather
 * than assumed.
 *
 * Placement is the one fact that decides three things at once — the emitted
 * statement order, whether a non-transactional backend refuses the write, and
 * how much of another workstream's statement-order oracle moves — so it is
 * pinned where it is observable: in the statements the engine is actually asked
 * to run.
 *
 * The three shapes are the whole extent of the decision for uniqueness claims:
 * an axis that is the writer's own kind (the uniques primary key is already the
 * complete fence, so the claim stays where it has always been, AFTER the row),
 * an axis spanning sibling kinds (the claim is the only fence for that axis, so
 * it must precede the row it gates), and both at once.
 */
describe("a create issues each claim on the side of the row its placement names", () => {
  const OWN_HANDLE_UNIQUE = {
    name: "placement_handle",
    fields: ["handle"],
    scope: "kind",
    collation: "binary",
  } as const;

  const SHARED_EMAIL_UNIQUE = {
    name: "placement_email",
    fields: ["email"],
    scope: "kindWithSubClasses",
    collation: "binary",
  } as const;

  /**
   * A second shared-scope constraint whose name sorts BEFORE the first one's,
   * declared after it: the canonical claim order is a sort, not the order the
   * schema happens to list.
   */
  const SHARED_ALIAS_UNIQUE = {
    name: "placement_alias",
    fields: ["alias"],
    scope: "kindWithSubClasses",
    collation: "binary",
  } as const;

  /** Only an own-kind claim: HEAD's order, and the row this design must not move. */
  const OwnOnly = defineNode("OwnOnly", {
    schema: z.object({ handle: z.string() }),
  });
  const SharedRoot = defineNode("SharedRoot", {
    schema: z.object({
      email: z.string(),
      alias: z.string(),
      handle: z.string(),
    }),
  });
  /** Only cross-kind claims — and two of them, in reverse sorted order. */
  const SharedLeaf = defineNode("SharedLeaf", {
    schema: z.object({
      email: z.string(),
      alias: z.string(),
      handle: z.string(),
    }),
  });
  /** One claim in each group: the shape that emits TWO claim statements. */
  const BothLeaf = defineNode("BothLeaf", {
    schema: z.object({
      email: z.string(),
      alias: z.string(),
      handle: z.string(),
    }),
  });

  const placementGraph = defineGraph({
    id: "constraint_claim_placement",
    nodes: {
      OwnOnly: { type: OwnOnly, unique: [OWN_HANDLE_UNIQUE] },
      SharedRoot: {
        type: SharedRoot,
        unique: [SHARED_EMAIL_UNIQUE, SHARED_ALIAS_UNIQUE],
      },
      SharedLeaf: {
        type: SharedLeaf,
        unique: [SHARED_EMAIL_UNIQUE, SHARED_ALIAS_UNIQUE],
      },
      BothLeaf: {
        type: BothLeaf,
        unique: [SHARED_EMAIL_UNIQUE, OWN_HANDLE_UNIQUE],
      },
    },
    edges: {},
    ontology: [
      subClassOf(SharedLeaf, SharedRoot),
      subClassOf(BothLeaf, SharedRoot),
    ],
  });

  it("keeps an own-kind claim AFTER the row, which is the order it ships in", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(placementGraph);

    reset();
    await store.nodes.OwnOnly.create({ handle: "own-1" });

    const claims = claimIndexes(statements);
    expect(claims).toHaveLength(1);
    expect(nodeInsertIndex(statements)).toBeLessThan(claims[0] ?? -1);
  });

  it("issues a cross-kind claim BEFORE the row it gates", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(placementGraph);

    reset();
    await store.nodes.SharedLeaf.create({
      email: "leaf@example.com",
      alias: "leaf",
      handle: "leaf-1",
    });

    // Both claims are cross-kind, so both precede the row — and they are issued
    // in canonical order (by constraint name, the axis being equal), not in the
    // order the schema lists them.
    const claims = claimIndexes(statements);
    expect(claims).toHaveLength(2);
    expect(claims[1] ?? -1).toBeLessThan(nodeInsertIndex(statements));
    expect(claims.map((index) => statements[index]?.params[2])).toEqual([
      "placement_alias",
      "placement_email",
    ]);
  });

  it("splits a kind owing both into two statements, one on each side of the row", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(placementGraph);

    reset();
    await store.nodes.BothLeaf.create({
      email: "both@example.com",
      alias: "both",
      handle: "both-1",
    });

    const claims = claimIndexes(statements);
    const insertIndex = nodeInsertIndex(statements);
    expect(claims).toHaveLength(2);
    expect(claims[0] ?? -1).toBeLessThan(insertIndex);
    expect(insertIndex).toBeLessThan(claims[1] ?? -1);

    expect(statements[claims[0] ?? 0]?.params[2]).toBe("placement_email");
    expect(statements[claims[1] ?? 0]?.params[2]).toBe("placement_handle");
  });

  it("sorts one batch statement's claims canonically, whatever order the rows arrive in", async () => {
    const { store, statements, reset } =
      await createRecordedPostgresStore(placementGraph);

    reset();
    await store.nodes.SharedLeaf.bulkCreate([
      { props: { email: "z@example.com", alias: "z", handle: "z-1" } },
      { props: { email: "a@example.com", alias: "a", handle: "a-1" } },
    ]);

    // One statement for the whole pre-insert group — which is what makes it
    // deadlock-free against itself — with its rows in `compareClaimTargets`
    // order: two writers taking these rows in opposite orders would otherwise
    // deadlock, and PostgreSQL resolves that by aborting one.
    const claims = claimIndexes(statements);
    expect(claims).toHaveLength(1);
    expect(claims[0] ?? -1).toBeLessThan(nodeInsertIndex(statements));

    const claimParams = statements[claims[0] ?? 0]?.params ?? [];
    const keys = claimParams.filter(
      (parameter): parameter is string =>
        typeof parameter === "string" &&
        (parameter === "a" ||
          parameter === "z" ||
          parameter.includes("@example.com")),
    );
    // Constraint name outranks key in the canonical order, so both `alias`
    // claims precede both `email` claims and each pair is ordered by key —
    // whatever order the rows arrived in.
    expect(keys).toEqual(["a", "z", "a@example.com", "z@example.com"]);
  });

  it("claims before the row on an UPDATE too, for a kind whose axis is its own", async () => {
    // The update half of the placement table, measured in the same place as the
    // create half. A transition is claim-first for EVERY scope, which is why
    // this kind's update is refused on a backend with no transactions while its
    // create is not — a fact that would otherwise rest on prose alone.
    const { store, statements, reset } =
      await createRecordedPostgresStore(placementGraph);
    const created = await store.nodes.OwnOnly.create({ handle: "update-1" });

    reset();
    await store.nodes.OwnOnly.update(created.id, { handle: "update-2" });

    const claims = claimIndexes(statements);
    const updateIndex = statements.findIndex((statement) =>
      /update "typegraph_nodes"/iu.test(statement.query),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0] ?? -1).toBeLessThan(updateIndex);
  });
});
